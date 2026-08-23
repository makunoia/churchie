import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import { checkInToCluster, registerForCluster } from "@/app/(dashboard)/events/cluster-actions"
import {
  getCheckinBreakoutChoices,
  getRegistrantBreakoutGroupName,
  pickCheckinBreakout,
} from "@/app/(dashboard)/events/breakout-actions"
import { clusterFormPrerequisites } from "@/lib/forms/form-prerequisites-server"
import { prerequisiteFor } from "@/lib/forms/form-prerequisites"

/**
 * The Breakout step on a Collab day's check-in kiosk (CCF-148).
 *
 * The step was wired end to end and still never appeared for anyone who used the
 * day's shared registration form. Their member event's `autoAssignBreakout`
 * placed them at submit, and the kiosk skips anyone already seated — so switching
 * the section on looked like it did nothing, and the only way to see the step was
 * to undo someone's arrival and put them through again.
 *
 * Registration now holds off while the kiosk is the one asking, which is the rule
 * `autoAssignBreakout` always encoded — auto-assign replaces a picker rather than
 * sitting beside it — applied now that the picker can be one surface further on.
 *
 *  - integration: register → check in → the step is offered, and the pick lands
 *  - regression:  auto-assign is withheld only while the kiosk asks; a person
 *                 already checked in is still offered the step; the door still
 *                 places people, having no later surface to defer to
 *  - edge case:   an explicit pick still seats and is never re-asked; a volunteer
 *                 and an unregistered cell yield no subject
 *  - unit:        the builder's auto-assign warning steps aside for the same rule
 *  - e2e:         skipped — no cluster fixtures exist in the Playwright suite,
 *                 and seeding a whole collab day there is a change of its own
 */

const DAY = new Date("2026-08-02T00:00:00Z")

beforeEach(async () => {
  await db.$executeRaw`TRUNCATE
    "OccurrenceAttendee", "EventOccurrence", "BreakoutGroupMember", "BreakoutGroup",
    "Volunteer", "CommitteeRole", "VolunteerCommittee",
    "EventRegistrant", "EventFormConfig", "EventModule", "EventMinistry",
    "EventClusterEvent", "EventCluster", "Event", "Guest", "Member", "Ministry",
    "LifeStage", "SmallGroupMemberRequest"
    RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

function payload(overrides: Record<string, unknown> = {}) {
  return { firstName: "Juan", lastName: "dela Cruz", mobileNumber: "0917 123 4567", ...overrides }
}

/**
 * A one-ministry Collab day with two cluster-owned tables.
 *
 * `autoAssign` is the member event's flag — the one that used to place everyone
 * at submit — and `asksAtCheckin` is the day's kiosk toggle.
 */
async function seedCollabDay(
  opts: { autoAssign?: boolean; asksAtCheckin?: boolean; picksAtRegistration?: boolean } = {}
) {
  const lifeStage = await db.lifeStage.create({ data: { name: "Singles", order: 1 } })
  const ministry = await db.ministry.create({
    data: { name: "Youth", lifeStageId: lifeStage.id, description: "" },
  })
  const event = await db.event.create({
    data: {
      name: "Youth Night",
      type: "OneTime",
      startDate: DAY,
      endDate: DAY,
      autoAssignBreakout: opts.autoAssign ?? true,
      ministries: { create: { ministryId: ministry.id } },
      modules: { create: { type: "Breakout" } },
    },
    select: { id: true },
  })
  const cluster = await db.eventCluster.create({
    data: {
      name: "Collab Sunday",
      kind: "Collab",
      date: DAY,
      isOpen: true,
      checkInIsOpen: true,
      walkInIsOpen: true,
      events: { create: { eventId: event.id, order: 0 } },
    },
    select: { id: true, publicToken: true },
  })
  await db.eventFormConfig.create({
    data: {
      clusterId: cluster.id,
      context: "Register",
      sectionBreakout: opts.picksAtRegistration ?? false,
    },
  })
  await db.eventFormConfig.create({
    data: {
      clusterId: cluster.id,
      context: "CheckIn",
      sectionBreakout: opts.asksAtCheckin ?? true,
    },
  })
  const tables = await Promise.all([
    db.breakoutGroup.create({ data: { clusterId: cluster.id, name: "Table 1" }, select: { id: true } }),
    db.breakoutGroup.create({ data: { clusterId: cluster.id, name: "Table 2" }, select: { id: true } }),
  ])
  return { cluster, event, tables }
}

/**
 * Put a checked-in facilitator on a table.
 *
 * A OneTime event has no session, so a volunteer's presence is `attendedAt` —
 * the same lane `facilitatorGate` reads.
 */
async function staffTable(eventId: string, breakoutGroupId: string) {
  const member = await db.member.create({
    data: {
      firstName: "Faci",
      lastName: "Litator",
      phone: "+63 917 777 8888",
      dateJoined: new Date(),
      language: [],
    },
    select: { id: true },
  })
  const committee = await db.volunteerCommittee.create({
    data: { name: "Facilitators", eventId },
    select: { id: true },
  })
  const role = await db.committeeRole.create({
    data: { name: "Table host", committeeId: committee.id },
    select: { id: true },
  })
  const volunteer = await db.volunteer.create({
    data: {
      memberId: member.id,
      eventId,
      committeeId: committee.id,
      preferredRoleId: role.id,
      status: "Confirmed",
      attendedAt: new Date(),
    },
    select: { id: true },
  })
  await db.breakoutGroup.update({
    where: { id: breakoutGroupId },
    data: { facilitatorId: volunteer.id },
  })
  return volunteer
}

/** Register through the day's shared form, exactly as the public page does. */
async function registerOnDay(
  cluster: { publicToken: string },
  eventId: string,
  opts: { pick?: string | null; walkIn?: boolean; person?: Record<string, unknown> } = {}
) {
  const result = await registerForCluster(
    cluster.publicToken,
    payload(opts.person),
    null,
    null,
    undefined,
    [eventId],
    opts.walkIn,
    undefined,
    null,
    opts.pick ?? null
  )
  expect(result.success).toBe(true)
  if (!result.success) throw new Error("registration failed")
  return result.data.results[0]
}

async function seatOf(registrantId: string) {
  const row = await db.breakoutGroupMember.findFirst({
    where: { registrantId },
    select: { breakoutGroup: { select: { name: true } } },
  })
  return row?.breakoutGroup.name ?? null
}

/** The person key the kiosk resolves — every registration here is an anonymous guest. */
async function guestKey() {
  const guest = await db.guest.findFirstOrThrow({ select: { id: true } })
  return `guest:${guest.id}`
}

/** One tap on the kiosk, plus the step it would show afterwards. */
async function tapCheckin(token: string, key: string) {
  const outcome = await checkInToCluster(token, key)
  expect(outcome.success).toBe(true)
  if (!outcome.success) throw new Error(outcome.error)
  const subject = outcome.data.breakoutSubject
  if (!subject) return { subject: null, choices: null }
  const choices = await getCheckinBreakoutChoices(
    subject.registrantId,
    subject.eventId,
    subject.occurrenceId,
    // The day's kiosk fills the day's set. `ClusterCheckinBoard` passes the same
    // literal; a member event keeps its own tables and fills them from its own
    // kiosk.
    "cluster"
  )
  expect(choices.success).toBe(true)
  return { subject, choices: choices.success ? choices.data : null }
}

// ─── Integration ─────────────────────────────────────────────────────────────

describe("integration — registering through the day's form, then checking in", () => {
  it("offers the step, and the pick seats the person at the day's table", async () => {
    const { cluster, event, tables } = await seedCollabDay()

    const outcome = await registerOnDay(cluster, event.id)
    // The whole fix: the member event auto-assigns, and registration held off.
    expect(outcome.breakoutGroup).toBeNull()
    expect(await seatOf(outcome.registrantId!)).toBeNull()

    const { subject, choices } = await tapCheckin(cluster.publicToken, await guestKey())
    expect(subject).not.toBeNull()
    expect(choices?.seatedGroupName).toBeNull()
    expect(choices?.options.map((o) => o.name).sort()).toEqual(["Table 1", "Table 2"])

    const picked = await pickCheckinBreakout(
      subject!.registrantId,
      subject!.eventId,
      subject!.occurrenceId,
      tables[1].id,
      "cluster"
    )
    expect(picked.success).toBe(true)
    expect(await seatOf(subject!.registrantId)).toBe("Table 2")
  })
})

// ─── Regression ──────────────────────────────────────────────────────────────

describe("regression — auto-assign waits only where someone else will ask", () => {
  it("still places at submit when the kiosk's step is switched off", async () => {
    const { cluster, event } = await seedCollabDay({ asksAtCheckin: false })

    const outcome = await registerOnDay(cluster, event.id)
    expect(outcome.breakoutGroup?.name).toBe("Table 1")
    expect(await seatOf(outcome.registrantId!)).toBe("Table 1")
  })

  it("still places a walk-in, who is checked in at the door and never reaches the kiosk", async () => {
    const { cluster, event, tables } = await seedCollabDay()
    // The door's auto-assign obeys the facilitator gate, so the table needs a
    // host in the room before it can place anyone into it.
    await staffTable(event.id, tables[0].id)

    const outcome = await registerOnDay(cluster, event.id, { walkIn: true })
    expect(outcome.breakoutGroup?.name).toBe("Table 1")
    expect(outcome.checkedIn).toBe(true)
  })

  it("leaves a day with no auto-assign exactly as it was", async () => {
    const { cluster, event } = await seedCollabDay({ autoAssign: false })

    const outcome = await registerOnDay(cluster, event.id)
    expect(await seatOf(outcome.registrantId!)).toBeNull()

    const { choices } = await tapCheckin(cluster.publicToken, await guestKey())
    expect(choices?.options).toHaveLength(2)
  })

  it("offers the step to someone already checked in, so a second tap is a retry", async () => {
    // The step used to have exactly one chance to appear: `breakoutSubject` was
    // read off the cells this tap recorded, so anyone already in the room — a
    // double tap, or someone a staffer checked in from the admin board — went
    // straight to the welcome screen with no way back to the question.
    const { cluster, event, tables } = await seedCollabDay()
    await registerOnDay(cluster, event.id)
    const key = await guestKey()

    const first = await tapCheckin(cluster.publicToken, key)
    expect(first.subject).not.toBeNull()

    const second = await tapCheckin(cluster.publicToken, key)
    expect(second.subject).toEqual(first.subject)
    expect(second.choices?.options).toHaveLength(2)

    // And the pick still lands — the attendance guard reads the record that
    // already stands rather than one written a moment ago.
    const picked = await pickCheckinBreakout(
      second.subject!.registrantId,
      second.subject!.eventId,
      second.subject!.occurrenceId,
      tables[0].id,
      "cluster"
    )
    expect(picked.success).toBe(true)
    expect(await seatOf(second.subject!.registrantId)).toBe("Table 1")
  })

  it("does not read a standing seat at the member event's own table as an answer about the day", async () => {
    // The sharpest form of the two-sets bug, and the reason the already-seated
    // guard is scoped to the set the surface fills rather than to both.
    //
    // `EventRegistrant` is one row per person per SERIES and `BreakoutGroupMember`
    // has no per-occurrence scoping, so a recurring event's regular holds a seat
    // at their standing table permanently. A guard spanning both sets found that
    // seat, called them placed and skipped the day's step — and because
    // `deferBreakoutToCheckin` had already held registration off *precisely*
    // because the kiosk was the one asking, they finished the day seated nowhere
    // and were shown the name of a table that wasn't running.
    const { cluster, event } = await seedCollabDay({ autoAssign: false })
    const outcome = await registerOnDay(cluster, event.id)

    const standing = await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Standing Table" },
      select: { id: true },
    })
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: standing.id, registrantId: outcome.registrantId! },
    })

    const { choices } = await tapCheckin(cluster.publicToken, await guestKey())
    expect(choices?.seatedGroupName).toBeNull()
    expect(choices?.options.map((o) => o.name).sort()).toEqual(["Table 1", "Table 2"])
  })

  it("seats the day's table beside the standing one rather than instead of it", async () => {
    // Holding a seat in each set is the ordinary outcome, not a fault: the
    // standing table is the event's and stays the event's, the day's table is
    // today's. This is what the write path has always allowed — the guard now
    // agrees with it.
    const { cluster, event, tables } = await seedCollabDay({ autoAssign: false })
    const outcome = await registerOnDay(cluster, event.id)
    const standing = await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Standing Table" },
      select: { id: true },
    })
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: standing.id, registrantId: outcome.registrantId! },
    })

    const { subject } = await tapCheckin(cluster.publicToken, await guestKey())
    const picked = await pickCheckinBreakout(
      subject!.registrantId,
      subject!.eventId,
      subject!.occurrenceId,
      tables[0].id,
      "cluster"
    )
    expect(picked.success).toBe(true)

    const seats = await db.breakoutGroupMember.findMany({
      where: { registrantId: subject!.registrantId },
      select: { breakoutGroupId: true },
    })
    expect(seats.map((s) => s.breakoutGroupId).sort()).toEqual(
      [standing.id, tables[0].id].sort()
    )
  })

  it("names the day's table on the welcome screen, never the standing one", async () => {
    // A person holding a seat in each set is ordinary (see above), so a single
    // `findFirst` over the union named whichever row Postgres reached first.
    // This is a check-in confirmation: the only useful answer is the table being
    // run in the room they are standing in.
    const { cluster, event, tables } = await seedCollabDay({ autoAssign: false })
    const outcome = await registerOnDay(cluster, event.id)
    const standing = await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Standing Table" },
      select: { id: true },
    })
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: standing.id, registrantId: outcome.registrantId! },
    })
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: tables[0].id, registrantId: outcome.registrantId! },
    })

    expect(await getRegistrantBreakoutGroupName(outcome.registrantId!, event.id)).toEqual({
      name: "Table 1",
    })
  })
})

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("edge — who is never asked", () => {
  it("keeps a table chosen on the registration form, and doesn't re-ask", async () => {
    // A pick is a decision already taken. Only automatic placement waits.
    const { cluster, event, tables } = await seedCollabDay({ picksAtRegistration: true })

    const outcome = await registerOnDay(cluster, event.id, { pick: tables[1].id })
    expect(outcome.breakoutGroup?.name).toBe("Table 2")

    const { choices } = await tapCheckin(cluster.publicToken, await guestKey())
    expect(choices?.seatedGroupName).toBe("Table 2")
    expect(choices?.options).toHaveLength(0)
  })

  it("yields no subject for someone the day knows only as a volunteer", async () => {
    const { cluster, event } = await seedCollabDay()
    const member = await db.member.create({
      data: {
        firstName: "Ana",
        lastName: "Reyes",
        phone: "+63 917 555 6666",
        dateJoined: new Date(),
        language: [],
      },
      select: { id: true },
    })
    const committee = await db.volunteerCommittee.create({
      data: { name: "Ushers", eventId: event.id },
      select: { id: true },
    })
    const role = await db.committeeRole.create({
      data: { name: "Greeter", committeeId: committee.id },
      select: { id: true },
    })
    await db.volunteer.create({
      data: {
        memberId: member.id,
        eventId: event.id,
        committeeId: committee.id,
        preferredRoleId: role.id,
        status: "Confirmed",
        signUpClusterId: cluster.id,
      },
    })

    const { subject } = await tapCheckin(cluster.publicToken, `member:${member.id}`)
    expect(subject).toBeNull()
  })
})

// ─── Unit ────────────────────────────────────────────────────────────────────

describe("unit — what the day's form builder warns about", () => {
  it("withholds the auto-assign warning while the kiosk is the one asking", async () => {
    const { cluster } = await seedCollabDay()
    const prerequisites = await clusterFormPrerequisites(cluster.id, "Collab")

    expect(prerequisiteFor(prerequisites, "sectionBreakout", "Register", true)).toBeNull()
  })

  it("still warns when nobody downstream will ask", async () => {
    const { cluster } = await seedCollabDay({ asksAtCheckin: false })
    const prerequisites = await clusterFormPrerequisites(cluster.id, "Collab")

    expect(prerequisiteFor(prerequisites, "sectionBreakout", "Register", true)).toContain(
      "on submit"
    )
  })

  it("names the door alone for unstaffed tables — the kiosk offers them ungated", async () => {
    const { cluster } = await seedCollabDay({ autoAssign: false, asksAtCheckin: false })
    const prerequisites = await clusterFormPrerequisites(cluster.id, "Collab")

    expect(prerequisiteFor(prerequisites, "sectionBreakout", "WalkIn", true)).toContain(
      "facilitator"
    )
    expect(prerequisiteFor(prerequisites, "sectionBreakout", "CheckIn", true)).toBeNull()
  })
})
