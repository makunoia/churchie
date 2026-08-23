import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import {
  checkInToCluster,
  lookupClusterCheckin,
  removeClusterCheckin,
  searchClusterCheckinByName,
} from "@/app/(dashboard)/events/cluster-actions"
import { getClusterDayRows, getClusterRegistrantRows } from "@/lib/clusters/aggregate"
import { buildClusterRoster } from "@/lib/clusters/roster"

/**
 * The cluster day's check-in kiosk.
 *
 * A cluster is one day made of independent events. Until now a person who
 * pre-registered for three of them had to be found three times, on three
 * separate per-event kiosks. This finds them once and records the whole day.
 *
 *  - integration: lookup across the day, one tap writing OneTime `attendedAt`
 *                 AND the linked session's OccurrenceAttendee, the admin board
 *                 agreeing afterwards
 *  - regression:  the kiosk never bypasses an event that closed its own
 *                 check-in, and never creates a registration
 *  - security:    a person key is re-resolved from the cluster's own events, so
 *                 a registrant of an outside event cannot be stamped
 *  - edge case:   idempotent re-tap, closed kiosk, unlinked recurring event,
 *                 ambiguous same-contact candidates, volunteers, a day with no
 *                 events
 *  - unit:        the collapse itself in tests/unit/cluster-checkin-person
 *  - e2e:         skipped — the existing check-in spec is a 404 smoke test with
 *                 no cluster fixtures; adding Playwright cluster seeding is a
 *                 change of its own
 */

const DAY = new Date("2026-08-02T00:00:00Z")
const OTHER_DAY = new Date("2026-07-26T00:00:00Z")
const PHONE = "+63 917 123 4567"

beforeEach(async () => {
  await db.$executeRaw`TRUNCATE
    "OccurrenceAttendee", "EventOccurrence", "Volunteer", "CommitteeRole",
    "VolunteerCommittee", "EventRegistrant", "FormConfig", "EventFormConfig",
    "EventClusterEvent", "EventCluster", "Event", "Guest", "Member"
    RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

async function seedCluster(overrides: { date?: Date | null; checkInIsOpen?: boolean } = {}) {
  return db.eventCluster.create({
    data: {
      name: "Sunday, Aug 2",
      date: overrides.date === undefined ? DAY : overrides.date,
      isOpen: true,
      checkInIsOpen: overrides.checkInIsOpen ?? true,
    },
  })
}

async function seedOneTime(name: string, date = DAY) {
  return db.event.create({
    data: { name, type: "OneTime", startDate: date, endDate: date },
  })
}

async function seedRecurring(name = "Sunday Service") {
  return db.event.create({
    data: {
      name,
      type: "Recurring",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-12-31T00:00:00Z"),
    },
  })
}

/** Sessions are seeded open so reachability doesn't depend on the wall clock. */
async function seedSession(eventId: string, date: Date, isOpen = true) {
  return db.eventOccurrence.create({ data: { eventId, date, isOpen } })
}

async function link(
  clusterId: string,
  eventId: string,
  occurrenceId: string | null = null,
  order = 0
) {
  return db.eventClusterEvent.create({
    data: { clusterId, eventId, occurrenceId, order },
  })
}

async function seedMember(firstName = "Juan", phone: string | null = PHONE) {
  return db.member.create({
    data: {
      firstName,
      lastName: "Dela Cruz",
      phone,
      dateJoined: new Date(),
      language: [],
    },
  })
}

async function seedGuest(firstName = "Ana", phone: string | null = PHONE) {
  return db.guest.create({
    data: { firstName, lastName: "Bautista", phone, language: [] },
  })
}

async function register(eventId: string, who: { memberId?: string; guestId?: string }) {
  return db.eventRegistrant.create({ data: { eventId, ...who } })
}

async function seedVolunteer(eventId: string, memberId: string) {
  const committee = await db.volunteerCommittee.create({
    data: { name: "Ushers", eventId },
  })
  const role = await db.committeeRole.create({
    data: { name: "Greeter", committeeId: committee.id },
  })
  return db.volunteer.create({
    data: {
      memberId,
      eventId,
      committeeId: committee.id,
      preferredRoleId: role.id,
      status: "Confirmed",
    },
  })
}

/** Close an event's own public check-in form. A missing row means open. */
async function closeEventCheckin(eventId: string) {
  await db.formConfig.create({
    data: { scopeKey: `${eventId}:EventCheckIn`, key: "EventCheckIn", eventId, isOpen: false },
  })
}

/** The common shape: a OneTime event plus a Recurring one linked to today's session. */
async function seedDay() {
  const cluster = await seedCluster()
  const oneTime = await seedOneTime("Youth Night")
  const recurring = await seedRecurring()
  const session = await seedSession(recurring.id, DAY)
  const stale = await seedSession(recurring.id, OTHER_DAY)
  await link(cluster.id, oneTime.id, null, 0)
  await link(cluster.id, recurring.id, session.id, 1)
  return { cluster, oneTime, recurring, session, stale }
}

describe("finding a person across the day", () => {
  it("returns one person carrying a cell per cluster event", async () => {
    const { cluster, oneTime, recurring } = await seedDay()
    const member = await seedMember()
    await register(oneTime.id, { memberId: member.id })
    await register(recurring.id, { memberId: member.id })

    const result = await lookupClusterCheckin(cluster.publicToken, PHONE)

    expect(result.success).toBe(true)
    if (!result.success || result.data?.matchType !== "one") throw new Error("expected one match")
    const person = result.data.person
    expect(person.name).toBe("Juan Dela Cruz")
    expect(person.events).toHaveLength(2)
    expect(person.events.every((c) => c.subject !== null)).toBe(true)
  })

  it("shows an event the person didn't register for as an empty cell", async () => {
    const { cluster, oneTime } = await seedDay()
    const member = await seedMember()
    await register(oneTime.id, { memberId: member.id })

    const result = await lookupClusterCheckin(cluster.publicToken, PHONE)
    if (!result.success || result.data?.matchType !== "one") throw new Error("expected one match")

    const cells = result.data.person.events
    expect(cells.filter((c) => c.subject !== null)).toHaveLength(1)
    expect(cells.filter((c) => c.subject === null)).toHaveLength(1)
  })

  it("finds the same person by name", async () => {
    const { cluster, oneTime, recurring } = await seedDay()
    const member = await seedMember()
    await register(oneTime.id, { memberId: member.id })
    await register(recurring.id, { memberId: member.id })

    const result = await searchClusterCheckinByName(cluster.publicToken, "juan dela")

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toHaveLength(1)
    expect(result.data[0].events).toHaveLength(2)
  })

  it("returns null when nobody matches", async () => {
    const { cluster } = await seedDay()
    const result = await lookupClusterCheckin(cluster.publicToken, "+63 999 999 9999")
    expect(result).toEqual({ success: true, data: null })
  })

  it("reports ambiguity when two people share a contact", async () => {
    const { cluster, oneTime } = await seedDay()
    const one = await seedMember("Juan")
    const two = await seedGuest("Ana")
    await register(oneTime.id, { memberId: one.id })
    await register(oneTime.id, { guestId: two.id })

    const result = await lookupClusterCheckin(cluster.publicToken, PHONE)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data?.matchType).toBe("ambiguous")
    if (result.data?.matchType !== "ambiguous") return
    expect(result.data.candidates).toHaveLength(2)
  })
})

describe("recording the day in one tap", () => {
  it("stamps attendedAt on the OneTime event and the linked session on the recurring one", async () => {
    const { cluster, oneTime, recurring, session, stale } = await seedDay()
    const member = await seedMember()
    const oneTimeReg = await register(oneTime.id, { memberId: member.id })
    const recurringReg = await register(recurring.id, { memberId: member.id })

    const result = await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.recorded).toHaveLength(2)

    const stamped = await db.eventRegistrant.findUnique({ where: { id: oneTimeReg.id } })
    expect(stamped?.attendedAt).not.toBeNull()

    const attendance = await db.occurrenceAttendee.findMany({
      where: { registrantId: recurringReg.id },
      select: { occurrenceId: true },
    })
    expect(attendance).toHaveLength(1)
    expect(attendance[0].occurrenceId).toBe(session.id)
    // Emphatically not the series' other session.
    expect(attendance[0].occurrenceId).not.toBe(stale.id)
  })

  it("moves the admin board's checked-in figure", async () => {
    const { cluster, oneTime, recurring, session } = await seedDay()
    const member = await seedMember()
    await register(oneTime.id, { memberId: member.id })
    await register(recurring.id, { memberId: member.id })

    await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    const events = [
      { id: oneTime.id, linkedOccurrenceId: null },
      { id: recurring.id, linkedOccurrenceId: session.id },
    ]
    const rows = await getClusterRegistrantRows(events, { clusterId: cluster.id, date: DAY, kind: "Parallel" })
    const roster = buildClusterRoster(
      [
        { id: oneTime.id, name: oneTime.name, type: "OneTime" as const },
        { id: recurring.id, name: recurring.name, type: "Recurring" as const },
      ],
      rows
    )

    expect(roster.rows).toHaveLength(1)
    expect(Object.values(roster.rows[0].perEvent).every((c) => c?.checkedIn)).toBe(true)
  })

  it("checks a volunteer in as a volunteer, not a registrant", async () => {
    const { cluster, oneTime } = await seedDay()
    const member = await seedMember()
    const volunteer = await seedVolunteer(oneTime.id, member.id)

    const result = await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    expect(result.success).toBe(true)
    const stamped = await db.volunteer.findUnique({ where: { id: volunteer.id } })
    expect(stamped?.attendedAt).not.toBeNull()
  })

  it("is idempotent — a second tap changes nothing", async () => {
    const { cluster, oneTime, recurring } = await seedDay()
    const member = await seedMember()
    const oneTimeReg = await register(oneTime.id, { memberId: member.id })
    const recurringReg = await register(recurring.id, { memberId: member.id })

    await checkInToCluster(cluster.publicToken, `member:${member.id}`)
    const first = await db.eventRegistrant.findUnique({ where: { id: oneTimeReg.id } })

    const second = await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    expect(second.success).toBe(true)
    if (!second.success) return
    // Nothing left to record, and both cells report why.
    expect(second.data.recorded).toEqual([])
    expect(second.data.skipped.map((s) => s.reason)).toEqual(["already", "already"])

    const after = await db.eventRegistrant.findUnique({ where: { id: oneTimeReg.id } })
    expect(after?.attendedAt?.toISOString()).toBe(first?.attendedAt?.toISOString())
    const attendance = await db.occurrenceAttendee.count({
      where: { registrantId: recurringReg.id },
    })
    expect(attendance).toBe(1)
  })

  it("never creates a registration for an event the person skipped", async () => {
    const { cluster, oneTime, recurring } = await seedDay()
    const member = await seedMember()
    await register(oneTime.id, { memberId: member.id })

    const result = await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.skipped).toEqual([
      { eventId: recurring.id, eventName: recurring.name, reason: "notRegistered" },
    ])
    expect(await db.eventRegistrant.count({ where: { eventId: recurring.id } })).toBe(0)
  })
})

describe("what the kiosk refuses to do", () => {
  it("skips an event that closed its own check-in form", async () => {
    // The day's kiosk must not become a bypass for a door someone shut on purpose.
    const { cluster, oneTime, recurring } = await seedDay()
    await closeEventCheckin(oneTime.id)
    const member = await seedMember()
    const oneTimeReg = await register(oneTime.id, { memberId: member.id })
    await register(recurring.id, { memberId: member.id })

    const result = await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.recorded.map((r) => r.eventId)).toEqual([recurring.id])
    expect(result.data.skipped).toEqual([
      { eventId: oneTime.id, eventName: oneTime.name, reason: "formClosed" },
    ])
    const untouched = await db.eventRegistrant.findUnique({ where: { id: oneTimeReg.id } })
    expect(untouched?.attendedAt).toBeNull()
  })

  it("skips a recurring event whose link names no session for the day", async () => {
    const cluster = await seedCluster()
    const recurring = await seedRecurring()
    await seedSession(recurring.id, OTHER_DAY)
    await link(cluster.id, recurring.id, null)
    const member = await seedMember()
    const reg = await register(recurring.id, { memberId: member.id })

    const result = await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.recorded).toEqual([])
    expect(result.data.skipped[0].reason).toBe("noSession")
    expect(await db.occurrenceAttendee.count({ where: { registrantId: reg.id } })).toBe(0)
  })

  it("refuses everything while the kiosk switch is off", async () => {
    const { cluster, oneTime } = await seedDay()
    await db.eventCluster.update({
      where: { id: cluster.id },
      data: { checkInIsOpen: false },
    })
    const member = await seedMember()
    const reg = await register(oneTime.id, { memberId: member.id })

    const lookup = await lookupClusterCheckin(cluster.publicToken, PHONE)
    const checkin = await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    expect(lookup.success).toBe(false)
    expect(checkin.success).toBe(false)
    const untouched = await db.eventRegistrant.findUnique({ where: { id: reg.id } })
    expect(untouched?.attendedAt).toBeNull()
  })

  // The action takes a person key and nothing else precisely so this can't work:
  // the rows are re-resolved from the cluster's own events every time.
  it("cannot stamp a registrant of an event outside the cluster", async () => {
    const { cluster } = await seedDay()
    const outside = await seedOneTime("Someone Else's Event")
    const member = await seedMember()
    const reg = await register(outside.id, { memberId: member.id })

    const result = await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    expect(result.success).toBe(false)
    const untouched = await db.eventRegistrant.findUnique({ where: { id: reg.id } })
    expect(untouched?.attendedAt).toBeNull()
  })

  it("refuses an unknown token", async () => {
    const result = await checkInToCluster("not-a-token", "member:nobody")
    expect(result).toEqual({ success: false, error: "Event day not found." })
  })

  it("refuses a day with no events yet", async () => {
    const cluster = await seedCluster()
    const result = await checkInToCluster(cluster.publicToken, "member:nobody")
    expect(result.success).toBe(false)
    expect(await lookupClusterCheckin(cluster.publicToken, PHONE)).toEqual({
      success: true,
      data: null,
    })
  })
})

/**
 * The admin board renders the way the session detail screen does now — stat
 * tiles over a filtered list — and two of its columns are facts the day rows
 * never carried: the arrival's own time, and the gender behind the tile's
 * split bar. Both are read from the linked Member or Guest, on the same
 * day-scoped attendance the `checkedIn` flag beside them already used.
 */
describe("what the day's rows carry for the admin board", () => {
  it("reads gender from the member or the guest behind each row", async () => {
    const { cluster, oneTime, recurring, session } = await seedDay()
    const member = await db.member.create({
      data: {
        firstName: "Juan",
        lastName: "Dela Cruz",
        phone: PHONE,
        gender: "Male",
        dateJoined: new Date(),
        language: [],
      },
    })
    const guest = await db.guest.create({
      data: { firstName: "Ana", lastName: "Bautista", gender: "Female", language: [] },
    })
    await register(oneTime.id, { memberId: member.id })
    await register(oneTime.id, { guestId: guest.id })

    const rows = await getClusterDayRows(
      [
        { id: oneTime.id, linkedOccurrenceId: null },
        { id: recurring.id, linkedOccurrenceId: session.id },
      ],
      { clusterId: cluster.id, date: DAY, kind: "Parallel" }
    )

    expect(rows.find((r) => r.memberId === member.id)?.gender).toBe("Male")
    expect(rows.find((r) => r.guestId === guest.id)?.gender).toBe("Female")
  })

  it("times the arrival on both kinds of event, and leaves it null before one", async () => {
    const { cluster, oneTime, recurring, session } = await seedDay()
    const member = await seedMember()
    const absentee = await seedMember("Pedro", "+63 917 000 1111")
    await register(oneTime.id, { memberId: member.id })
    await register(recurring.id, { memberId: member.id })
    await register(oneTime.id, { memberId: absentee.id })

    const events = [
      { id: oneTime.id, linkedOccurrenceId: null },
      { id: recurring.id, linkedOccurrenceId: session.id },
    ]
    const before = await getClusterDayRows(events, {
      clusterId: cluster.id,
      date: DAY,
      kind: "Parallel",
    })
    expect(before.every((r) => r.checkedInAt === null)).toBe(true)

    await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    const after = await getClusterDayRows(events, {
      clusterId: cluster.id,
      date: DAY,
      kind: "Parallel",
    })
    // OneTime records on `attendedAt`, a session through OccurrenceAttendee —
    // the board reads one column either way.
    for (const row of after.filter((r) => r.memberId === member.id)) {
      expect(row.checkedIn).toBe(true)
      expect(row.checkedInAt).toBeInstanceOf(Date)
    }
    // Nobody's absence borrows someone else's timestamp.
    const missing = after.find((r) => r.memberId === absentee.id)
    expect(missing?.checkedIn).toBe(false)
    expect(missing?.checkedInAt).toBeNull()
  })

  it("times a volunteer's arrival the same way", async () => {
    const { cluster, oneTime, recurring, session } = await seedDay()
    const member = await seedMember()
    await seedVolunteer(oneTime.id, member.id)

    await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    const rows = await getClusterDayRows(
      [
        { id: oneTime.id, linkedOccurrenceId: null },
        { id: recurring.id, linkedOccurrenceId: session.id },
      ],
      { clusterId: cluster.id, date: DAY, kind: "Parallel" }
    )
    const serving = rows.find((r) => r.kind === "Volunteer")
    expect(serving?.checkedIn).toBe(true)
    expect(serving?.checkedInAt).toBeInstanceOf(Date)
  })
})

/**
 * Undoing an arrival from the admin board — the day's answer to the session
 * screen's "Remove from session". Attendance only: the registration and the
 * volunteer row are untouched, so the person is still expected on the day.
 */
describe("undoing a check-in from the admin board", () => {
  it("clears both lanes at once — attendedAt and the session's attendance row", async () => {
    const { cluster, oneTime, recurring, session } = await seedDay()
    const member = await seedMember()
    const oneTimeReg = await register(oneTime.id, { memberId: member.id })
    const recurringReg = await register(recurring.id, { memberId: member.id })
    await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    const result = await removeClusterCheckin(cluster.id, `member:${member.id}`)

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)
    expect(result.data.removed.map((r) => r.eventId).sort()).toEqual(
      [oneTime.id, recurring.id].sort()
    )
    // The OneTime lane.
    const cleared = await db.eventRegistrant.findUnique({ where: { id: oneTimeReg.id } })
    expect(cleared?.attendedAt).toBeNull()
    // The session lane.
    const attendance = await db.occurrenceAttendee.findMany({
      where: { occurrenceId: session.id, registrantId: recurringReg.id },
    })
    expect(attendance).toHaveLength(0)
  })

  it("leaves the registrations themselves standing", async () => {
    const { cluster, oneTime, recurring } = await seedDay()
    const member = await seedMember()
    await register(oneTime.id, { memberId: member.id })
    await register(recurring.id, { memberId: member.id })
    await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    await removeClusterCheckin(cluster.id, `member:${member.id}`)

    // Still on the day, simply not yet arrived — the whole point of the control.
    expect(await db.eventRegistrant.count({ where: { memberId: member.id } })).toBe(2)
  })

  it("undoes a volunteer's arrival the same way", async () => {
    const { cluster, oneTime } = await seedDay()
    const member = await seedMember()
    const volunteer = await seedVolunteer(oneTime.id, member.id)
    await checkInToCluster(cluster.publicToken, `member:${member.id}`)
    expect((await db.volunteer.findUnique({ where: { id: volunteer.id } }))?.attendedAt)
      .not.toBeNull()

    const result = await removeClusterCheckin(cluster.id, `member:${member.id}`)

    expect(result.success).toBe(true)
    const after = await db.volunteer.findUnique({ where: { id: volunteer.id } })
    expect(after?.attendedAt).toBeNull()
    // The shift itself survives — they are still rostered to serve.
    expect(after).not.toBeNull()
  })

  // The board reads the same rows afterwards, so the two can't disagree about
  // who is in the room.
  it("puts the person back on the board as not yet arrived", async () => {
    const { cluster, oneTime, recurring, session } = await seedDay()
    const member = await seedMember()
    await register(oneTime.id, { memberId: member.id })
    await register(recurring.id, { memberId: member.id })
    await checkInToCluster(cluster.publicToken, `member:${member.id}`)
    await removeClusterCheckin(cluster.id, `member:${member.id}`)

    const rows = await getClusterDayRows(
      [
        { id: oneTime.id, linkedOccurrenceId: null },
        { id: recurring.id, linkedOccurrenceId: session.id },
      ],
      { clusterId: cluster.id, date: DAY, kind: "Parallel" }
    )
    expect(rows.every((r) => r.checkedIn === false)).toBe(true)
    expect(rows.every((r) => r.checkedInAt === null)).toBe(true)
  })

  /**
   * Undoing an arrival can also take the person off the board, and that is the
   * day-scoping rule rather than a side effect of this action: `hasDayEvidence`
   * counts the day's stamp, the day's check-in, or a sign-up made on the day,
   * and for a series registrant the arrival was all three. Take it away and the
   * day has no evidence they were ever here — which is exactly what "not
   * arrived" now means for them.
   *
   * A Parallel day's OneTime registration is unaffected: there the sign-up names
   * the event, and the event is the day.
   */
  it("drops a series registrant off the day, and keeps the OneTime one on it", async () => {
    const { cluster, oneTime, recurring, session } = await seedDay()
    const member = await seedMember()
    await register(oneTime.id, { memberId: member.id })
    await register(recurring.id, { memberId: member.id })
    await checkInToCluster(cluster.publicToken, `member:${member.id}`)
    await removeClusterCheckin(cluster.id, `member:${member.id}`)

    const rows = await getClusterDayRows(
      [
        { id: oneTime.id, linkedOccurrenceId: null },
        { id: recurring.id, linkedOccurrenceId: session.id },
      ],
      { clusterId: cluster.id, date: DAY, kind: "Parallel" }
    )
    expect(rows.find((r) => r.eventId === oneTime.id)?.onClusterDay).toBe(true)
    expect(rows.find((r) => r.eventId === recurring.id)?.onClusterDay).toBe(false)
    // The registration itself is untouched either way — this is a read-side
    // scoping rule, not a delete.
    expect(await db.eventRegistrant.count({ where: { memberId: member.id } })).toBe(2)
  })

  it("is idempotent — a second undo changes nothing and still succeeds", async () => {
    const { cluster, oneTime } = await seedDay()
    const member = await seedMember()
    await register(oneTime.id, { memberId: member.id })
    await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    await removeClusterCheckin(cluster.id, `member:${member.id}`)
    const second = await removeClusterCheckin(cluster.id, `member:${member.id}`)

    expect(second.success).toBe(true)
    if (!second.success) throw new Error(second.error)
    // Nothing left to undo, and the action says so rather than claiming a write.
    expect(second.data.removed).toEqual([])
    expect(second.data.skipped.map((s) => s.reason)).toContain("notIn")
  })

  // Undo, then check in again — the kiosk is the way back, so the cycle has to
  // close or a mis-tap is permanent.
  it("lets the kiosk check the same person in again afterwards", async () => {
    const { cluster, oneTime } = await seedDay()
    const member = await seedMember()
    const reg = await register(oneTime.id, { memberId: member.id })
    await checkInToCluster(cluster.publicToken, `member:${member.id}`)
    await removeClusterCheckin(cluster.id, `member:${member.id}`)

    await checkInToCluster(cluster.publicToken, `member:${member.id}`)

    const again = await db.eventRegistrant.findUnique({ where: { id: reg.id } })
    expect(again?.attendedAt).not.toBeNull()
  })

  it("touches nobody else's arrival", async () => {
    const { cluster, oneTime } = await seedDay()
    const member = await seedMember()
    const other = await seedMember("Pedro", "+63 917 000 1111")
    await register(oneTime.id, { memberId: member.id })
    const otherReg = await register(oneTime.id, { memberId: other.id })
    await checkInToCluster(cluster.publicToken, `member:${member.id}`)
    await checkInToCluster(cluster.publicToken, `member:${other.id}`)

    await removeClusterCheckin(cluster.id, `member:${member.id}`)

    expect(
      (await db.eventRegistrant.findUnique({ where: { id: otherReg.id } }))?.attendedAt
    ).not.toBeNull()
  })

  // The security shape `checkInToCluster` set: the caller supplies a person key
  // and nothing else, so a row outside this cluster resolves to nobody.
  it("refuses a person key belonging to an event outside the day", async () => {
    const { cluster } = await seedDay()
    const outside = await seedOneTime("Someone else's event")
    const stranger = await seedMember("Rita", "+63 917 222 3333")
    const strangerReg = await register(outside.id, { memberId: stranger.id })
    await db.eventRegistrant.update({
      where: { id: strangerReg.id },
      data: { attendedAt: new Date() },
    })

    const result = await removeClusterCheckin(cluster.id, `member:${stranger.id}`)

    expect(result.success).toBe(false)
    expect(
      (await db.eventRegistrant.findUnique({ where: { id: strangerReg.id } }))?.attendedAt
    ).not.toBeNull()
  })

  it("refuses an empty person key and an unknown cluster", async () => {
    const { cluster } = await seedDay()
    expect((await removeClusterCheckin(cluster.id, "   ")).success).toBe(false)
    expect((await removeClusterCheckin("no-such-cluster", "member:x")).success).toBe(false)
  })

  // A standing series registrant with no evidence for today is not on the
  // board, so the board has nothing to undo for them.
  it("refuses someone who isn't on the day", async () => {
    const { cluster, recurring } = await seedDay()
    const member = await seedMember()
    // Registered on the series, never checked in for this day.
    await register(recurring.id, { memberId: member.id })

    const result = await removeClusterCheckin(cluster.id, `member:${member.id}`)

    expect(result.success).toBe(false)
  })

  // A guest is found by the same key shape a member is.
  it("undoes a guest's arrival", async () => {
    const { cluster, oneTime } = await seedDay()
    const guest = await seedGuest()
    const reg = await register(oneTime.id, { guestId: guest.id })
    await checkInToCluster(cluster.publicToken, `guest:${guest.id}`)

    const result = await removeClusterCheckin(cluster.id, `guest:${guest.id}`)

    expect(result.success).toBe(true)
    expect(
      (await db.eventRegistrant.findUnique({ where: { id: reg.id } }))?.attendedAt
    ).toBeNull()
  })

  // The undo is per person across the day, so a Parallel registrant who arrived
  // for one of two events has the one arrival cleared and the other reported as
  // nothing to do — which is what the confirm dialog names.
  it("clears only the events the person actually arrived on", async () => {
    const { cluster, oneTime, recurring, session } = await seedDay()
    const member = await seedMember()
    const oneTimeReg = await register(oneTime.id, { memberId: member.id })
    const recurringReg = await register(recurring.id, { memberId: member.id })
    // Arrived at the session only.
    await db.occurrenceAttendee.create({
      data: { occurrenceId: session.id, registrantId: recurringReg.id },
    })

    const result = await removeClusterCheckin(cluster.id, `member:${member.id}`)

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)
    expect(result.data.removed.map((r) => r.eventId)).toEqual([recurring.id])
    expect(result.data.skipped.map((s) => s.eventId)).toEqual([oneTime.id])
    expect(
      (await db.eventRegistrant.findUnique({ where: { id: oneTimeReg.id } }))?.attendedAt
    ).toBeNull()
  })

  // A stale session on another date is not this day's, and undoing today must
  // not reach back into it.
  it("leaves another day's attendance alone", async () => {
    const { cluster, recurring, session, stale } = await seedDay()
    const member = await seedMember()
    const reg = await register(recurring.id, { memberId: member.id })
    await db.occurrenceAttendee.createMany({
      data: [
        { occurrenceId: session.id, registrantId: reg.id },
        { occurrenceId: stale.id, registrantId: reg.id },
      ],
    })

    await removeClusterCheckin(cluster.id, `member:${member.id}`)

    expect(
      await db.occurrenceAttendee.count({ where: { occurrenceId: session.id } })
    ).toBe(0)
    expect(
      await db.occurrenceAttendee.count({ where: { occurrenceId: stale.id } })
    ).toBe(1)
  })
})
