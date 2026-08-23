import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { db } from "@/lib/db"
import { searchCheckinByName, lookupCheckinRegistrant } from "@/app/(dashboard)/events/actions"

// Check-in name search used to repeat the same person: once per duplicate
// EventRegistrant row, and again when they were also an event volunteer. It also
// only ever matched the per-event registration nickname, never the nickname on
// the Member/Guest profile. These tests pin both fixes.

beforeEach(async () => {
  await db.$executeRaw`TRUNCATE "OccurrenceAttendee", "EventRegistrant", "EventOccurrence", "Volunteer", "CommitteeRole", "VolunteerCommittee", "Event", "Guest", "Member", "LifeStage" RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

async function seedEvent() {
  return db.event.create({
    data: { name: "Search Event", type: "OneTime", startDate: new Date(), endDate: new Date() },
  })
}

async function seedMember(data: {
  firstName: string
  lastName: string
  nickname?: string | null
  phone?: string | null
}) {
  return db.member.create({
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      nickname: data.nickname ?? null,
      phone: data.phone ?? null,
      dateJoined: new Date(),
      language: [],
    },
  })
}

async function seedGuest(data: {
  firstName: string
  lastName: string
  nickname?: string | null
  phone?: string | null
}) {
  return db.guest.create({
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      nickname: data.nickname ?? null,
      phone: data.phone ?? null,
      language: [],
    },
  })
}

async function seedVolunteer(eventId: string, memberId: string) {
  const committee = await db.volunteerCommittee.create({ data: { name: "Logistics", eventId } })
  const role = await db.committeeRole.create({ data: { name: "Usher", committeeId: committee.id } })
  return db.volunteer.create({
    data: { memberId, eventId, committeeId: committee.id, preferredRoleId: role.id },
  })
}

function unwrap<T>(result: { success: true; data: T } | { success: false; error: string }): T {
  if (!result.success) throw new Error(result.error)
  return result.data
}

// ── De-duplication ────────────────────────────────────────────────────────────

describe("searchCheckinByName – de-duplication", () => {
  it("returns one entry when the same guest has two registrant rows", async () => {
    const event = await seedEvent()
    const guest = await seedGuest({ firstName: "Maria", lastName: "Santos" })
    await db.eventRegistrant.create({ data: { eventId: event.id, guestId: guest.id } })
    await db.eventRegistrant.create({ data: { eventId: event.id, guestId: guest.id } })

    const results = unwrap(await searchCheckinByName(event.id, "maria santos", null))

    expect(results).toHaveLength(1)
    expect(results[0].name).toBe("Maria Santos")
  })

  it("returns one entry when the same member has two registrant rows", async () => {
    const event = await seedEvent()
    const member = await seedMember({ firstName: "Jose", lastName: "Rizal" })
    await db.eventRegistrant.create({ data: { eventId: event.id, memberId: member.id } })
    await db.eventRegistrant.create({ data: { eventId: event.id, memberId: member.id } })

    const results = unwrap(await searchCheckinByName(event.id, "rizal", null))

    expect(results).toHaveLength(1)
  })

  it("prefers the already-checked-in row when duplicates disagree", async () => {
    const event = await seedEvent()
    const guest = await seedGuest({ firstName: "Ana", lastName: "Cruz" })
    await db.eventRegistrant.create({ data: { eventId: event.id, guestId: guest.id } })
    await db.eventRegistrant.create({
      data: { eventId: event.id, guestId: guest.id, attendedAt: new Date() },
    })

    const results = unwrap(await searchCheckinByName(event.id, "ana cruz", null))

    expect(results).toHaveLength(1)
    expect(results[0].alreadyCheckedIn).toBe(true)
  })

  it("collapses a volunteer who is also a registrant into the volunteer record", async () => {
    const event = await seedEvent()
    const member = await seedMember({ firstName: "Pedro", lastName: "Reyes" })
    await seedVolunteer(event.id, member.id)
    await db.eventRegistrant.create({ data: { eventId: event.id, memberId: member.id } })

    const results = unwrap(await searchCheckinByName(event.id, "pedro reyes", null))

    expect(results).toHaveLength(1)
    expect(results[0].kind).toBe("volunteer")
  })

  it("keeps two different people who share a surname", async () => {
    const event = await seedEvent()
    const a = await seedGuest({ firstName: "Liza", lastName: "Tan" })
    const b = await seedGuest({ firstName: "Mark", lastName: "Tan" })
    await db.eventRegistrant.create({ data: { eventId: event.id, guestId: a.id } })
    await db.eventRegistrant.create({ data: { eventId: event.id, guestId: b.id } })

    const results = unwrap(await searchCheckinByName(event.id, "tan", null))

    expect(results).toHaveLength(2)
  })

  it("keeps two unlinked walk-in rows with different contacts apart", async () => {
    const event = await seedEvent()
    await db.eventRegistrant.create({
      data: { eventId: event.id, firstName: "Sam", lastName: "Lee", mobileNumber: "+63 917 111 1111" },
    })
    await db.eventRegistrant.create({
      data: { eventId: event.id, firstName: "Sam", lastName: "Lee", mobileNumber: "+63 917 222 2222" },
    })

    const results = unwrap(await searchCheckinByName(event.id, "sam lee", null))

    expect(results).toHaveLength(2)
  })
})

describe("lookupCheckinRegistrant – de-duplication", () => {
  it("does not ask to disambiguate between duplicate rows for one guest", async () => {
    const event = await seedEvent()
    const guest = await seedGuest({ firstName: "Rosa", lastName: "Diaz", phone: "+63 917 333 3333" })
    await db.eventRegistrant.create({ data: { eventId: event.id, guestId: guest.id } })
    await db.eventRegistrant.create({ data: { eventId: event.id, guestId: guest.id } })

    const data = unwrap(await lookupCheckinRegistrant(event.id, "+63 917 333 3333", null))

    expect(data).not.toBeNull()
    expect(data && "matchType" in data).toBe(false)
  })
})

// ── Nickname matching ─────────────────────────────────────────────────────────

describe("searchCheckinByName – nicknames", () => {
  it("finds a registrant by the nickname on their Member profile", async () => {
    const event = await seedEvent()
    const member = await seedMember({ firstName: "Juanito", lastName: "Cruz", nickname: "Jun" })
    await db.eventRegistrant.create({ data: { eventId: event.id, memberId: member.id } })

    const results = unwrap(await searchCheckinByName(event.id, "jun", null))

    expect(results).toHaveLength(1)
    expect(results[0].nickname).toBe("Jun")
  })

  it("finds a registrant by the nickname on their Guest profile", async () => {
    const event = await seedEvent()
    const guest = await seedGuest({ firstName: "Bernadette", lastName: "Lim", nickname: "Detdet" })
    await db.eventRegistrant.create({ data: { eventId: event.id, guestId: guest.id } })

    const results = unwrap(await searchCheckinByName(event.id, "detdet", null))

    expect(results).toHaveLength(1)
    expect(results[0].nickname).toBe("Detdet")
  })

  it("finds a volunteer by their member nickname", async () => {
    const event = await seedEvent()
    const member = await seedMember({ firstName: "Ricardo", lastName: "Gomez", nickname: "Cardo" })
    await seedVolunteer(event.id, member.id)

    const results = unwrap(await searchCheckinByName(event.id, "cardo", null))

    expect(results).toHaveLength(1)
    expect(results[0].kind).toBe("volunteer")
    expect(results[0].nickname).toBe("Cardo")
  })

  it("prefers the per-event registration nickname over the profile nickname", async () => {
    const event = await seedEvent()
    const member = await seedMember({ firstName: "Teodoro", lastName: "Reyes", nickname: "Teddy" })
    await db.eventRegistrant.create({
      data: { eventId: event.id, memberId: member.id, nickname: "Bear" },
    })

    const results = unwrap(await searchCheckinByName(event.id, "reyes", null))

    expect(results[0].nickname).toBe("Bear")
  })

  it("matches a mix of given name and nickname words", async () => {
    const event = await seedEvent()
    const guest = await seedGuest({ firstName: "Junior", lastName: "Santos", nickname: "Kuya Jun" })
    await db.eventRegistrant.create({ data: { eventId: event.id, guestId: guest.id } })

    const results = unwrap(await searchCheckinByName(event.id, "kuya santos", null))

    expect(results).toHaveLength(1)
  })
})

// ── Walk-in is its own form and its own route (CCF-133) ──────────────────────

describe("checkin-board – walk-in link", () => {
  const board = readFileSync(
    join(process.cwd(), "app/events/[id]/checkin/checkin-board.tsx"),
    "utf8"
  )

  it("no longer embeds the registration form", () => {
    expect(board).not.toContain("RegistrationForm")
  })

  it("links walk-ins to the walk-in route", () => {
    expect(board).toContain("`/events/${eventId}/walk-in")
  })

  it("no longer carries the occurrence in the link", () => {
    // Regression pin for the split: the session is configured on the walk-in
    // form now, so a stale or hand-edited URL cannot re-aim the door.
    expect(board).not.toContain("?checkin=")
  })

  it("offers the breakout step on the config alone, not on auto-assign being off", () => {
    // At the kiosk the Check-in form's toggle is the whole rule. Requiring
    // auto-assign to be off as well meant an event with it on had no way to ask,
    // however plainly the form said to — `handleConfirm` placed the person a
    // moment earlier and the step then skipped them as already seated.
    expect(board).toContain("const offerBreakoutPicker = cfg.sectionBreakout")
    expect(board).not.toContain("cfg.sectionBreakout && !autoAssignBreakout")
  })

  it("stands auto-assign down whenever the kiosk is going to ask", () => {
    // The other half of the same rule: config wins, so auto-assign is what steps
    // aside. Without this the two race and the picker can never render.
    expect(board).toContain(
      "occurrenceId !== null && autoAssignBreakout && !offerBreakoutPicker"
    )
  })
})

describe("register page – pre-registration only", () => {
  const page = readFileSync(join(process.cwd(), "app/events/[id]/register/page.tsx"), "utf8")

  it("redirects the old walk-in URL instead of rendering it", () => {
    // `?checkin=` is on kiosk bookmarks and possibly printed material.
    expect(page).toContain("redirect(`/events/${id}/walk-in")
  })

  it("no longer renders a walk-in", () => {
    expect(page).not.toContain("walkIn={walkIn}")
    expect(page).not.toContain('"WalkIn"')
  })

  it("applies the closed-form gate unconditionally", () => {
    // The `&& !walkIn` carve-out is gone: this page is only ever the form people
    // fill in ahead of the day, and walk-in owns its own switch.
    expect(page).toContain("if (!formConfig.isOpen || !withinWindow) return <FormClosed />")
  })

  it("offers every breakout group, not just ones whose facilitator arrived", () => {
    // The last argument is the facilitator gate — off here, on at the door.
    // `tests/integration/breakout-availability.test.ts` pins what it does.
    expect(page).toContain("fetchBreakoutAvailability(event.id, null, false)")
  })

  it("strips breakout headcounts before they reach a registrant's browser", () => {
    // CCF-141: occupancy is an admin-facing operational number. It rides along
    // on the walk-in page; here the counts must be gone from the payload, not
    // merely unrendered.
    expect(page).toContain("withoutOccupancy(breakoutCandidates)")
    expect(page).toContain("breakoutCandidates={publicBreakoutCandidates}")
  })

  it("explains an empty breakout list instead of dropping the step", () => {
    // Regression: an enabled Breakout toggle produced no step and no explanation
    // when every group was held back by the facilitator gate.
    expect(page).toContain("resolveBreakoutNotice(")
    expect(page).toContain("breakoutNotice={breakoutNotice}")
  })
})

describe("walk-in page – the door surface", () => {
  const page = readFileSync(join(process.cwd(), "app/events/[id]/walk-in/page.tsx"), "utf8")

  it("reuses the shared registration form rather than a second copy", () => {
    expect(page).toContain("RegistrationForm")
    expect(page).toContain('from "../register/registration-form"')
  })

  it("reads its own form config, not the registration form's", () => {
    expect(page).toContain('getFormConfig("EventWalkIn", id)')
  })

  it("never consults the registration window", () => {
    // Closing pre-registration the night before must not close the door.
    expect(page).not.toContain("isWithinRegistrationWindow")
    expect(page).not.toContain("registrationStart")
  })

  it("takes the session from configuration, never from the URL", () => {
    // The pin and the Latest-mode lookup both live behind this one resolver, so
    // the page has no way to name a session of its own — see lib/events/walk-in-session.ts.
    expect(page).toContain("resolveWalkInSession(event)")
    expect(page).toContain("walkInSessionMode: true")
    // `mobile` is the only search param it reads — no `checkin` to hand-edit.
    // (The string "checkin" still appears in the back-link to the board.)
    expect(page).toContain("searchParams: Promise<{ mobile?: string }>")
    expect(page).not.toMatch(/checkin\?:/)
  })

  it("only offers breakout groups whose facilitator has checked in", () => {
    expect(page).toContain("fetchBreakoutAvailability(event.id, occurrenceId, true)")
  })

  it("shows headcounts to staff and withholds them from everyone else", () => {
    // This route is public — being *meant* for the door is not the same as being
    // reachable only from it, so the counts hang off a session. The behavioural
    // half of this lives in tests/integration/breakout-occupancy-visibility.test.ts;
    // asserted here too because the strip is a single call that is easy to drop
    // while refactoring the page, and nothing else on this page would notice.
    expect(page).toContain("isEventStaffViewer()")
    expect(page).toContain("withoutOccupancy(allBreakoutCandidates)")
  })
})
