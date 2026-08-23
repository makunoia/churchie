import { describe, it, expect } from "vitest"
import {
  suggestBreakoutGroup,
  breakoutPickerOptions,
  withoutOccupancy,
  type BreakoutCandidate,
} from "@/lib/breakout-suggestion"
import { breakoutOccupancy } from "@/lib/breakouts/occupancy"

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Tests still express capacity as the raw `memberCount` / `memberLimit` pair —
 * that's how a group is actually configured. The reduction to `isFull` /
 * `fillLevel` (which is what `BreakoutCandidate` now carries, so the numbers
 * needn't be shipped to a public registrant) happens here, exactly as the server
 * mapper does it.
 *
 * `fillLevel` defaults to the group's own fill ratio, and to 0 when uncapped.
 * The real scale is set across a whole *set* of groups by `resolveFillLevels`,
 * which one group in isolation can't reproduce — ordering tests pass it
 * explicitly instead.
 */
function makeGroup(
  overrides: Partial<Omit<BreakoutCandidate, "isFull" | "occupancy">> & {
    memberLimit?: number | null
    memberCount?: number
  } = {}
): BreakoutCandidate {
  const { memberLimit = null, memberCount = 0, ...rest } = overrides
  const occupancy = breakoutOccupancy({ memberCount, memberLimit })
  return {
    id: "g1",
    name: "Group",
    genderFocus: null,
    lifeStageIds: [],
    ageRangeMin: null,
    ageRangeMax: null,
    manualAssignOnly: false,
    isFull: occupancy.isFull,
    fillLevel: memberLimit == null || memberLimit === 0 ? 0 : memberCount / memberLimit,
    occupancy: { memberCount, memberLimit },
    ...rest,
  }
}

const CURRENT_YEAR = new Date().getUTCFullYear()

// ─── suggestBreakoutGroup ─────────────────────────────────────────────────────

describe("suggestBreakoutGroup", () => {
  describe("gender filtering", () => {
    it("suggests a null-genderFocus group to a male participant", () => {
      const group = makeGroup({ genderFocus: null })
      const result = suggestBreakoutGroup([group], { gender: "Male", birthYear: null })
      expect(result?.id).toBe("g1")
    })

    it("suggests a null-genderFocus group to a female participant", () => {
      const group = makeGroup({ genderFocus: null })
      const result = suggestBreakoutGroup([group], { gender: "Female", birthYear: null })
      expect(result?.id).toBe("g1")
    })

    it("suggests a null-genderFocus group when participant gender is unknown", () => {
      const group = makeGroup({ genderFocus: null })
      const result = suggestBreakoutGroup([group], { gender: null, birthYear: null })
      expect(result?.id).toBe("g1")
    })

    it("suggests a Mixed group to a male participant", () => {
      const group = makeGroup({ genderFocus: "Mixed" })
      const result = suggestBreakoutGroup([group], { gender: "Male", birthYear: null })
      expect(result?.id).toBe("g1")
    })

    it("suggests a Mixed group to a female participant", () => {
      const group = makeGroup({ genderFocus: "Mixed" })
      const result = suggestBreakoutGroup([group], { gender: "Female", birthYear: null })
      expect(result?.id).toBe("g1")
    })

    it("suggests a Mixed group when participant gender is unknown", () => {
      const group = makeGroup({ genderFocus: "Mixed" })
      const result = suggestBreakoutGroup([group], { gender: null, birthYear: null })
      // Mixed is treated the same as null — eligible for everyone
      expect(result?.id).toBe("g1")
    })

    it("suggests a Male-focused group to a male participant", () => {
      const group = makeGroup({ genderFocus: "Male" })
      const result = suggestBreakoutGroup([group], { gender: "Male", birthYear: null })
      expect(result?.id).toBe("g1")
    })

    it("excludes a Male-focused group from a female participant", () => {
      const group = makeGroup({ genderFocus: "Male" })
      const result = suggestBreakoutGroup([group], { gender: "Female", birthYear: null })
      expect(result).toBeNull()
    })

    it("excludes a Female-focused group from a male participant", () => {
      const group = makeGroup({ genderFocus: "Female" })
      const result = suggestBreakoutGroup([group], { gender: "Male", birthYear: null })
      expect(result).toBeNull()
    })

    it("excludes a Female-focused group when participant gender is unknown", () => {
      // A participant who didn't select a gender cannot be placed in a gendered group
      const group = makeGroup({ genderFocus: "Female" })
      const result = suggestBreakoutGroup([group], { gender: null, birthYear: null })
      expect(result).toBeNull()
    })

    it("excludes a Male-focused group when participant gender is unknown", () => {
      const group = makeGroup({ genderFocus: "Male" })
      const result = suggestBreakoutGroup([group], { gender: null, birthYear: null })
      expect(result).toBeNull()
    })

    it("returns null when ALL groups are Female-focused and participant is Male", () => {
      // This is the scenario the admin hit: they set genderFocus on every group
      // but none are Male or Mixed
      const groups = [
        makeGroup({ id: "g1", genderFocus: "Female" }),
        makeGroup({ id: "g2", genderFocus: "Female" }),
        makeGroup({ id: "g3", genderFocus: "Female" }),
      ]
      const result = suggestBreakoutGroup(groups, { gender: "Male", birthYear: null })
      expect(result).toBeNull()
    })

    it("returns null when ALL groups are Female-focused and participant gender is unknown", () => {
      const groups = [
        makeGroup({ id: "g1", genderFocus: "Female" }),
        makeGroup({ id: "g2", genderFocus: "Female" }),
      ]
      const result = suggestBreakoutGroup(groups, { gender: null, birthYear: null })
      expect(result).toBeNull()
    })

    it("picks the Male group (not Female) when both exist and participant is Male", () => {
      const maleGroup = makeGroup({ id: "male", genderFocus: "Male" })
      const femaleGroup = makeGroup({ id: "female", genderFocus: "Female" })
      const result = suggestBreakoutGroup([maleGroup, femaleGroup], { gender: "Male", birthYear: null })
      expect(result?.id).toBe("male")
    })
  })

  describe("age filtering", () => {
    it("suggests a group with a matching age range", () => {
      const group = makeGroup({ ageRangeMin: 20, ageRangeMax: 30 })
      const birthYear = CURRENT_YEAR - 25
      const result = suggestBreakoutGroup([group], { gender: null, birthYear })
      expect(result?.id).toBe("g1")
    })

    it("excludes a group when participant is too young", () => {
      const group = makeGroup({ ageRangeMin: 30, ageRangeMax: 40 })
      const birthYear = CURRENT_YEAR - 20
      const result = suggestBreakoutGroup([group], { gender: null, birthYear })
      expect(result).toBeNull()
    })

    it("excludes a group when participant is too old", () => {
      const group = makeGroup({ ageRangeMin: 18, ageRangeMax: 25 })
      const birthYear = CURRENT_YEAR - 35
      const result = suggestBreakoutGroup([group], { gender: null, birthYear })
      expect(result).toBeNull()
    })

    it("excludes an age-restricted group when participant has no birth year", () => {
      const group = makeGroup({ ageRangeMin: 20, ageRangeMax: 30 })
      const result = suggestBreakoutGroup([group], { gender: null, birthYear: null })
      expect(result).toBeNull()
    })

    it("suggests a group with only a minimum age when participant is old enough", () => {
      const group = makeGroup({ ageRangeMin: 18, ageRangeMax: null })
      const birthYear = CURRENT_YEAR - 25
      const result = suggestBreakoutGroup([group], { gender: null, birthYear })
      expect(result?.id).toBe("g1")
    })

    it("suggests a group with only a maximum age when participant is young enough", () => {
      const group = makeGroup({ ageRangeMin: null, ageRangeMax: 35 })
      const birthYear = CURRENT_YEAR - 25
      const result = suggestBreakoutGroup([group], { gender: null, birthYear })
      expect(result?.id).toBe("g1")
    })
  })

  describe("capacity filtering", () => {
    it("excludes a full group from suggestions", () => {
      const group = makeGroup({ memberLimit: 10, memberCount: 10 })
      const result = suggestBreakoutGroup([group], { gender: null, birthYear: null })
      expect(result).toBeNull()
    })

    it("suggests a group that has one slot remaining", () => {
      const group = makeGroup({ memberLimit: 10, memberCount: 9 })
      const result = suggestBreakoutGroup([group], { gender: null, birthYear: null })
      expect(result?.id).toBe("g1")
    })

    it("suggests a group with no limit regardless of member count", () => {
      const group = makeGroup({ memberLimit: null, memberCount: 999 })
      const result = suggestBreakoutGroup([group], { gender: null, birthYear: null })
      expect(result?.id).toBe("g1")
    })
  })

  // Specificity is the tie-break now, not the ranking. Every group in this block
  // is equally empty (`memberCount` defaults to 0), which is what lets it decide.
  describe("scoring — prefers specific over generic among equally empty groups", () => {
    it("prefers a gendered group over a null-genderFocus group for the same participant", () => {
      const specific = makeGroup({ id: "specific", genderFocus: "Male" })
      const generic = makeGroup({ id: "generic", genderFocus: null })
      const result = suggestBreakoutGroup([generic, specific], { gender: "Male", birthYear: null })
      expect(result?.id).toBe("specific")
    })

    it("prefers a group with an age range over one with no age range", () => {
      const withAge = makeGroup({ id: "withAge", ageRangeMin: 20, ageRangeMax: 35 })
      const withoutAge = makeGroup({ id: "withoutAge", ageRangeMin: null, ageRangeMax: null })
      const birthYear = CURRENT_YEAR - 25
      const result = suggestBreakoutGroup([withoutAge, withAge], { gender: null, birthYear })
      expect(result?.id).toBe("withAge")
    })

    it("returns the only eligible group even if it is generic", () => {
      const groups = [
        makeGroup({ id: "open", genderFocus: null }),
        makeGroup({ id: "female", genderFocus: "Female" }),
      ]
      const result = suggestBreakoutGroup(groups, { gender: "Male", birthYear: null })
      expect(result?.id).toBe("open")
    })
  })

  describe("life stage filtering", () => {
    it("excludes a group whose life stages don't include the participant's", () => {
      const group = makeGroup({ lifeStageIds: ["singles"] })
      const result = suggestBreakoutGroup([group], {
        gender: null,
        birthYear: null,
        lifeStageId: "married",
      })
      expect(result).toBeNull()
    })

    it("includes a group whose life stages contain the participant's", () => {
      const group = makeGroup({ lifeStageIds: ["singles", "young-pro"] })
      const result = suggestBreakoutGroup([group], {
        gender: null,
        birthYear: null,
        lifeStageId: "young-pro",
      })
      expect(result?.id).toBe("g1")
    })

    it("keeps a life-stage-specific group when the participant's stage is unknown", () => {
      // Unlike gender, an unasked life stage is never read as a mismatch — doing
      // so would delete the suggestion on every form that doesn't ask.
      const group = makeGroup({ lifeStageIds: ["singles"] })
      expect(
        suggestBreakoutGroup([group], { gender: null, birthYear: null, lifeStageId: null })?.id
      ).toBe("g1")
      expect(suggestBreakoutGroup([group], { gender: null, birthYear: null })?.id).toBe("g1")
    })

    it("keeps a group that declares no life stages for any participant", () => {
      const group = makeGroup({ lifeStageIds: [] })
      const result = suggestBreakoutGroup([group], {
        gender: null,
        birthYear: null,
        lifeStageId: "married",
      })
      expect(result?.id).toBe("g1")
    })

    it("prefers a life-stage-specific group over a catch-all when both are empty", () => {
      const specific = makeGroup({ id: "specific", lifeStageIds: ["singles"] })
      const catchAll = makeGroup({ id: "catch-all", lifeStageIds: [] })
      const result = suggestBreakoutGroup([catchAll, specific], {
        gender: null,
        birthYear: null,
        lifeStageId: "singles",
      })
      expect(result?.id).toBe("specific")
    })
  })

  describe("ranking — emptiest first", () => {
    const anyone = { gender: null, birthYear: null }

    it("suggests the group with the most room, not the one created first", () => {
      const groups = [
        makeGroup({ id: "first", fillLevel: 0.8 }),
        makeGroup({ id: "roomy", fillLevel: 0.1 }),
      ]
      expect(suggestBreakoutGroup(groups, anyone)?.id).toBe("roomy")
    })

    it("moves on once the emptiest group fills up", () => {
      // The rotation the whole feature exists for: same profile, different day
      // state, different answer.
      const early = [
        makeGroup({ id: "a", fillLevel: 0 }),
        makeGroup({ id: "b", fillLevel: 0 }),
      ]
      expect(suggestBreakoutGroup(early, anyone)?.id).toBe("a")

      const later = [
        makeGroup({ id: "a", fillLevel: 0.9 }),
        makeGroup({ id: "b", fillLevel: 0.2 }),
      ]
      expect(suggestBreakoutGroup(later, anyone)?.id).toBe("b")
    })

    it("lets emptiness outrank specificity", () => {
      // The reversal from the old scoring, stated outright: a gendered group used
      // to win by +2 against a capacity term worth at most 1, so it took every
      // arrival until it was full.
      const gendered = makeGroup({ id: "gendered", genderFocus: "Male", fillLevel: 0.9 })
      const open = makeGroup({ id: "open", genderFocus: null, fillLevel: 0.1 })
      expect(suggestBreakoutGroup([gendered, open], { gender: "Male", birthYear: null })?.id).toBe(
        "open"
      )
    })

    it("never suggests a full group, however empty it would rank", () => {
      const groups = [
        makeGroup({ id: "full", memberLimit: 4, memberCount: 4, fillLevel: 0 }),
        makeGroup({ id: "open", fillLevel: 0.9 }),
      ]
      expect(suggestBreakoutGroup(groups, anyone)?.id).toBe("open")
    })
  })

  describe("manual assignment only", () => {
    // The whole point of the setting: the suggester and the dropdown are fed by
    // one candidate set, and this is the one field they are meant to disagree
    // about. `assignBreakoutForRegistrant` auto-assigns through this same
    // function, so these cases pin auto-assign's behaviour too.
    it("is never suggested, even as the only candidate", () => {
      const groups = [makeGroup({ id: "reserve", manualAssignOnly: true })]
      expect(suggestBreakoutGroup(groups, { gender: null, birthYear: null })).toBeNull()
    })

    it("is skipped over in favour of the next-best table", () => {
      // The emptiest table is the held-back one, so a suggester that ignored the
      // flag would name it. The answer is the fuller table that is still in play.
      const groups = [
        makeGroup({ id: "reserve", fillLevel: 0.0, manualAssignOnly: true }),
        makeGroup({ id: "open", fillLevel: 0.8 }),
      ]
      expect(suggestBreakoutGroup(groups, { gender: null, birthYear: null })?.id).toBe("open")
    })

    it("does not suppress a suggestion when some other table qualifies", () => {
      const groups = [
        makeGroup({ id: "reserve", manualAssignOnly: true }),
        makeGroup({ id: "a", fillLevel: 0.3 }),
        makeGroup({ id: "b", fillLevel: 0.5 }),
      ]
      expect(suggestBreakoutGroup(groups, { gender: "Male", birthYear: 1995 })?.id).toBe("a")
    })
  })

  describe("empty / edge cases", () => {
    it("returns null when no groups are provided", () => {
      expect(suggestBreakoutGroup([], { gender: "Male", birthYear: null })).toBeNull()
    })

    it("returns null when no group passes all filters", () => {
      const groups = [
        makeGroup({ id: "g1", genderFocus: "Female", memberLimit: 5, memberCount: 5 }),
        makeGroup({ id: "g2", genderFocus: "Male", ageRangeMin: 30 }),
      ]
      // Female participant, age 20 → g1 is full, g2 is wrong gender
      const result = suggestBreakoutGroup(groups, {
        gender: "Female",
        birthYear: CURRENT_YEAR - 20,
      })
      expect(result).toBeNull()
    })
  })
})

// ─── breakoutPickerOptions ────────────────────────────────────────────────────

describe("breakoutPickerOptions", () => {
  describe("gender filtering", () => {
    // A men's breakout group is not something a woman can join, so listing it is
    // a dead end she can walk into.
    it("hides groups focused on the other gender", () => {
      const groups = [
        makeGroup({ id: "male-g", genderFocus: "Male" }),
        makeGroup({ id: "female-g", genderFocus: "Female" }),
      ]
      expect(breakoutPickerOptions(groups, { gender: "Female" }).map((g) => g.id)).toEqual([
        "female-g",
      ])
    })

    it("keeps Mixed and unset-focus groups for either gender", () => {
      const groups = [
        makeGroup({ id: "mixed-g", genderFocus: "Mixed" }),
        makeGroup({ id: "open-g", genderFocus: null }),
      ]
      expect(breakoutPickerOptions(groups, { gender: "Male" }).map((g) => g.id)).toEqual([
        "mixed-g",
        "open-g",
      ])
      expect(breakoutPickerOptions(groups, { gender: "Female" }).map((g) => g.id)).toEqual([
        "mixed-g",
        "open-g",
      ])
    })

    // The regression this pins: filtering on a *missing* gender made every
    // gendered group disappear for a registrant the form never asked, which
    // could empty the dropdown entirely.
    it("filters nothing when gender is unknown", () => {
      const groups = [
        makeGroup({ id: "male-g", genderFocus: "Male" }),
        makeGroup({ id: "female-g", genderFocus: "Female" }),
        makeGroup({ id: "mixed-g", genderFocus: "Mixed" }),
      ]
      expect(breakoutPickerOptions(groups, { gender: null }).map((g) => g.id)).toEqual([
        "male-g",
        "female-g",
        "mixed-g",
      ])
    })

    it("filters nothing when no profile is passed at all", () => {
      const groups = [
        makeGroup({ id: "male-g", genderFocus: "Male" }),
        makeGroup({ id: "female-g", genderFocus: "Female" }),
      ]
      expect(breakoutPickerOptions(groups).map((g) => g.id)).toEqual(["male-g", "female-g"])
    })

    it("can filter down to nothing when every group is for the other gender", () => {
      const groups = [makeGroup({ id: "male-g", genderFocus: "Male" })]
      expect(breakoutPickerOptions(groups, { gender: "Female" })).toEqual([])
    })
  })

  // Age and capacity stay surfaced rather than applied — they are soft, and a
  // registrant who answered an age bucket instead of a birth year would lose
  // every age-ranged group for no good reason.
  it("keeps age-restricted groups when the registrant has no birth year", () => {
    const groups = [
      makeGroup({ id: "ranged", ageRangeMin: 20, ageRangeMax: 30 }),
      makeGroup({ id: "open", ageRangeMin: null, ageRangeMax: null }),
    ]
    expect(breakoutPickerOptions(groups).map((g) => g.id)).toEqual(["ranged", "open"])
  })

  it("keeps a group whose age range excludes the registrant outright", () => {
    const groups = [makeGroup({ id: "seniors", ageRangeMin: 60, ageRangeMax: 80 })]
    expect(breakoutPickerOptions(groups)).toHaveLength(1)
  })

  describe("life stage filtering", () => {
    it("hides groups run for a different life stage", () => {
      const groups = [
        makeGroup({ id: "singles-g", lifeStageIds: ["singles"] }),
        makeGroup({ id: "married-g", lifeStageIds: ["married"] }),
      ]
      expect(
        breakoutPickerOptions(groups, { gender: null, lifeStageId: "married" }).map((g) => g.id)
      ).toEqual(["married-g"])
    })

    it("keeps a group that accepts several life stages including the registrant's", () => {
      const groups = [makeGroup({ id: "wide", lifeStageIds: ["singles", "married"] })]
      expect(
        breakoutPickerOptions(groups, { gender: null, lifeStageId: "married" }).map((g) => g.id)
      ).toEqual(["wide"])
    })

    // The same regression the gender rule pins, on the other axis: a form that
    // never asked for life stage must not empty the dropdown.
    it("filters nothing when life stage is unknown", () => {
      const groups = [
        makeGroup({ id: "singles-g", lifeStageIds: ["singles"] }),
        makeGroup({ id: "married-g", lifeStageIds: ["married"] }),
      ]
      expect(
        breakoutPickerOptions(groups, { gender: null, lifeStageId: null }).map((g) => g.id)
      ).toEqual(["singles-g", "married-g"])
      expect(breakoutPickerOptions(groups, { gender: null }).map((g) => g.id)).toEqual([
        "singles-g",
        "married-g",
      ])
    })

    it("keeps a group that declares no life stages at all", () => {
      const groups = [makeGroup({ id: "any", lifeStageIds: [] })]
      expect(
        breakoutPickerOptions(groups, { gender: null, lifeStageId: "singles" }).map((g) => g.id)
      ).toEqual(["any"])
    })
  })

  describe("ordering", () => {
    // Was "preserves the order it was given" — the dropdown deliberately re-ranks
    // now, so someone looking past the suggestion still meets the groups with the
    // most room first rather than whichever was created earliest.
    it("lists the emptiest group first, whatever order it was given in", () => {
      const groups = [
        makeGroup({ id: "full-ish", fillLevel: 0.9 }),
        makeGroup({ id: "roomy", fillLevel: 0.1 }),
        makeGroup({ id: "middling", fillLevel: 0.5 }),
      ]
      expect(breakoutPickerOptions(groups).map((g) => g.id)).toEqual([
        "roomy",
        "middling",
        "full-ish",
      ])
    })

    it("agrees with the suggested group about which has the most room", () => {
      // The dropdown and the "Suggested for you" card are ranked by one rule, so
      // the card can never name a group the list has buried.
      const groups = [
        makeGroup({ id: "a", fillLevel: 0.7 }),
        makeGroup({ id: "b", fillLevel: 0.2 }),
      ]
      const profile = { gender: null, birthYear: null }
      expect(breakoutPickerOptions(groups, profile)[0].id).toBe(
        suggestBreakoutGroup(groups, profile)?.id
      )
    })

    // Regression: the dropdown is the half of the split that must NOT change.
    // Filtering `manualAssignOnly` in the candidate query — the obvious way to
    // build this — would take the table out of here too, which is exactly what
    // `isEnabled: false` already does and what the setting exists to avoid.
    it("still offers a manual-only group, in its rightful rank position", () => {
      const groups = [
        makeGroup({ id: "fuller", fillLevel: 0.8 }),
        makeGroup({ id: "reserve", fillLevel: 0.1, manualAssignOnly: true }),
      ]
      // Not merely present — still first, because it really is the emptiest.
      expect(breakoutPickerOptions(groups).map((g) => g.id)).toEqual(["reserve", "fuller"])
    })

    it("offers a manual-only group even when it is the only one", () => {
      const groups = [makeGroup({ id: "reserve", manualAssignOnly: true })]
      const profile = { gender: "Male" as const, birthYear: 1995 }
      // The one case where the card and the dropdown deliberately disagree.
      expect(breakoutPickerOptions(groups, profile).map((g) => g.id)).toEqual(["reserve"])
      expect(suggestBreakoutGroup(groups, profile)).toBeNull()
    })

    it("falls back to specificity when two groups are equally empty", () => {
      const groups = [
        makeGroup({ id: "catch-all", fillLevel: 0.4 }),
        makeGroup({ id: "specific", fillLevel: 0.4, lifeStageIds: ["singles"] }),
      ]
      expect(
        breakoutPickerOptions(groups, { gender: null, lifeStageId: "singles" }).map((g) => g.id)
      ).toEqual(["specific", "catch-all"])
    })

    it("keeps a full group in the list even though it sorts by fullness", () => {
      const groups = [
        makeGroup({ id: "full", memberLimit: 5, memberCount: 5 }),
        makeGroup({ id: "open", fillLevel: 0.5 }),
      ]
      const ids = breakoutPickerOptions(groups).map((g) => g.id)
      expect(ids).toHaveLength(2)
      expect(ids[ids.length - 1]).toBe("full")
    })
  })

  it("marks a group at its member limit as full without removing it", () => {
    const [option] = breakoutPickerOptions([
      makeGroup({ id: "full", memberLimit: 5, memberCount: 5 }),
    ])
    expect(option.id).toBe("full")
    expect(option.isFull).toBe(true)
  })

  it("marks an over-subscribed group as full", () => {
    const [option] = breakoutPickerOptions([makeGroup({ memberLimit: 5, memberCount: 6 })])
    expect(option.isFull).toBe(true)
  })

  it("never marks a group with no member limit as full", () => {
    const [option] = breakoutPickerOptions([makeGroup({ memberLimit: null, memberCount: 99 })])
    expect(option.isFull).toBe(false)
  })

  it("returns an empty list when the event has no groups", () => {
    expect(breakoutPickerOptions([])).toEqual([])
  })
})

// ─── withoutOccupancy ─────────────────────────────────────────────────────────

describe("withoutOccupancy", () => {
  // The public registration form renders this same picker. Occupancy is an
  // admin-facing operational number, and it used to sit in the public page's
  // payload — unrendered, but readable by anyone who opened devtools.
  it("drops the raw headcounts", () => {
    const stripped = withoutOccupancy([makeGroup({ memberLimit: 12, memberCount: 8 })])
    expect(stripped[0].occupancy).toBeNull()
  })

  it("leaves no headcount anywhere in the serialized payload", () => {
    const stripped = withoutOccupancy([
      makeGroup({ id: "a", name: "Alpha", memberLimit: 12, memberCount: 8 }),
      makeGroup({ id: "b", name: "Bravo", memberLimit: null, memberCount: 40 }),
    ])
    const json = JSON.stringify(stripped)
    expect(json).not.toContain("memberCount")
    expect(json).not.toContain("memberLimit")
    expect(json).not.toContain("40")
  })

  it("keeps fullness, which is a fact about the choice rather than an occupancy figure", () => {
    const [full, open] = withoutOccupancy([
      makeGroup({ id: "full", memberLimit: 5, memberCount: 5 }),
      makeGroup({ id: "open", memberLimit: 5, memberCount: 1 }),
    ])
    expect(full.isFull).toBe(true)
    expect(open.isFull).toBe(false)
  })

  it("still suggests the same group once the counts are gone", () => {
    const groups = [
      makeGroup({ id: "roomy", memberLimit: 10, memberCount: 1 }),
      makeGroup({ id: "tight", memberLimit: 10, memberCount: 9 }),
    ]
    const profile = { gender: null, birthYear: null }
    expect(suggestBreakoutGroup(withoutOccupancy(groups), profile)?.id).toBe(
      suggestBreakoutGroup(groups, profile)?.id
    )
  })

  it("still refuses to suggest a full group", () => {
    const stripped = withoutOccupancy([makeGroup({ memberLimit: 5, memberCount: 5 })])
    expect(suggestBreakoutGroup(stripped, { gender: null, birthYear: null })).toBeNull()
  })

  it("gives the picker no occupancy to render", () => {
    const [option] = breakoutPickerOptions(
      withoutOccupancy([makeGroup({ memberLimit: 12, memberCount: 8 })])
    )
    expect(option.occupancyView).toBeNull()
  })

  it("gives a staffed surface the occupancy to render", () => {
    const [option] = breakoutPickerOptions([makeGroup({ memberLimit: 12, memberCount: 8 })])
    expect(option.occupancyView?.label).toBe("8 / 12")
    expect(option.occupancyView?.remaining).toBe(4)
  })
})

// ─── Life stage as gender's stand-in ──────────────────────────────────────────

/**
 * Gender is the most decisive thing the form asks, and when it is missing every
 * gendered table is already gone from the eligible set — so what remains used to
 * be ranked on fullness alone, throwing away a life stage we may well know
 * exactly. In gender's absence life stage leads instead.
 *
 * The inverse matters just as much: with gender known, ordering must be
 * byte-for-byte what it was, because emptiest-first is itself a fix (specificity
 * used to win every arrival until a table filled).
 */
describe("life stage decides when gender is unknown", () => {
  const SINGLES = "ls-singles"
  const MARRIED = "ls-married"

  /** Matching but half full, beside an emptier table that accepts everyone. */
  const matchedButFuller = () => [
    makeGroup({
      id: "open",
      name: "Open Table",
      lifeStageIds: [],
      fillLevel: 0,
    }),
    makeGroup({
      id: "singles",
      name: "Singles Table",
      lifeStageIds: [SINGLES],
      fillLevel: 0.5,
    }),
  ]

  it("prefers a life-stage match over an emptier catch-all", () => {
    const suggestion = suggestBreakoutGroup(matchedButFuller(), {
      gender: null,
      birthYear: null,
      lifeStageId: SINGLES,
    })
    expect(suggestion?.id).toBe("singles")
  })

  it("orders the dropdown the same way, so the two can't disagree", () => {
    const options = breakoutPickerOptions(matchedButFuller(), {
      gender: null,
      lifeStageId: SINGLES,
    })
    expect(options.map((g) => g.id)).toEqual(["singles", "open"])
  })

  it("still rotates between two tables that both match", () => {
    // The fallback promotes a whole tier, not one table. Within the tier
    // `fillLevel` is untouched, which is what keeps a day spreading instead of
    // stacking everyone into the first matching table created.
    const groups = [
      makeGroup({ id: "a", name: "Singles A", lifeStageIds: [SINGLES], fillLevel: 0.6 }),
      makeGroup({ id: "b", name: "Singles B", lifeStageIds: [SINGLES], fillLevel: 0.2 }),
      makeGroup({ id: "open", name: "Open", lifeStageIds: [], fillLevel: 0 }),
    ]
    const profile = { gender: null, birthYear: null, lifeStageId: SINGLES }
    expect(suggestBreakoutGroup(groups, profile)?.id).toBe("b")
    expect(
      breakoutPickerOptions(groups, { gender: null, lifeStageId: SINGLES }).map((g) => g.id)
    ).toEqual(["b", "a", "open"])
  })

  it("leaves the order alone when gender is known", () => {
    // Gender has already done the narrowing here, so the emptiest table wins
    // exactly as it did before the fallback existed.
    const groups = [
      makeGroup({ id: "open", name: "Open", lifeStageIds: [], fillLevel: 0 }),
      makeGroup({ id: "singles", name: "Singles", lifeStageIds: [SINGLES], fillLevel: 0.5 }),
    ]
    expect(
      suggestBreakoutGroup(groups, { gender: "Male", birthYear: null, lifeStageId: SINGLES })?.id
    ).toBe("open")
  })

  it("leaves the order alone when the life stage is unknown too", () => {
    const groups = [
      makeGroup({ id: "open", name: "Open", lifeStageIds: [], fillLevel: 0 }),
      makeGroup({ id: "singles", name: "Singles", lifeStageIds: [SINGLES], fillLevel: 0.5 }),
    ]
    expect(
      suggestBreakoutGroup(groups, { gender: null, birthYear: null, lifeStageId: null })?.id
    ).toBe("open")
  })

  it("promotes only a known match, never a table that merely accepts everyone", () => {
    // A group declaring no life stages accepts the person, but that is an
    // absence of a rule rather than a match, and it must not outrank an emptier
    // table on the strength of it.
    const groups = [
      makeGroup({ id: "open-empty", name: "Open A", lifeStageIds: [], fillLevel: 0 }),
      makeGroup({ id: "open-full", name: "Open B", lifeStageIds: [], fillLevel: 0.9 }),
    ]
    expect(
      suggestBreakoutGroup(groups, { gender: null, birthYear: null, lifeStageId: MARRIED })?.id
    ).toBe("open-empty")
  })

  it("does not promote a table run for a different life stage", () => {
    // `lifeStageAccepts` already excludes it from the suggestion; the dropdown
    // hides it too, so there is nothing left to rank.
    const groups = [
      makeGroup({ id: "open", name: "Open", lifeStageIds: [], fillLevel: 0.8 }),
      makeGroup({ id: "married", name: "Married", lifeStageIds: [MARRIED], fillLevel: 0 }),
    ]
    const profile = { gender: null, birthYear: null, lifeStageId: SINGLES }
    expect(suggestBreakoutGroup(groups, profile)?.id).toBe("open")
    expect(
      breakoutPickerOptions(groups, { gender: null, lifeStageId: SINGLES }).map((g) => g.id)
    ).toEqual(["open"])
  })

  it("keeps the gender boundary hard — a gendered table is still never suggested", () => {
    // The fallback changes ranking, not eligibility. Someone we can't place by
    // gender is still not quietly seated at a men's table because their life
    // stage happened to line up.
    const groups = [
      makeGroup({
        id: "mens-singles",
        name: "Men's Singles",
        genderFocus: "Male",
        lifeStageIds: [SINGLES],
        fillLevel: 0,
      }),
    ]
    expect(
      suggestBreakoutGroup(groups, { gender: null, birthYear: null, lifeStageId: SINGLES })
    ).toBeNull()
  })
})
