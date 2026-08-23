/**
 * A breakout group's off switch (`BreakoutGroup.isEnabled`).
 *
 * Off means one thing: no new person lands here by an *automatic or public*
 * route. The three queries that decide that share nothing but the flag — the
 * picker, the scorer, and the registration write — so each is pinned separately,
 * as is the deliberate hole: an admin on the group's own screen can still add
 * and transfer people in.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { db } from "@/lib/db"
import {
  breakoutPickerReadiness,
  fetchBreakoutAvailability,
  fetchBreakoutCandidates,
} from "@/lib/breakout-suggestion-server"
import { resolveBreakoutNotice } from "@/lib/breakout-suggestion"
import { matchBreakoutGroups } from "@/lib/matching"
import { assignBreakoutForRegistrant } from "@/lib/events/registration-core"
import {
  addRegistrantsToBreakout,
  setBreakoutGroupEnabled,
  transferRegistrantToBreakout,
} from "@/app/(dashboard)/events/breakout-actions"

beforeEach(async () => {
  vi.clearAllMocks()
  await db.$executeRaw`TRUNCATE "SmallGroupMemberRequest", "SmallGroupLog", "BreakoutGroupMember", "BreakoutGroupSchedule", "BreakoutGroup", "Volunteer", "CommitteeRole", "VolunteerCommittee", "EventRegistrant", "EventOccurrence", "EventFormConfig", "EventModule", "Event", "Member", "Guest", "LifeStage", "MatchingWeightConfig" RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function seedEvent(name = "Retreat", opts: { autoAssign?: boolean } = {}) {
  const event = await db.event.create({
    data: {
      name,
      type: "OneTime",
      startDate: new Date(),
      endDate: new Date(),
      autoAssignBreakout: opts.autoAssign ?? false,
    },
  })
  // Every write path is module-gated first (CCF-128), so without this nothing
  // under test is even reached.
  await db.eventModule.create({ data: { eventId: event.id, type: "Breakout" } })
  return event
}

async function seedGroup(eventId: string, name: string, data: Record<string, unknown> = {}) {
  return db.breakoutGroup.create({ data: { eventId, name, language: [], ...data } })
}

async function seedRegistrant(eventId: string, firstName = "Ana") {
  const member = await db.member.create({
    data: { firstName, lastName: "Cruz", dateJoined: new Date(), language: [] },
  })
  const registrant = await db.eventRegistrant.create({
    data: { eventId, memberId: member.id },
  })
  return { member, registrant }
}

/** A facilitator who has checked in — enough to clear the walk-in gate. */
async function seedCheckedInFacilitator(eventId: string, groupId: string, name: string) {
  const member = await db.member.create({
    data: { firstName: name, lastName: "Faci", dateJoined: new Date(), language: [] },
  })
  const committee = await db.volunteerCommittee.create({
    data: { name: `Committee ${name}`, eventId },
  })
  const role = await db.committeeRole.create({
    data: { name: "Facilitator", committeeId: committee.id },
  })
  const volunteer = await db.volunteer.create({
    data: {
      memberId: member.id,
      eventId,
      committeeId: committee.id,
      preferredRoleId: role.id,
      status: "Confirmed",
    },
  })
  await db.breakoutGroup.update({
    where: { id: groupId },
    data: { facilitatorId: volunteer.id },
  })
  // On their Volunteer row, which is where the kiosk records a facilitator's
  // arrival. Seeding an attended EventRegistrant instead reads plausibly and is
  // a lane no real facilitator uses.
  await db.volunteer.update({
    where: { id: volunteer.id },
    data: { attendedAt: new Date() },
  })
  return volunteer
}

// ─── The action ───────────────────────────────────────────────────────────────

describe("setBreakoutGroupEnabled", () => {
  it("switches a group off and back on", async () => {
    const event = await seedEvent()
    const group = await seedGroup(event.id, "Table 1")

    // Groups arrive in play — the column defaults true so nothing existing goes
    // dark on deploy.
    expect(group.isEnabled).toBe(true)

    expect(await setBreakoutGroupEnabled(group.id, { eventId: event.id }, false)).toEqual({
      success: true,
      data: undefined,
    })
    expect(
      (await db.breakoutGroup.findUnique({ where: { id: group.id } }))?.isEnabled
    ).toBe(false)

    await setBreakoutGroupEnabled(group.id, { eventId: event.id }, true)
    expect(
      (await db.breakoutGroup.findUnique({ where: { id: group.id } }))?.isEnabled
    ).toBe(true)
  })

  it("refuses a group id that belongs to a different event", async () => {
    const event = await seedEvent("Mine")
    const other = await seedEvent("Theirs")
    const group = await seedGroup(other.id, "Not yours")

    // The event scope is part of the write, so passing another event's id from
    // a page you *can* write to changes nothing.
    const result = await setBreakoutGroupEnabled(group.id, { eventId: event.id }, false)

    expect(result).toEqual({ success: false, error: "Breakout group not found" })
    expect(
      (await db.breakoutGroup.findUnique({ where: { id: group.id } }))?.isEnabled
    ).toBe(true)
  })
})

// ─── Intake path 1: the public / walk-in picker ───────────────────────────────

describe("fetchBreakoutCandidates", () => {
  it("omits a disabled group and keeps the enabled one", async () => {
    const event = await seedEvent()
    const on = await seedGroup(event.id, "On")
    const off = await seedGroup(event.id, "Off", { isEnabled: false })

    const candidates = await fetchBreakoutCandidates(event.id, null, false)

    expect(candidates.map((c) => c.id)).toEqual([on.id])
    expect(candidates.map((c) => c.id)).not.toContain(off.id)
  })

  it("stays off even when its facilitator has checked in", async () => {
    const event = await seedEvent()
    const off = await seedGroup(event.id, "Off", { isEnabled: false })
    await seedCheckedInFacilitator(event.id, off.id, "Ana")

    // The facilitator gate and the switch are independent: clearing one does not
    // clear the other.
    expect(await fetchBreakoutCandidates(event.id, null, true)).toHaveLength(0)
  })
})

// ─── Intake path 2: the scorer ────────────────────────────────────────────────

describe("matchBreakoutGroups", () => {
  it("never suggests a disabled group", async () => {
    const event = await seedEvent()
    const on = await seedGroup(event.id, "On")
    await seedGroup(event.id, "Off", { isEnabled: false })
    const { registrant } = await seedRegistrant(event.id)

    const results = await matchBreakoutGroups(registrant.id, { eventId: event.id })

    expect(results.map((r) => r.groupId)).toEqual([on.id])
  })
})

// ─── Intake path 3: the registration write ────────────────────────────────────

describe("assignBreakoutForRegistrant", () => {
  it("ignores an explicit pick of a disabled group", async () => {
    const event = await seedEvent()
    const off = await seedGroup(event.id, "Off", { isEnabled: false })
    const { registrant } = await seedRegistrant(event.id)

    // The id arrives in a submitted payload — a form rendered before the switch
    // was flipped must not still be able to place someone.
    const assigned = await assignBreakoutForRegistrant(
      registrant.id,
      event.id,
      off.id,
      { gender: null, birthYear: null }
    )

    expect(assigned).toBeNull()
    expect(await db.breakoutGroupMember.count()).toBe(0)
  })

  it("does not rescue a disabled pick with the over-capacity override", async () => {
    const event = await seedEvent()
    const off = await seedGroup(event.id, "Off", { isEnabled: false, memberLimit: 1 })
    const { registrant } = await seedRegistrant(event.id)

    // `allowOverCapacity` is the staffed door pushing past a *full* group. There
    // is no equivalent for a switched-off one.
    const assigned = await assignBreakoutForRegistrant(
      registrant.id,
      event.id,
      off.id,
      { gender: null, birthYear: null },
      true
    )

    expect(assigned).toBeNull()
    expect(await db.breakoutGroupMember.count()).toBe(0)
  })

  it("auto-assign skips the disabled group and uses the enabled one", async () => {
    const event = await seedEvent("Retreat", { autoAssign: true })
    await seedGroup(event.id, "Off", { isEnabled: false })
    const on = await seedGroup(event.id, "On")
    const { registrant } = await seedRegistrant(event.id)

    const assigned = await assignBreakoutForRegistrant(
      registrant.id,
      event.id,
      null,
      { gender: null, birthYear: null }
    )

    expect(assigned?.id).toBe(on.id)
  })

  it("auto-assign places nobody when every group is off", async () => {
    const event = await seedEvent("Retreat", { autoAssign: true })
    await seedGroup(event.id, "Off A", { isEnabled: false })
    await seedGroup(event.id, "Off B", { isEnabled: false })
    const { registrant } = await seedRegistrant(event.id)

    expect(
      await assignBreakoutForRegistrant(registrant.id, event.id, null, {
        gender: null,
        birthYear: null,
      })
    ).toBeNull()
    expect(await db.breakoutGroupMember.count()).toBe(0)
  })

  // ─── The door's facilitator gate reaches automatic placement too ─────────────

  it("auto-assign at the door refuses a group whose facilitator is not in the room", async () => {
    const event = await seedEvent("Retreat", { autoAssign: true })
    await seedGroup(event.id, "Unstaffed")
    const { registrant } = await seedRegistrant(event.id)

    // Enabled, has room, matches on every soft criterion — and nobody there to
    // receive the walk-in. `atDoor` is what makes automatic placement care.
    const assigned = await assignBreakoutForRegistrant(
      registrant.id,
      event.id,
      null,
      { gender: null, birthYear: null },
      false,
      { occurrenceId: null }
    )

    expect(assigned).toBeNull()
    expect(await db.breakoutGroupMember.count()).toBe(0)
  })

  it("auto-assign at the door picks the staffed group over the unstaffed one", async () => {
    const event = await seedEvent("Retreat", { autoAssign: true })
    await seedGroup(event.id, "Unstaffed")
    const staffed = await seedGroup(event.id, "Staffed")
    await seedCheckedInFacilitator(event.id, staffed.id, "Rey")
    const { registrant } = await seedRegistrant(event.id)

    const assigned = await assignBreakoutForRegistrant(
      registrant.id,
      event.id,
      null,
      { gender: null, birthYear: null },
      false,
      { occurrenceId: null }
    )

    expect(assigned?.id).toBe(staffed.id)
  })

  it("auto-assign away from the door still uses every enabled group", async () => {
    // Pre-registration is not the door: nobody has checked in yet by definition,
    // so gating there would place nobody at all.
    const event = await seedEvent("Retreat", { autoAssign: true })
    const group = await seedGroup(event.id, "Unstaffed")
    const { registrant } = await seedRegistrant(event.id)

    const assigned = await assignBreakoutForRegistrant(registrant.id, event.id, null, {
      gender: null,
      birthYear: null,
    })

    expect(assigned?.id).toBe(group.id)
  })

  it("an explicit pick at the door is still honoured — staff intent outranks the gate", async () => {
    // The gate decides what is *offered*. A pick that arrives anyway was chosen
    // by someone, and the same reasoning that lets staff exceed a member limit
    // applies: only automatic placement has no intent to honour.
    const event = await seedEvent("Retreat", { autoAssign: true })
    const group = await seedGroup(event.id, "Unstaffed")
    const { registrant } = await seedRegistrant(event.id)

    const assigned = await assignBreakoutForRegistrant(
      registrant.id,
      event.id,
      group.id,
      { gender: null, birthYear: null },
      false,
      { occurrenceId: null }
    )

    expect(assigned?.id).toBe(group.id)
  })
})

// ─── The deliberate hole: admins can still place people by hand ───────────────

describe("admin placement into a disabled group", () => {
  it("still adds registrants", async () => {
    const event = await seedEvent()
    const off = await seedGroup(event.id, "Off", { isEnabled: false })
    const { registrant } = await seedRegistrant(event.id)

    // Off aims at the automatic and public routes, not at staff judgment. An
    // admin standing on this group's page has said what they want.
    const result = await addRegistrantsToBreakout(off.id, [registrant.id], { eventId: event.id })

    expect(result.success).toBe(true)
    expect(
      await db.breakoutGroupMember.count({ where: { breakoutGroupId: off.id } })
    ).toBe(1)
  })

  it("still accepts a transfer in", async () => {
    const event = await seedEvent()
    const from = await seedGroup(event.id, "On")
    const off = await seedGroup(event.id, "Off", { isEnabled: false })
    const { registrant } = await seedRegistrant(event.id)
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: from.id, registrantId: registrant.id },
    })

    const result = await transferRegistrantToBreakout(
      from.id,
      off.id,
      registrant.id,
      { eventId: event.id }
    )

    expect(result.success).toBe(true)
    expect(
      await db.breakoutGroupMember.findFirst({ where: { registrantId: registrant.id } })
    ).toMatchObject({ breakoutGroupId: off.id })
  })

  it("keeps the members a group already had when it is switched off", async () => {
    const event = await seedEvent()
    const group = await seedGroup(event.id, "Table 1")
    const { registrant } = await seedRegistrant(event.id)
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: group.id, registrantId: registrant.id },
    })

    await setBreakoutGroupEnabled(group.id, { eventId: event.id }, false)

    // The switch is not a delete: the roster, and everything downstream that
    // reads it, survives.
    expect(
      await db.breakoutGroupMember.count({ where: { breakoutGroupId: group.id } })
    ).toBe(1)
  })
})

// ─── The counts behind the form-builder warning ───────────────────────────────

describe("breakoutPickerReadiness", () => {
  it("separates 'no groups' from 'all groups off'", async () => {
    const event = await seedEvent()
    const staffed = await seedGroup(event.id, "Staffed", { isEnabled: false })
    await seedCheckedInFacilitator(event.id, staffed.id, "Ana")
    await seedGroup(event.id, "Plain", { isEnabled: false })

    // totalGroups stays ungated on purpose — it is what lets the warning say
    // "switch one on" instead of "create one".
    expect(await breakoutPickerReadiness(event.id)).toEqual({
      totalGroups: 2,
      enabledGroups: 0,
      staffedGroups: 0,
      autoAssignableGroups: 0,
      genderedGroups: 0,
    })
  })

  it("does not blame the facilitators when every group is switched off", async () => {
    // Regression: `fetchBreakoutAvailability` counted *every* group on the event,
    // so switching them all off left the public form saying "waiting for your
    // table host to check in" — the one explanation that was not true. On a
    // public route, off has to look the same as absent.
    const event = await seedEvent()
    const a = await seedGroup(event.id, "Table 1", { isEnabled: false })
    await seedCheckedInFacilitator(event.id, a.id, "Ana")
    await seedGroup(event.id, "Table 2", { isEnabled: false })

    const { candidates, totalGroups } = await fetchBreakoutAvailability(event.id, null, true)

    expect(candidates).toEqual([])
    expect(totalGroups).toBe(0)
    // Which is what drops the step instead of explaining it away.
    expect(
      resolveBreakoutNotice({ offerPicker: true, candidateCount: 0, totalGroups })
    ).toBeNull()
  })

  it("still explains an empty picker while a group is on but unstaffed", async () => {
    // The other side of the same branch: one enabled group whose facilitator has
    // not checked in is exactly the case the notice was written for.
    const event = await seedEvent()
    await seedGroup(event.id, "Table 1")
    await seedGroup(event.id, "Table 2", { isEnabled: false })

    const { candidates, totalGroups } = await fetchBreakoutAvailability(event.id, null, true)

    expect(candidates).toEqual([])
    expect(totalGroups).toBe(1)
    expect(
      resolveBreakoutNotice({ offerPicker: true, candidateCount: 0, totalGroups })
    ).toBe("awaiting-facilitator")
  })

  it("counts only enabled groups as staffed", async () => {
    const event = await seedEvent()
    const on = await seedGroup(event.id, "On")
    await seedCheckedInFacilitator(event.id, on.id, "Ana")
    const off = await seedGroup(event.id, "Off", { isEnabled: false })
    await seedCheckedInFacilitator(event.id, off.id, "Ben")

    // A facilitator assigned to a switched-off group does not make the picker
    // work, so counting them would make the warning lie.
    expect(await breakoutPickerReadiness(event.id)).toEqual({
      totalGroups: 2,
      enabledGroups: 1,
      staffedGroups: 1,
      autoAssignableGroups: 1,
      genderedGroups: 0,
    })
  })
})
