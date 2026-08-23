/**
 * A breakout group held back for manual assignment (`BreakoutGroup.manualAssignOnly`).
 *
 * The narrow sibling of `isEnabled`, and the point of it is the asymmetry: off
 * closes every automatic AND public route into a table, while this closes only
 * the automatic ones. So the same table must vanish from the suggestion, from
 * auto-assign and from the scorer, and stay exactly where it was in the browse
 * list and on the admin screens.
 *
 * Each of the automatic routes is pinned separately because they share nothing
 * but the intent — the suggester works on a loaded candidate set (the flag rides
 * on the candidate), while the scorer filters in SQL
 * (`AUTO_ASSIGNABLE_BREAKOUT_WHERE`). The dropdown cases are the regression: they
 * are what fails if someone "simplifies" this into the candidate query.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { db } from "@/lib/db"
import {
  fetchBreakoutAvailability,
  fetchBreakoutCandidates,
} from "@/lib/breakout-suggestion-server"
import { breakoutPickerOptions, suggestBreakoutGroup } from "@/lib/breakout-suggestion"
import { matchBreakoutGroups } from "@/lib/matching"
import { assignBreakoutForRegistrant } from "@/lib/events/registration-core"
import {
  addRegistrantsToBreakout,
  getCheckinBreakoutChoices,
} from "@/app/(dashboard)/events/breakout-actions"
import { breakoutPickerReadiness } from "@/lib/breakout-suggestion-server"
import { eventFormPrerequisites } from "@/lib/forms/form-prerequisites-server"

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
  // Every write path is module-gated first (CCF-128).
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

const NO_PROFILE = { gender: null, birthYear: null }

// ─── The column itself ────────────────────────────────────────────────────────

describe("the column", () => {
  it("defaults to false, so nothing existing leaves the rotation on deploy", async () => {
    const event = await seedEvent()
    const group = await seedGroup(event.id, "Table 1")
    expect(group.manualAssignOnly).toBe(false)
  })
})

// ─── Automatic route 1: the suggestion ────────────────────────────────────────

describe("the suggested group", () => {
  it("is never the held-back table, even when it is the emptiest", async () => {
    const event = await seedEvent()
    const reserve = await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    const open = await seedGroup(event.id, "Open")
    // Put someone in the open table so the reserve is strictly emptier: a
    // suggester that ignored the flag would rank it first on `fillLevel` alone.
    const { registrant: other } = await seedRegistrant(event.id, "Bea")
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: open.id, registrantId: other.id },
    })

    const candidates = await fetchBreakoutCandidates(event.id, null, false)

    expect(suggestBreakoutGroup(candidates, NO_PROFILE)?.id).toBe(open.id)
    expect(suggestBreakoutGroup(candidates, NO_PROFILE)?.id).not.toBe(reserve.id)
  })

  it("is absent entirely when every table is held back", async () => {
    const event = await seedEvent()
    await seedGroup(event.id, "Reserve A", { manualAssignOnly: true })
    await seedGroup(event.id, "Reserve B", { manualAssignOnly: true })

    const candidates = await fetchBreakoutCandidates(event.id, null, false)

    expect(suggestBreakoutGroup(candidates, NO_PROFILE)).toBeNull()
  })
})

// ─── The half that must NOT change: the browse list ───────────────────────────

describe("the dropdown", () => {
  it("still loads a held-back table as a candidate", async () => {
    // Regression. Filtering `manualAssignOnly` in this query is the obvious way
    // to build the feature and it is wrong: one loaded set feeds both the
    // suggester and the dropdown, so a SQL filter here makes the setting behave
    // exactly like `isEnabled: false`.
    const event = await seedEvent()
    const reserve = await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    const open = await seedGroup(event.id, "Open")

    const candidates = await fetchBreakoutCandidates(event.id, null, false)

    expect(candidates.map((c) => c.id).sort()).toEqual([reserve.id, open.id].sort())
  })

  it("still offers it, ranked on its own emptiness", async () => {
    const event = await seedEvent()
    const reserve = await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    const open = await seedGroup(event.id, "Open")
    const { registrant: other } = await seedRegistrant(event.id, "Bea")
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: open.id, registrantId: other.id },
    })

    const candidates = await fetchBreakoutCandidates(event.id, null, false)

    // Not merely present — still first, because it really is the emptiest table.
    expect(breakoutPickerOptions(candidates, NO_PROFILE).map((g) => g.id)).toEqual([
      reserve.id,
      open.id,
    ])
  })

  it("keeps counting toward totalGroups, so the step is not explained away", async () => {
    // `totalGroups` exists to tell "nothing to offer" apart from "everything is
    // gated". A held-back table IS offered, so it counts — unlike a disabled one.
    const event = await seedEvent()
    await seedGroup(event.id, "Reserve", { manualAssignOnly: true })

    const { candidates, totalGroups } = await fetchBreakoutAvailability(event.id, null, false)

    expect(totalGroups).toBe(1)
    expect(candidates).toHaveLength(1)
  })
})

// ─── Automatic route 2: the scorer ────────────────────────────────────────────

describe("matchBreakoutGroups", () => {
  it("never suggests a held-back group", async () => {
    const event = await seedEvent()
    const open = await seedGroup(event.id, "Open")
    await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    const { registrant } = await seedRegistrant(event.id)

    const results = await matchBreakoutGroups(registrant.id, { eventId: event.id })

    expect(results.map((r) => r.groupId)).toEqual([open.id])
  })

  it("returns nothing when every group is held back", async () => {
    const event = await seedEvent()
    await seedGroup(event.id, "Reserve A", { manualAssignOnly: true })
    await seedGroup(event.id, "Reserve B", { manualAssignOnly: true })
    const { registrant } = await seedRegistrant(event.id)

    expect(await matchBreakoutGroups(registrant.id, { eventId: event.id })).toEqual([])
  })
})

// ─── Automatic route 3: the registration write ────────────────────────────────

describe("assignBreakoutForRegistrant", () => {
  it("auto-assign skips the held-back group and uses the open one", async () => {
    const event = await seedEvent("Retreat", { autoAssign: true })
    await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    const open = await seedGroup(event.id, "Open")
    const { registrant } = await seedRegistrant(event.id)

    const assigned = await assignBreakoutForRegistrant(
      registrant.id,
      event.id,
      null,
      NO_PROFILE
    )

    expect(assigned?.id).toBe(open.id)
  })

  it("auto-assign places nobody when every group is held back", async () => {
    // Deliberately no fallback: a table held back for manual assignment is one
    // nobody should be dropped into, and "there was nowhere else" is not a reason
    // to override that. The registrant is left unseated for staff to place.
    const event = await seedEvent("Retreat", { autoAssign: true })
    await seedGroup(event.id, "Reserve A", { manualAssignOnly: true })
    await seedGroup(event.id, "Reserve B", { manualAssignOnly: true })
    const { registrant } = await seedRegistrant(event.id)

    expect(
      await assignBreakoutForRegistrant(registrant.id, event.id, null, NO_PROFILE)
    ).toBeNull()
    expect(await db.breakoutGroupMember.count()).toBe(0)
  })

  it("auto-assign at the door skips it too", async () => {
    const event = await seedEvent("Retreat", { autoAssign: true })
    await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    const { registrant } = await seedRegistrant(event.id)

    const assigned = await assignBreakoutForRegistrant(
      registrant.id,
      event.id,
      null,
      NO_PROFILE,
      false,
      { occurrenceId: null }
    )

    expect(assigned).toBeNull()
  })

  it("HONOURS an explicit pick of a held-back group", async () => {
    // The whole difference from `isEnabled`. A disabled group refuses a submitted
    // pick outright; this one accepts it, because a pick is somebody choosing and
    // the setting only suppresses the system choosing.
    const event = await seedEvent()
    const reserve = await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    const { registrant } = await seedRegistrant(event.id)

    const assigned = await assignBreakoutForRegistrant(
      registrant.id,
      event.id,
      reserve.id,
      NO_PROFILE
    )

    expect(assigned?.id).toBe(reserve.id)
    expect(
      await db.breakoutGroupMember.count({ where: { breakoutGroupId: reserve.id } })
    ).toBe(1)
  })

  it("honours an explicit pick at the door as well", async () => {
    const event = await seedEvent()
    const reserve = await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    const { registrant } = await seedRegistrant(event.id)

    const assigned = await assignBreakoutForRegistrant(
      registrant.id,
      event.id,
      reserve.id,
      NO_PROFILE,
      false,
      { occurrenceId: null }
    )

    expect(assigned?.id).toBe(reserve.id)
  })
})

// ─── The kiosk: no card, but the list is still there ──────────────────────────

describe("getCheckinBreakoutChoices", () => {
  it("returns no suggestion but still offers the group", async () => {
    const event = await seedEvent()
    const reserve = await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    const { registrant } = await seedRegistrant(event.id)

    const result = await getCheckinBreakoutChoices(registrant.id, event.id, null)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data?.suggested).toBeNull()
    expect(result.data?.options.map((o) => o.id)).toEqual([reserve.id])
    // Not a gated-empty state — there is something to pick, so nothing to explain.
    expect(result.data?.notice).toBeNull()
    expect(result.data?.hasCandidates).toBe(true)
  })

  it("suggests the open table while still listing the held-back one", async () => {
    const event = await seedEvent()
    const reserve = await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    const open = await seedGroup(event.id, "Open")
    const { registrant } = await seedRegistrant(event.id)

    const result = await getCheckinBreakoutChoices(registrant.id, event.id, null)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data?.suggested?.id).toBe(open.id)
    expect(result.data?.options.map((o) => o.id).sort()).toEqual([reserve.id, open.id].sort())
  })
})

// ─── The deliberate hole: admins place people by hand ─────────────────────────

describe("admin placement into a held-back group", () => {
  it("still adds registrants", async () => {
    // This is the route the setting exists to preserve — the table is filled by
    // hand, so the hand had better still work.
    const event = await seedEvent()
    const reserve = await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    const { registrant } = await seedRegistrant(event.id)

    const result = await addRegistrantsToBreakout(reserve.id, [registrant.id], {
      eventId: event.id,
    })

    expect(result.success).toBe(true)
    expect(
      await db.breakoutGroupMember.count({ where: { breakoutGroupId: reserve.id } })
    ).toBe(1)
  })
})

// ─── The pairing that leaves nobody placed and nobody asked ───────────────────

describe("the form builder's warning", () => {
  it("counts a held-back group as offerable but not as auto-assignable", async () => {
    // The two figures come apart exactly here, and that is the point of having
    // both: `isEnabled` moves the offer and the placement together, this splits
    // them.
    const event = await seedEvent()
    await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    await seedGroup(event.id, "Open")

    const readiness = await breakoutPickerReadiness(event.id)

    expect(readiness.enabledGroups).toBe(2)
    expect(readiness.autoAssignableGroups).toBe(1)
  })

  it("names the dead end when auto-assign is on and every group is held back", async () => {
    // Each switch is reasonable alone; together they suppress the step in favour
    // of a placement that cannot happen. Nobody is placed and nobody is asked.
    const event = await seedEvent("Retreat", { autoAssign: true })
    await seedGroup(event.id, "Reserve A", { manualAssignOnly: true })
    await seedGroup(event.id, "Reserve B", { manualAssignOnly: true })

    const prerequisites = await eventFormPrerequisites(event.id, true)

    expect(prerequisites.sectionBreakout?.message).toContain("manual assignment only")
    expect(prerequisites.sectionBreakout?.message).toContain("nobody is placed either")
  })

  it("keeps the ordinary auto-assign warning while one group is still placeable", async () => {
    const event = await seedEvent("Retreat", { autoAssign: true })
    await seedGroup(event.id, "Reserve", { manualAssignOnly: true })
    await seedGroup(event.id, "Open")

    const prerequisites = await eventFormPrerequisites(event.id, true)

    expect(prerequisites.sectionBreakout?.message).toContain("placed into a breakout group on submit")
    expect(prerequisites.sectionBreakout?.message).not.toContain("manual assignment only")
  })

  it("says nothing about it when auto-assign is off — held back is then just a table", async () => {
    // Nothing is being suppressed, so there is no dead end to name. (The door's
    // unstaffed-group notice still fires here; it is about facilitators and has
    // nothing to do with this setting.)
    const event = await seedEvent()
    await seedGroup(event.id, "Reserve", { manualAssignOnly: true })

    const prerequisites = await eventFormPrerequisites(event.id, false)

    expect(prerequisites.sectionBreakout?.message ?? "").not.toContain(
      "manual assignment only"
    )
  })
})
