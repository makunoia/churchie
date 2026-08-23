/**
 * Pure matching logic used by both server and client.
 * Hardcoded to Gender / Age / Capacity — distinct from the weighted matching
 * engine in lib/matching (which is admin-facing and configurable).
 */

import type { Gender, GenderFocus } from "@/app/generated/prisma/client"
import { breakoutOccupancy, type BreakoutOccupancy, type CapacityInput } from "@/lib/breakouts/occupancy"
import { genderFocusAccepts } from "@/lib/breakouts/gender-focus"
import { scoreLifeStage, scoreLifeStageDetailed } from "@/lib/matching/scorers"

/**
 * Capacity arrives here already reduced to `isFull` + `fillLevel` so the raw
 * headcount never has to be shipped to a browser that isn't allowed to see it.
 * `occupancy` carries the numbers, and is null on the public registration form
 * — see `withoutOccupancy`.
 */
export type BreakoutCandidate = {
  id: string
  name: string
  genderFocus: GenderFocus | null
  /**
   * The life stages this group accepts. Empty means it accepts everyone, the
   * same convention the matching engine's `lifeStageIds` uses.
   */
  lifeStageIds: string[]
  ageRangeMin: number | null
  ageRangeMax: number | null
  /** Derived server-side via `breakoutOccupancy`. */
  isFull: boolean
  /**
   * How full this group is next to the others offered alongside it: 0 is empty,
   * 1 is as full as the set gets. Ordering is all it is ever used for.
   *
   * It replaces `roomRatio` (share of the *cap* still open), which was `null`
   * whenever a group had no `memberLimit` — and a day whose tables are created
   * without limits is the common case, not the exception. Every uncapped group
   * therefore scored identically, the sort was stable, and the first table
   * created absorbed every single registrant. `fillLevel` is defined for capped
   * and uncapped groups alike; `resolveFillLevels` on the server is where the
   * two are put on one scale.
   *
   * Deliberately a *ratio*, never a headcount: it survives `withoutOccupancy`,
   * so the public form can order by it without learning how many people are in
   * any group — the distinction `breakout-occupancy-visibility` pins.
   */
  fillLevel: number
  /**
   * Held back for manual assignment: never *suggested*, never auto-assigned,
   * still fully pickable.
   *
   * The one field on a candidate that divides `suggestBreakoutGroup` from
   * `breakoutPickerOptions`, and the reason it lives here rather than in a
   * `where` clause the way `isEnabled` does — both functions are fed by one
   * loaded set, so a query-level filter would take the group out of the browse
   * list too, which is exactly what `isEnabled` already does and what this
   * setting exists to avoid.
   */
  manualAssignOnly: boolean
  /** Raw counts — staffed surfaces only. `null` on the public form. */
  occupancy: CapacityInput | null
}

export type RegistrantProfile = {
  gender: Gender | null
  birthYear: number | null
  /**
   * Optional because most surfaces never asked. An absent life stage is treated
   * as unknown — it never rules a group out — so a form without the Life Stage
   * field behaves exactly as it did before this existed.
   */
  lifeStageId?: string | null
}

/**
 * Does this group's life-stage focus admit the person?
 *
 * Only a *known* mismatch excludes: a group that declares no life stages accepts
 * everyone, and a person who was never asked is not turned away. That is the
 * same rule `scoreLifeStage` encodes for the matching engine, reused here rather
 * than restated so the public form and the admin surfaces can't drift.
 *
 * Note this is more forgiving than the gender rule in `isEligible`, which does
 * exclude on unknown. The asymmetry is intentional: gender is a hard boundary
 * that a person can see they're on the wrong side of, whereas life stage is
 * frequently left unasked, and applying gender's strictness to it would delete
 * the suggested-group card on most events.
 */
export function lifeStageAccepts(
  groupLifeStageIds: string[],
  candidateLifeStageId: string | null
): boolean {
  return scoreLifeStage(candidateLifeStageId, groupLifeStageIds) !== 0.0
}

function ageFromBirthYear(birthYear: number | null): number | null {
  if (birthYear == null) return null
  return new Date().getUTCFullYear() - birthYear
}

function isEligible(group: BreakoutCandidate, p: RegistrantProfile): boolean {
  // The table exists but is filled by hand. A suggestion is the system pushing
  // someone somewhere, so it never names this one — and `assignBreakoutForRegistrant`
  // auto-assigns through exactly this function, so the same rule covers both.
  // `breakoutPickerOptions` still offers it, deliberately.
  if (group.manualAssignOnly) return false

  // A *suggestion* never points at a full group, even though the browse list
  // now lets a staffed operator pick one deliberately.
  if (group.isFull) return false

  if (group.genderFocus && group.genderFocus !== "Mixed") {
    if (!p.gender || group.genderFocus !== p.gender) return false
  }

  if (!lifeStageAccepts(group.lifeStageIds, p.lifeStageId ?? null)) return false

  const age = ageFromBirthYear(p.birthYear)
  if (group.ageRangeMin != null || group.ageRangeMax != null) {
    if (age == null) return false
    if (group.ageRangeMin != null && age < group.ageRangeMin) return false
    if (group.ageRangeMax != null && age > group.ageRangeMax) return false
  }

  return true
}

/**
 * How narrowly a group targets a particular person — gendered, life-staged and
 * age-ranged groups are more specific than open ones.
 *
 * This used to be the whole ranking, with room-to-spare as a fractional
 * afterthought worth at most a third of the gender bonus. That ordering is the
 * reason placement never spread: every registrant of a given profile saw the
 * same most-specific group at the top of the list, and picked it, until it
 * filled. Specificity is now the *tie-break* — see `byEmptiestThenSpecific`.
 */
function specificity(group: BreakoutCandidate): number {
  let s = 0
  if (group.genderFocus && group.genderFocus !== "Mixed") s += 2
  if (group.lifeStageIds.length > 0) s += 2
  if (group.ageRangeMin != null || group.ageRangeMax != null) s += 1
  return s
}

/**
 * The order every eligible group is offered in: emptiest first.
 *
 * Everything reaching this comparator already fits the person — gender, life
 * stage, age and capacity are filters, applied before ranking — so what's left
 * to decide is *which* of the groups that fit them should absorb the next
 * arrival, and the answer is the one carrying the fewest people so far. That is
 * what makes the suggested group rotate as a day fills instead of naming the
 * same table to everyone.
 *
 * Specificity breaks ties, so among equally empty groups a gendered or
 * life-staged one still wins over a catch-all.
 */
function byEmptiestThenSpecific(a: BreakoutCandidate, b: BreakoutCandidate): number {
  return a.fillLevel - b.fillLevel || specificity(b) - specificity(a)
}

/**
 * Does this group run for the life stage the person actually gave?
 *
 * `scoreLifeStageDetailed` already draws exactly this line — `known` is false
 * when either side has nothing to say, and 1.0 is a listed match — so the rule
 * is reused rather than restated. Note it is *stricter* than `lifeStageAccepts`
 * above, which passes on unknown because it decides eligibility; this decides
 * ranking, where an unknown is no reason to promote anything.
 */
function isKnownLifeStageMatch(
  group: BreakoutCandidate,
  profile: { lifeStageId?: string | null }
): boolean {
  const { score, known } = scoreLifeStageDetailed(profile.lifeStageId ?? null, group.lifeStageIds)
  return known && score === 1.0
}

/**
 * The comparator for one particular person — emptiest-first, unless gender is
 * missing, in which case a life-stage match leads.
 *
 * Gender is the most decisive thing we ask, and when it is absent (a form that
 * never asked, a person who skipped it) `isEligible` has nothing to narrow with:
 * every gendered table is already excluded and what remains is ranked purely by
 * how full it is, ignoring a life stage we may well know exactly. Life stage is
 * the next-best signal we hold, so in gender's absence it takes over the primary
 * sort and fullness moves down to deciding between the tables that match.
 *
 * Deliberately conditional on gender being unknown rather than applied always.
 * When gender *is* known it has already done the discriminating, and the
 * emptiest-first rule there is load-bearing: specificity used to outrank
 * capacity outright, so the most specific table won every single arrival until
 * it filled. Promoting life stage unconditionally would reintroduce that for
 * life-staged tables.
 *
 * One consequence is accepted rather than fixed: where exactly one *uncapped*
 * table matches a life stage, everyone of that life stage stacks into it — the
 * shape of the old `roomRatio` bug. Here it is the right answer (it is the only
 * table for them), `isFull` still gates a capped one, and as soon as a second
 * matching table exists `fillLevel` rotates between them again.
 */
function comparatorFor(
  profile?: { gender: Gender | null; lifeStageId?: string | null }
): (a: BreakoutCandidate, b: BreakoutCandidate) => number {
  const lifeStageDecides = profile != null && profile.gender == null
  if (!lifeStageDecides) return byEmptiestThenSpecific
  return (a, b) =>
    Number(isKnownLifeStageMatch(b, profile)) - Number(isKnownLifeStageMatch(a, profile)) ||
    byEmptiestThenSpecific(a, b)
}

export type BreakoutPickerOption = BreakoutCandidate & {
  /** Rendered occupancy. `null` when the counts weren't shipped to this surface. */
  occupancyView: BreakoutOccupancy | null
}

/**
 * Drops the raw headcounts, keeping the derived `isFull` / `roomRatio` the
 * picker and the suggester actually need.
 *
 * The public registration form calls this. Occupancy is an admin-facing
 * operational number: a registrant choosing a group has no business knowing how
 * many people are in it, and until this existed the counts were sitting in the
 * public form's RSC payload — unrendered, but there for anyone who looked.
 * Whether a group is *full* is still surfaced, because that's a boolean about
 * the choice in front of them rather than an occupancy figure.
 */
export function withoutOccupancy(groups: BreakoutCandidate[]): BreakoutCandidate[] {
  return groups.map((g) => ({ ...g, occupancy: null }))
}

/**
 * The groups a registrant may browse, emptiest first.
 *
 * Gender and life stage are the criteria applied here, and each only when it is
 * *known*: a men's breakout group is not something a woman can join, so offering
 * it is a dead end she can walk into, and the same holds for a table run for a
 * life stage that isn't hers. Everything else — age, capacity — is surfaced
 * rather than applied, because those are soft preferences and a full group still
 * renders marked so it doesn't look like it vanished.
 *
 * When gender or life stage is absent (blank, or the form never asked) that
 * criterion filters nothing. An earlier version filtered on age and on missing
 * gender too, which meant a registrant who wasn't asked saw every gendered and
 * age-ranged group disappear: missing data read as a mismatch and the list could
 * empty out entirely.
 *
 * The order is the same rule the suggested group is chosen by — `comparatorFor`,
 * profile and all — so someone who opens the dropdown to look past the
 * suggestion still meets the groups with the most room at the top rather than
 * whichever was created first, and the two can never disagree about which group
 * leads. That includes the life-stage fallback: pass the profile or the ordering
 * silently reverts to plain emptiest-first.
 *
 * Pass the *effective* focus — `fetchBreakoutCandidates` already resolves it
 * through `deriveEffectiveGenderFocus`, so a group whose focus is only implied
 * by its facilitator filters the same way an explicit one does.
 *
 * `manualAssignOnly` is deliberately *not* applied here, and it is the one place
 * this list and `suggestBreakoutGroup` are meant to disagree: a group held back
 * for manual assignment is one the system won't push anyone into, not one nobody
 * may choose. It also keeps its rank — it is a real table holding real people,
 * so hiding it from `fillLevel` would distort the ordering of the rest.
 */
export function breakoutPickerOptions(
  groups: BreakoutCandidate[],
  profile?: { gender: Gender | null; lifeStageId?: string | null }
): BreakoutPickerOption[] {
  return groups
    .filter(
      (g) =>
        genderFocusAccepts(g.genderFocus, profile?.gender ?? null) &&
        lifeStageAccepts(g.lifeStageIds, profile?.lifeStageId ?? null)
    )
    .slice()
    .sort(comparatorFor(profile))
    .map((g) => ({
      ...g,
      occupancyView: g.occupancy ? breakoutOccupancy(g.occupancy) : null,
    }))
}

export function suggestBreakoutGroup(
  groups: BreakoutCandidate[],
  profile: RegistrantProfile
): BreakoutCandidate | null {
  const eligible = groups.filter((g) => isEligible(g, profile))
  if (eligible.length === 0) return null
  return eligible.slice().sort(comparatorFor(profile))[0]
}

/**
 * Why the breakout step is rendering with nothing to choose from.
 *
 * Only `awaiting-facilitator` exists today: the walk-in kiosk offers a group
 * only once its facilitator has checked in, so before the team arrives every
 * group is held back. Left as a union so the next such rule gets its own copy
 * rather than being folded into this one.
 */
export type BreakoutNoticeKind = "awaiting-facilitator"

/**
 * Decides whether an empty breakout list is worth explaining.
 *
 * The distinction that matters is "no groups exist" (nothing to say — drop the
 * step) versus "groups exist but all are gated" (say so). Dropping the step in
 * the second case is what made an enabled Breakout toggle look like it did
 * nothing on the walk-in form.
 */
export function resolveBreakoutNotice(opts: {
  offerPicker: boolean
  candidateCount: number
  totalGroups: number
}): BreakoutNoticeKind | null {
  if (!opts.offerPicker) return null
  if (opts.candidateCount > 0) return null
  return opts.totalGroups > 0 ? "awaiting-facilitator" : null
}
