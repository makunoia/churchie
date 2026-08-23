import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { db } from "@/lib/db"
import {
  breakoutPickerReadiness,
  fetchBreakoutAvailability,
  fetchBreakoutCandidates,
} from "@/lib/breakout-suggestion-server"

/**
 * The walk-in kiosk gates breakout groups on facilitator check-in. That rule is
 * deliberate, but it used to be invisible: every group held back meant the step
 * disappeared with no explanation. These tests pin both halves — the gate itself,
 * and the counts the UI needs to explain it.
 */

beforeEach(async () => {
  await db.$executeRaw`TRUNCATE "OccurrenceSubFacilitator", "OccurrenceAttendee", "BreakoutGroupMember", "BreakoutGroup", "Volunteer", "CommitteeRole", "VolunteerCommittee", "EventRegistrant", "EventOccurrence", "Event", "Member", "Guest" RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

async function seedEvent() {
  const event = await db.event.create({
    data: { name: "Retreat", type: "OneTime", startDate: new Date(), endDate: new Date() },
  })
  const committee = await db.volunteerCommittee.create({
    data: { name: "Facilitators", eventId: event.id },
  })
  const role = await db.committeeRole.create({
    data: { name: "Facilitator", committeeId: committee.id },
  })
  return { event, committee, role }
}

async function seedFacilitator(
  eventId: string,
  committeeId: string,
  roleId: string,
  name: string
) {
  const member = await db.member.create({
    data: { firstName: name, lastName: "Faci", dateJoined: new Date(), language: [] },
  })
  const volunteer = await db.volunteer.create({
    data: {
      memberId: member.id,
      eventId,
      committeeId,
      preferredRoleId: roleId,
      status: "Confirmed",
    },
  })
  return { member, volunteer }
}

describe("fetchBreakoutAvailability — the walk-in facilitator gate", () => {
  it("holds back a group whose facilitator has not checked in, and reports it exists", async () => {
    const { event, committee, role } = await seedEvent()
    const { volunteer } = await seedFacilitator(event.id, committee.id, role.id, "Ana")
    await db.breakoutGroup.create({
      data: { name: "Table 1", eventId: event.id, facilitatorId: volunteer.id },
    })

    const { candidates, totalGroups } = await fetchBreakoutAvailability(event.id, null, true)

    // Nothing to pick, but the form can now say why instead of dropping the step.
    expect(candidates).toHaveLength(0)
    expect(totalGroups).toBe(1)
  })

  it("offers the group once its facilitator has checked in", async () => {
    const { event, committee, role } = await seedEvent()
    const { volunteer } = await seedFacilitator(event.id, committee.id, role.id, "Ben")
    await db.breakoutGroup.create({
      data: { name: "Table 2", eventId: event.id, facilitatorId: volunteer.id },
    })
    // How a OneTime check-in of a facilitator is actually recorded: on their
    // Volunteer row, not on an EventRegistrant.
    await db.volunteer.update({
      where: { id: volunteer.id },
      data: { attendedAt: new Date() },
    })

    const { candidates, totalGroups } = await fetchBreakoutAvailability(event.id, null, true)

    expect(candidates.map((c) => c.name)).toEqual(["Table 2"])
    expect(totalGroups).toBe(1)
  })

  it("offers the group when a co-facilitator is the one who checked in", async () => {
    const { event, committee, role } = await seedEvent()
    const { volunteer } = await seedFacilitator(event.id, committee.id, role.id, "Gia")
    await db.breakoutGroup.create({
      data: { name: "Co-led", eventId: event.id, coFacilitatorId: volunteer.id },
    })
    await db.volunteer.update({
      where: { id: volunteer.id },
      data: { attendedAt: new Date() },
    })

    const { candidates } = await fetchBreakoutAvailability(event.id, null, true)
    expect(candidates.map((c) => c.name)).toEqual(["Co-led"])
  })

  it("still honours a facilitator checked in on the registrant lane", async () => {
    // Not how the kiosk writes it, but a facilitator hand-added as a registrant
    // (or imported that way) used to be the *only* thing that passed this gate.
    // Widening it to volunteers must not drop that.
    const { event, committee, role } = await seedEvent()
    const { member, volunteer } = await seedFacilitator(event.id, committee.id, role.id, "Hal")
    await db.breakoutGroup.create({
      data: { name: "Table 2b", eventId: event.id, facilitatorId: volunteer.id },
    })
    await db.eventRegistrant.create({
      data: { eventId: event.id, memberId: member.id, attendedAt: new Date() },
    })

    const { candidates } = await fetchBreakoutAvailability(event.id, null, true)
    expect(candidates.map((c) => c.name)).toEqual(["Table 2b"])
  })

  it("never offers a group with no facilitator assigned — regression for the invisible-forever case", async () => {
    const { event } = await seedEvent()
    await db.breakoutGroup.create({ data: { name: "Unstaffed", eventId: event.id } })

    const { candidates, totalGroups } = await fetchBreakoutAvailability(event.id, null, true)

    // Every branch of the gate requires a facilitator relation, so a null
    // facilitator can never pass it. Intentional — pinned so it can't drift
    // silently the way it did before.
    expect(candidates).toHaveLength(0)
    expect(totalGroups).toBe(1)
  })

  it("gates on the specific occurrence for session-based check-in", async () => {
    const { event, committee, role } = await seedEvent()
    const { volunteer } = await seedFacilitator(event.id, committee.id, role.id, "Cy")
    await db.breakoutGroup.create({
      data: { name: "Table 3", eventId: event.id, facilitatorId: volunteer.id },
    })
    const [today, tomorrow] = await Promise.all([
      db.eventOccurrence.create({
        data: { eventId: event.id, date: new Date("2026-01-01T00:00:00Z") },
      }),
      db.eventOccurrence.create({
        data: { eventId: event.id, date: new Date("2026-01-02T00:00:00Z") },
      }),
    ])
    // A session check-in of a facilitator: an OccurrenceAttendee carrying
    // `volunteerId`, with `registrantId` null.
    await db.occurrenceAttendee.create({
      data: { occurrenceId: today.id, volunteerId: volunteer.id },
    })

    // Present today…
    const present = await fetchBreakoutAvailability(event.id, today.id, true)
    expect(present.candidates.map((c) => c.name)).toEqual(["Table 3"])

    // …but not yet at tomorrow's session.
    const absent = await fetchBreakoutAvailability(event.id, tomorrow.id, true)
    expect(absent.candidates).toHaveLength(0)
    expect(absent.totalGroups).toBe(1)
  })

  it("does not count a facilitator's check-in at another event", async () => {
    // `Volunteer.attendedAt` is scoped by the volunteer's own eventId, so the
    // OneTime branch needs no explicit event filter — pinned so it stays true.
    const { event, committee, role } = await seedEvent()
    const { member } = await seedFacilitator(event.id, committee.id, role.id, "Ivy")
    const other = await db.event.create({
      data: { name: "Other", type: "OneTime", startDate: new Date(), endDate: new Date() },
    })
    const otherCommittee = await db.volunteerCommittee.create({
      data: { name: "Faci", eventId: other.id },
    })
    const otherRole = await db.committeeRole.create({
      data: { name: "Faci", committeeId: otherCommittee.id },
    })
    // Same person, checked in at a different event on that event's volunteer row.
    await db.volunteer.create({
      data: {
        memberId: member.id,
        eventId: other.id,
        committeeId: otherCommittee.id,
        preferredRoleId: otherRole.id,
        status: "Confirmed",
        attendedAt: new Date(),
      },
    })
    const here = await db.volunteer.findFirst({ where: { memberId: member.id, eventId: event.id } })
    await db.breakoutGroup.create({
      data: { name: "Table 4", eventId: event.id, facilitatorId: here!.id },
    })

    const { candidates, totalGroups } = await fetchBreakoutAvailability(event.id, null, true)
    expect(candidates).toHaveLength(0)
    expect(totalGroups).toBe(1)
  })

  it("offers every group on the public form, where nobody has checked in yet", async () => {
    const { event, committee, role } = await seedEvent()
    const { volunteer } = await seedFacilitator(event.id, committee.id, role.id, "Dee")
    await db.breakoutGroup.create({
      data: { name: "Staffed", eventId: event.id, facilitatorId: volunteer.id },
    })
    await db.breakoutGroup.create({ data: { name: "Unstaffed", eventId: event.id } })

    const { candidates, totalGroups } = await fetchBreakoutAvailability(event.id, null, false)

    expect(candidates.map((c) => c.name).sort()).toEqual(["Staffed", "Unstaffed"])
    expect(totalGroups).toBe(2)
    // The ungated read stays identical to the long-standing helper.
    const legacy = await fetchBreakoutCandidates(event.id, null, false)
    expect(legacy.map((c) => c.id).sort()).toEqual(candidates.map((c) => c.id).sort())
  })

  it("opens a group on a named stand-in alone, with no check-in of their own", async () => {
    // The deliberate exception (CCF-76), pinned here as well as in that ticket's
    // file because from this side it looks exactly like the bug above: every
    // other branch of the gate demands attendance and this one doesn't. Naming a
    // stand-in is explicit admin intent about a group they are looking at, and
    // intent outranks the gate — the same rule that honours a staff member's
    // explicit breakout pick at the door while refusing an automatic one.
    const { event, committee, role } = await seedEvent()
    const { volunteer } = await seedFacilitator(event.id, committee.id, role.id, "Jo")
    const { volunteer: sub } = await seedFacilitator(event.id, committee.id, role.id, "Kit")
    const group = await db.breakoutGroup.create({
      data: { name: "Table 5", eventId: event.id, facilitatorId: volunteer.id },
    })
    const session = await db.eventOccurrence.create({
      data: { eventId: event.id, date: new Date("2026-03-01T00:00:00Z") },
    })
    await db.occurrenceSubFacilitator.create({
      data: {
        occurrenceId: session.id,
        breakoutGroupId: group.id,
        role: "Facilitator",
        substituteId: sub.id,
      },
    })

    const { candidates } = await fetchBreakoutAvailability(event.id, session.id, true)
    expect(candidates.map((c) => c.name)).toEqual(["Table 5"])
  })

  it("reports zero groups for an event with no breakouts, so no notice is shown", async () => {
    const { event } = await seedEvent()
    const { candidates, totalGroups } = await fetchBreakoutAvailability(event.id, null, true)
    expect(candidates).toHaveLength(0)
    expect(totalGroups).toBe(0)
  })
})

describe("breakoutPickerReadiness — what the form builder warns on", () => {
  it("counts assigned facilitators, not checked-in ones", async () => {
    const { event, committee, role } = await seedEvent()
    const { volunteer } = await seedFacilitator(event.id, committee.id, role.id, "Eve")
    await db.breakoutGroup.create({
      data: { name: "Staffed", eventId: event.id, facilitatorId: volunteer.id },
    })
    await db.breakoutGroup.create({ data: { name: "Unstaffed A", eventId: event.id } })
    await db.breakoutGroup.create({ data: { name: "Unstaffed B", eventId: event.id } })

    // Nobody has checked in, but the admin-facing question is "is this
    // configured?" — a fixable standing problem, not a runtime one.
    expect(await breakoutPickerReadiness(event.id)).toEqual({
      totalGroups: 3,
      enabledGroups: 3,
      staffedGroups: 1,
      autoAssignableGroups: 3,
      genderedGroups: 0,
    })
  })

  it("counts a co-facilitator as staffing the group", async () => {
    const { event, committee, role } = await seedEvent()
    const { volunteer } = await seedFacilitator(event.id, committee.id, role.id, "Fay")
    await db.breakoutGroup.create({
      data: { name: "Co-led", eventId: event.id, coFacilitatorId: volunteer.id },
    })

    expect(await breakoutPickerReadiness(event.id)).toEqual({
      totalGroups: 1,
      enabledGroups: 1,
      staffedGroups: 1,
      autoAssignableGroups: 1,
      genderedGroups: 0,
    })
  })

  it("reports all-unstaffed, which is the state that makes the walk-in step vanish", async () => {
    const { event } = await seedEvent()
    await db.breakoutGroup.create({ data: { name: "One", eventId: event.id } })
    await db.breakoutGroup.create({ data: { name: "Two", eventId: event.id } })

    expect(await breakoutPickerReadiness(event.id)).toEqual({
      totalGroups: 2,
      enabledGroups: 2,
      staffedGroups: 0,
      autoAssignableGroups: 2,
      genderedGroups: 0,
    })
  })

  it("ignores breakout groups belonging to other events", async () => {
    const { event } = await seedEvent()
    const other = await db.event.create({
      data: { name: "Other", type: "OneTime", startDate: new Date(), endDate: new Date() },
    })
    await db.breakoutGroup.create({ data: { name: "Mine", eventId: event.id } })
    await db.breakoutGroup.create({ data: { name: "Theirs", eventId: other.id } })

    expect(await breakoutPickerReadiness(event.id)).toEqual({
      totalGroups: 1,
      enabledGroups: 1,
      staffedGroups: 0,
      autoAssignableGroups: 1,
      genderedGroups: 0,
    })
  })
})
