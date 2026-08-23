import { unstable_cache } from "next/cache"
import { db } from "@/lib/db"
import { MatchingContext } from "@/app/generated/prisma/client"
import {
  DEFAULT_WEIGHTS,
  DEFAULT_GUEST_COOLDOWN_DAYS,
  BREAKOUT_ACTIVE_WEIGHT_KEYS,
} from "@/lib/validations/matching-weights"
import { deriveEffectiveGenderFocus } from "@/lib/breakouts/gender-focus"
import { AUTO_ASSIGNABLE_BREAKOUT_WHERE } from "@/lib/breakouts/candidate-pool"
import type { BreakoutOwner } from "@/lib/breakouts/owner"
import { scoreGroup, combineCoupleScores } from "./engine"
import { buildStoredScheduleSlot } from "./candidate-schedule"
import { scoreGender, scoreLifeStage, scoreSchedule } from "./scorers"
import { EMPTY_CANDIDATE } from "./types"
import type { CandidateProfile, GroupProfile, MatchResult, WeightConfig, EscalationLevel, TimeSlot } from "./types"

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Rank by score, then break ties toward the more confident match — a 70% built
// on measured data should sit above a 70% built on placeholder 0.5s.
function byScoreThenConfidence(a: MatchResult, b: MatchResult): number {
  return b.totalScore - a.totalScore || b.confidence - a.confidence
}

/**
 * Breakout ranking: score, confidence, then the emptiest group.
 *
 * Capacity used to be a weighted factor, which is what spread auto-assign
 * across groups. It isn't scored for breakouts any more, so without this third
 * key `autoAssignBreakouts` would stack an entire event into whichever group
 * scores highest and leave the rest empty — every candidate with the same
 * profile gets the same ranking. Uncapped groups sort last among equals: a cap
 * is a signal someone sized the table, and an uncapped group can absorb the
 * overflow later.
 */
function byBreakoutRank(a: MatchResult, b: MatchResult): number {
  const openSeats = (r: MatchResult): number =>
    r.groupSummary.memberLimit === null
      ? -1
      : r.groupSummary.memberLimit - r.groupSummary.currentCount
  return (
    b.totalScore - a.totalScore ||
    b.confidence - a.confidence ||
    openSeats(b) - openSeats(a)
  )
}

function buildCandidateFromMember(m: {
  lifeStageId: string | null
  gender: "Male" | "Female" | null
  language: string[]
  birthMonth: number | null
  birthYear: number | null
  ageRangeBucket?: { minAge: number | null; maxAge: number | null } | null
  workCity: string | null
  workIndustry: string | null
  meetingPreference: "Online" | "Hybrid" | "InPerson" | null
  schedulePreferences: { dayOfWeek: number; timeStart: string | null; timeEnd: string | null }[]
}): CandidateProfile {
  return {
    lifeStageId: m.lifeStageId,
    gender: m.gender,
    language: m.language,
    birthMonth: m.birthMonth,
    birthYear: m.birthYear,
    ageRange: m.ageRangeBucket ?? null,
    workCity: m.workCity,
    workIndustry: m.workIndustry,
    meetingPreference: m.meetingPreference,
    scheduleSlots: m.schedulePreferences
      .map((s) => buildStoredScheduleSlot(s.dayOfWeek, s.timeStart, s.timeEnd))
      .filter((s) => s !== null),
  }
}

function buildCandidateFromGuest(g: {
  lifeStageId: string | null
  gender: "Male" | "Female" | null
  language: string[]
  birthMonth: number | null
  birthYear: number | null
  ageRangeBucket?: { minAge: number | null; maxAge: number | null } | null
  workCity: string | null
  workIndustry: string | null
  meetingPreference: "Online" | "Hybrid" | "InPerson" | null
  scheduleDayOfWeek: number | null
  scheduleTimeStart: string | null
  scheduleTimeEnd: string | null
}): CandidateProfile {
  return {
    lifeStageId: g.lifeStageId,
    gender: g.gender,
    language: g.language,
    birthMonth: g.birthMonth,
    birthYear: g.birthYear,
    ageRange: g.ageRangeBucket ?? null,
    workCity: g.workCity,
    workIndustry: g.workIndustry,
    meetingPreference: g.meetingPreference,
    scheduleSlots: slotList(g.scheduleDayOfWeek, g.scheduleTimeStart, g.scheduleTimeEnd),
  }
}

/** 0-or-1 slot from an inline (day, start, end) triple where only day is certain. */
function slotList(
  dayOfWeek: number | null,
  timeStart: string | null,
  timeEnd: string | null
): TimeSlot[] {
  const slot = buildStoredScheduleSlot(dayOfWeek, timeStart, timeEnd)
  return slot ? [slot] : []
}

function buildSmallGroupProfile(
  g: {
    id: string
    name: string
    groupType: "Regular" | "Couples"
    lifeStages: { id: string; name: string }[]
    genderFocus: "Male" | "Female" | "Mixed" | null
    language: string[]
    ageRangeMin: number | null
    ageRangeMax: number | null
    meetingFormat: "Online" | "Hybrid" | "InPerson" | null
    locationCity: string | null
    memberLimit: number | null
    scheduleDayOfWeek: number | null
    scheduleTimeStart: string | null
    scheduleTimeEnd: string | null
    _count: { members: number }
    members: { workIndustry: string | null }[]
  },
  overrideCount?: number,
  overrideIndustries?: string[]
): GroupProfile {
  return {
    id: g.id,
    name: g.name,
    groupType: g.groupType,
    lifeStageIds: g.lifeStages.map((ls) => ls.id),
    lifeStageNames: g.lifeStages.map((ls) => ls.name),
    genderFocus: g.genderFocus,
    language: g.language,
    ageRangeMin: g.ageRangeMin,
    ageRangeMax: g.ageRangeMax,
    meetingFormat: g.meetingFormat,
    locationCity: g.locationCity,
    memberLimit: g.memberLimit,
    currentCount: overrideCount ?? g._count.members,
    memberIndustries:
      overrideIndustries ??
      (g.members.map((m) => m.workIndustry).filter(Boolean) as string[]),
    scheduleSlots: slotList(g.scheduleDayOfWeek, g.scheduleTimeStart, g.scheduleTimeEnd),
  }
}

// Prisma select object for a fully-scorable SmallGroup
const SMALL_GROUP_SCORE_SELECT = {
  id: true,
  name: true,
  groupType: true,
  lifeStages: { select: { id: true, name: true } },
  genderFocus: true,
  language: true,
  ageRangeMin: true,
  ageRangeMax: true,
  meetingFormat: true,
  locationCity: true,
  memberLimit: true,
  scheduleDayOfWeek: true,
  scheduleTimeStart: true,
  scheduleTimeEnd: true,
  _count: { select: { members: true } },
  members: { select: { workIndustry: true } },
} as const

async function getDescendantGroupIds(groupId: string): Promise<Set<string>> {
  const result = new Set<string>()
  const queue = [groupId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const children = await db.smallGroup.findMany({
      where: { parentGroupId: current },
      select: { id: true },
    })
    for (const child of children) {
      if (!result.has(child.id)) {
        result.add(child.id)
        queue.push(child.id)
      }
    }
  }
  return result
}

const loadSmallGroupWeights = unstable_cache(
  async (): Promise<WeightConfig> => {
    const config = await db.matchingWeightConfig.findUnique({
      where: { context: MatchingContext.SmallGroup },
    })
    return config ?? DEFAULT_WEIGHTS
  },
  ["matching-weights-small-group"],
  { revalidate: 60 }
)

const loadBreakoutWeights = unstable_cache(
  async (): Promise<WeightConfig> => {
    const config = await db.matchingWeightConfig.findUnique({
      where: { context: MatchingContext.Breakout },
    })
    return config ?? DEFAULT_WEIGHTS
  },
  ["matching-weights-breakout"],
  { revalidate: 60 }
)

const loadGuestCooldownDays = unstable_cache(
  async (): Promise<number> => {
    const config = await db.matchingWeightConfig.findUnique({
      where: { context: MatchingContext.SmallGroup },
      select: { guestCooldownDays: true },
    })
    return config?.guestCooldownDays ?? DEFAULT_GUEST_COOLDOWN_DAYS
  },
  ["matching-guest-cooldown-days"],
  { revalidate: 60 }
)

/**
 * Groups currently on guest-assignment cooldown: they received a guest
 * assignment (a Pending or Confirmed request) within the cooldown window.
 * Rejected/cancelled requests release the cooldown immediately.
 */
async function getGuestCooldownGroupIds(): Promise<Set<string>> {
  const days = await loadGuestCooldownDays()
  if (days <= 0) return new Set()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const recent = await db.smallGroupMemberRequest.findMany({
    where: {
      guestId: { not: null },
      smallGroupId: { not: null },
      status: { in: ["Pending", "Confirmed"] },
      createdAt: { gte: cutoff },
    },
    select: { smallGroupId: true },
  })
  return new Set(
    recent.map((r) => r.smallGroupId).filter((id): id is string => id !== null)
  )
}

/**
 * Applies the guest-assignment cooldown to an eligible group list.
 * Cooling-down groups are dropped — unless that would leave the seeker with
 * nothing, in which case all eligible groups are kept and the cooling-down
 * ones are flagged so the UI can surface them as "recently assigned".
 */
function applyCooldown<T extends { id: string }>(
  eligible: T[],
  cooldownGroupIds: Set<string>
): { pool: T[]; isOnCooldown: (id: string) => boolean } {
  const nonCooldown = eligible.filter((g) => !cooldownGroupIds.has(g.id))
  if (nonCooldown.length > 0) {
    return { pool: nonCooldown, isOnCooldown: () => false }
  }
  return { pool: eligible, isOnCooldown: (id) => cooldownGroupIds.has(id) }
}

// ─── Small Group Matching ─────────────────────────────────────────────────────

export async function matchSmallGroups(
  params: { guestId: string } | { memberId: string },
  options?: {
    excludeCurrentGroup?: boolean
    limit?: number
    candidateScheduleSlot?: TimeSlot
    /**
     * Couples groups are excluded from individual matching by default. Admin
     * flows may include them when the candidate is known to have a spouse
     * (e.g. catch-mech assignment for one half of a couple).
     */
    includeCouplesGroups?: boolean
  }
): Promise<MatchResult[]> {
  let candidate: CandidateProfile
  let currentGroupId: string | null | undefined
  let ledGroupIds = new Set<string>()

  if ("guestId" in params) {
    const guest = await db.guest.findUnique({
      where: { id: params.guestId },
      select: {
        lifeStageId: true,
        gender: true,
        language: true,
        birthMonth: true,
        birthYear: true,
        ageRangeBucket: { select: { minAge: true, maxAge: true } },
        workCity: true,
        workIndustry: true,
        meetingPreference: true,
        scheduleDayOfWeek: true,
        scheduleTimeStart: true,
        scheduleTimeEnd: true,
      },
    })
    if (!guest) return []
    candidate = buildCandidateFromGuest(guest)
    currentGroupId = null
  } else {
    const member = await db.member.findUnique({
      where: { id: params.memberId },
      select: {
        lifeStageId: true,
        gender: true,
        language: true,
        birthMonth: true,
        birthYear: true,
        ageRangeBucket: { select: { minAge: true, maxAge: true } },
        workCity: true,
        workIndustry: true,
        meetingPreference: true,
        smallGroupId: true,
        ledGroups: { select: { id: true } },
        schedulePreferences: {
          select: { dayOfWeek: true, timeStart: true, timeEnd: true },
        },
      },
    })
    if (!member) return []
    candidate = buildCandidateFromMember(member)
    currentGroupId = member.smallGroupId
    ledGroupIds = new Set(member.ledGroups.map((g) => g.id))
  }

  if (options?.candidateScheduleSlot) {
    candidate = {
      ...candidate,
      scheduleSlots: [options.candidateScheduleSlot],
    }
  }

  const groups = await db.smallGroup.findMany({
    select: SMALL_GROUP_SCORE_SELECT,
  })

  const weights = await loadSmallGroupWeights()

  // Downline = descendants of the candidate's current group (moving "down" the
  // hierarchy is blocked) PLUS descendants of any groups they lead (a leader
  // should never be placed into a group they are spiritually responsible for).
  const downlineGroupIds = new Set<string>()
  if (currentGroupId) {
    const fromCurrentGroup = await getDescendantGroupIds(currentGroupId)
    for (const id of fromCurrentGroup) downlineGroupIds.add(id)
  }
  for (const ledGroupId of ledGroupIds) {
    const descendants = await getDescendantGroupIds(ledGroupId)
    for (const id of descendants) downlineGroupIds.add(id)
  }

  // Groups that have already rejected this candidate should not be suggested again.
  const rejectedGroupIds = new Set<string>()
  if ("guestId" in params) {
    const rejected = await db.smallGroupMemberRequest.findMany({
      where: { guestId: params.guestId, status: "Rejected", smallGroupId: { not: null } },
      select: { smallGroupId: true },
    })
    for (const r of rejected) if (r.smallGroupId) rejectedGroupIds.add(r.smallGroupId)
  } else {
    const rejected = await db.smallGroupMemberRequest.findMany({
      where: { memberId: params.memberId, status: "Rejected", smallGroupId: { not: null } },
      select: { smallGroupId: true },
    })
    for (const r of rejected) if (r.smallGroupId) rejectedGroupIds.add(r.smallGroupId)
  }

  const eligible = groups.filter((g) => {
    // Couples groups take married pairs, never individually matched candidates
    // (unless the caller explicitly opted in for a candidate with a spouse)
    if (g.groupType === "Couples" && !options?.includeCouplesGroups) return false
    if (options?.excludeCurrentGroup && currentGroupId && g.id === currentGroupId) {
      return false
    }
    if (ledGroupIds.has(g.id)) return false
    if (downlineGroupIds.has(g.id)) return false
    if (rejectedGroupIds.has(g.id)) return false
    if (g.memberLimit !== null && g._count.members >= g.memberLimit) return false
    const gp = buildSmallGroupProfile(g)
    if (scoreGender(candidate.gender, gp.genderFocus) === 0.0) return false
    if (scoreLifeStage(candidate.lifeStageId, gp.lifeStageIds) === 0.0) return false
    if (scoreSchedule(candidate.scheduleSlots, gp.scheduleSlots) === 0.0) return false
    return true
  })

  // Cooldown applies to guest seekers only — member transfers are deliberate
  // admin moves and stay unrestricted.
  const cooldownGroupIds =
    "guestId" in params ? await getGuestCooldownGroupIds() : new Set<string>()
  const { pool, isOnCooldown } = applyCooldown(eligible, cooldownGroupIds)

  return pool
    .map((g) => ({
      ...scoreGroup(candidate, buildSmallGroupProfile(g), weights),
      onCooldown: isOnCooldown(g.id),
    }))
    .sort(byScoreThenConfidence)
    .slice(0, options?.limit ?? 10)
}

// ─── Couples Group Matching ──────────────────────────────────────────────────

export type CoupleMatchResult = {
  groupId: string
  groupName: string
  /** Worst-of the two spouses' scores — the ranking key. */
  combinedScore: number
  /** Tie-breaker between equal combined scores. */
  averageScore: number
  resultA: MatchResult
  resultB: MatchResult
}

const MEMBER_CANDIDATE_SELECT = {
  lifeStageId: true,
  gender: true,
  language: true,
  birthMonth: true,
  birthYear: true,
  ageRangeBucket: { select: { minAge: true, maxAge: true } },
  workCity: true,
  workIndustry: true,
  meetingPreference: true,
  smallGroupId: true,
  ledGroups: { select: { id: true } },
  schedulePreferences: {
    select: { dayOfWeek: true, timeStart: true, timeEnd: true },
  },
} as const

/**
 * Jointly scores COUPLES groups for a married pair. Only `groupType: Couples`
 * groups are considered; capacity requires two free seats; a group either
 * spouse leads, already belongs to, or was rejected by is excluded. Both
 * spouses must individually pass the hard eligibility gates (life stage,
 * schedule), then results rank by worst-of score (see combineCoupleScores).
 */
export async function matchCouplesGroups(
  params: { memberIdA: string; memberIdB: string },
  options?: { limit?: number }
): Promise<CoupleMatchResult[]> {
  if (params.memberIdA === params.memberIdB) return []

  const [memberA, memberB] = await Promise.all([
    db.member.findUnique({ where: { id: params.memberIdA }, select: MEMBER_CANDIDATE_SELECT }),
    db.member.findUnique({ where: { id: params.memberIdB }, select: MEMBER_CANDIDATE_SELECT }),
  ])
  if (!memberA || !memberB) return []

  const candidateA = buildCandidateFromMember(memberA)
  const candidateB = buildCandidateFromMember(memberB)

  const excludedGroupIds = new Set<string>(
    [...memberA.ledGroups, ...memberB.ledGroups].map((g) => g.id)
  )
  // Suggesting a group either spouse already belongs to is pointless — joining
  // an incomplete couple into an existing group goes through the group's own
  // add-couple flow instead.
  if (memberA.smallGroupId) excludedGroupIds.add(memberA.smallGroupId)
  if (memberB.smallGroupId) excludedGroupIds.add(memberB.smallGroupId)

  const rejected = await db.smallGroupMemberRequest.findMany({
    where: {
      memberId: { in: [params.memberIdA, params.memberIdB] },
      status: "Rejected",
      smallGroupId: { not: null },
    },
    select: { smallGroupId: true },
  })
  for (const r of rejected) if (r.smallGroupId) excludedGroupIds.add(r.smallGroupId)

  const [groups, weights] = await Promise.all([
    db.smallGroup.findMany({
      where: { groupType: "Couples" },
      select: SMALL_GROUP_SCORE_SELECT,
    }),
    loadSmallGroupWeights(),
  ])

  return groups
    .filter((g) => {
      if (excludedGroupIds.has(g.id)) return false
      // Couples join as a pair — the group needs two free seats
      if (g.memberLimit !== null && g._count.members + 2 > g.memberLimit) return false
      const gp = buildSmallGroupProfile(g)
      for (const candidate of [candidateA, candidateB]) {
        if (scoreGender(candidate.gender, gp.genderFocus) === 0.0) return false
        if (scoreLifeStage(candidate.lifeStageId, gp.lifeStageIds) === 0.0) return false
        if (scoreSchedule(candidate.scheduleSlots, gp.scheduleSlots) === 0.0) return false
      }
      return true
    })
    .map((g) => {
      const gp = buildSmallGroupProfile(g)
      const resultA = scoreGroup(candidateA, gp, weights)
      const resultB = scoreGroup(candidateB, gp, weights)
      const couple = combineCoupleScores(resultA.totalScore, resultB.totalScore)
      return {
        groupId: g.id,
        groupName: g.name,
        combinedScore: couple.combinedScore,
        averageScore: couple.averageScore,
        resultA,
        resultB,
      }
    })
    .sort(
      (a, b) =>
        b.combinedScore - a.combinedScore || b.averageScore - a.averageScore
    )
    .slice(0, options?.limit ?? 5)
}

// ─── Small Group Escalation Matching ─────────────────────────────────────────

/**
 * Matches a guest to small groups in three escalating levels:
 *   1. Small groups led by this guest's breakout group facilitator(s) in the given event
 *   2. Small groups led by any other volunteer at the same event
 *   3. All remaining small groups
 *
 * Each level only includes groups not already covered by a higher level.
 */
export async function matchSmallGroupsWithEscalation(
  guestId: string,
  eventId: string,
  candidateScheduleSlot?: TimeSlot
): Promise<EscalationLevel[]> {
  const guest = await db.guest.findUnique({
    where: { id: guestId },
    select: {
      lifeStageId: true,
      gender: true,
      language: true,
      birthMonth: true,
      birthYear: true,
      ageRangeBucket: { select: { minAge: true, maxAge: true } },
      workCity: true,
      workIndustry: true,
      meetingPreference: true,
      scheduleDayOfWeek: true,
      scheduleTimeStart: true,
      scheduleTimeEnd: true,
    },
  })
  if (!guest) return []

  const candidate: CandidateProfile = candidateScheduleSlot
    ? {
        ...buildCandidateFromGuest(guest),
        scheduleSlots: [candidateScheduleSlot],
      }
    : buildCandidateFromGuest(guest)
  const weights = await loadSmallGroupWeights()

  // ── Collect Level 1 group IDs (breakout facilitators' small groups) ───────
  const breakoutMemberships = await db.breakoutGroupMember.findMany({
    where: { registrant: { guestId, eventId } },
    select: {
      breakoutGroup: {
        select: {
          facilitator: {
            select: { member: { select: { ledGroups: { select: { id: true } } } } },
          },
          coFacilitator: {
            select: { member: { select: { ledGroups: { select: { id: true } } } } },
          },
        },
      },
    },
  })

  const level1Ids = new Set<string>()
  for (const bm of breakoutMemberships) {
    bm.breakoutGroup.facilitator?.member.ledGroups.forEach((g) => level1Ids.add(g.id))
    bm.breakoutGroup.coFacilitator?.member.ledGroups.forEach((g) => level1Ids.add(g.id))
  }

  // ── Collect Level 2 group IDs (other event volunteer leaders) ─────────────
  const eventVolunteers = await db.volunteer.findMany({
    where: { eventId },
    select: { member: { select: { ledGroups: { select: { id: true } } } } },
  })

  const level2Ids = new Set<string>()
  for (const v of eventVolunteers) {
    v.member.ledGroups.forEach((g) => {
      if (!level1Ids.has(g.id)) level2Ids.add(g.id)
    })
  }

  // ── Fetch and score all small groups in one query ─────────────────────────
  const allGroups = await db.smallGroup.findMany({
    select: SMALL_GROUP_SCORE_SELECT,
  })

  // Groups that already rejected this guest should not be re-suggested.
  const rejectedRequests = await db.smallGroupMemberRequest.findMany({
    where: { guestId, status: "Rejected" },
    select: { smallGroupId: true },
  })
  const rejectedGroupIds = new Set(rejectedRequests.map((r) => r.smallGroupId))

  const eligible = allGroups.filter((g) => {
    // Couples groups take married pairs, never individually matched candidates
    if (g.groupType === "Couples") return false
    if (rejectedGroupIds.has(g.id)) return false
    if (g.memberLimit !== null && g._count.members >= g.memberLimit) return false
    const gp = buildSmallGroupProfile(g)
    if (scoreGender(candidate.gender, gp.genderFocus) === 0.0) return false
    if (scoreLifeStage(candidate.lifeStageId, gp.lifeStageIds) === 0.0) return false
    if (scoreSchedule(candidate.scheduleSlots, gp.scheduleSlots) === 0.0) return false
    return true
  })

  // Escalation matching is always for a guest — apply the cooldown across the
  // whole eligible set so the fallback considers every level, not each level
  // in isolation.
  const cooldownGroupIds = await getGuestCooldownGroupIds()
  const { pool, isOnCooldown } = applyCooldown(eligible, cooldownGroupIds)

  const scored = pool.map((g) => ({
    result: {
      ...scoreGroup(candidate, buildSmallGroupProfile(g), weights),
      onCooldown: isOnCooldown(g.id),
    },
    id: g.id,
  }))

  const sortByScore = (arr: typeof scored) =>
    arr.map((s) => s.result).sort(byScoreThenConfidence)

  const l1Scored = scored.filter((s) => level1Ids.has(s.id))
  const l2Scored = scored.filter((s) => level2Ids.has(s.id))
  const l3Scored = scored.filter((s) => !level1Ids.has(s.id) && !level2Ids.has(s.id))

  const levels: EscalationLevel[] = []

  if (l1Scored.length > 0) {
    levels.push({ level: 1, source: "breakout-facilitator", matches: sortByScore(l1Scored) })
  }
  if (l2Scored.length > 0) {
    levels.push({ level: 2, source: "event-volunteer", matches: sortByScore(l2Scored) })
  }
  if (l3Scored.length > 0) {
    levels.push({ level: 3, source: "all-small-groups", matches: sortByScore(l3Scored).slice(0, 10) })
  }

  return levels
}

// ─── Breakout Group Matching ──────────────────────────────────────────────────

/**
 * Lives in `lib/breakouts/gender-focus.ts` now — it is pure, and the public
 * registration path needs it without dragging the database in. Re-exported here
 * so existing importers keep resolving.
 */
export { deriveEffectiveGenderFocus } from "@/lib/breakouts/gender-focus"

/**
 * Everything `buildBreakoutGroupProfile` needs off a BreakoutGroup row.
 *
 * Deliberately narrower than the small-group equivalent: breakout matching
 * scores life stage, gender focus, age and language only, so meeting format,
 * city, schedule and the members→workIndustry join are not selected. That last
 * one mattered — it was a two-level join fired for every group on the event.
 */
const BREAKOUT_GROUP_SCORE_SELECT = {
  id: true,
  name: true,
  lifeStages: { select: { id: true, name: true } },
  genderFocus: true,
  language: true,
  ageRangeMin: true,
  ageRangeMax: true,
  // Capacity is no longer scored, but it is still a hard filter (full groups are
  // excluded) and the ranking tie-break — see `byBreakoutRank`.
  memberLimit: true,
  _count: { select: { members: true } },
  facilitator: {
    select: { member: { select: { gender: true } } },
  },
  coFacilitator: {
    select: { member: { select: { gender: true } } },
  },
  linkedSmallGroup: {
    select: { genderFocus: true },
  },
} as const

type BreakoutGroupScoreRow = {
  id: string
  name: string
  lifeStages: { id: string; name: string }[]
  genderFocus: "Male" | "Female" | "Mixed" | null
  language: string[]
  ageRangeMin: number | null
  ageRangeMax: number | null
  memberLimit: number | null
  _count: { members: number }
  facilitator: { member: { gender: "Male" | "Female" | null } } | null
  coFacilitator: { member: { gender: "Male" | "Female" | null } } | null
  linkedSmallGroup: { genderFocus: "Male" | "Female" | "Mixed" | null } | null
}

export function buildBreakoutGroupProfile(g: BreakoutGroupScoreRow): GroupProfile {
  return {
    id: g.id,
    name: g.name,
    lifeStageIds: g.lifeStages.map((ls) => ls.id),
    lifeStageNames: g.lifeStages.map((ls) => ls.name),
    genderFocus: deriveEffectiveGenderFocus(
      g.genderFocus,
      g.facilitator?.member.gender,
      g.coFacilitator?.member.gender,
      g.linkedSmallGroup?.genderFocus
    ),
    language: g.language,
    ageRangeMin: g.ageRangeMin,
    ageRangeMax: g.ageRangeMax,
    memberLimit: g.memberLimit,
    currentCount: g._count.members,
    // Not matched on for breakouts — held at their empty values so the shared
    // `GroupProfile` shape still typechecks and every scorer reads "unknown".
    meetingFormat: null,
    locationCity: null,
    memberIndustries: [],
    scheduleSlots: [],
  }
}

/**
 * The breakout eligibility gates: gender and life stage. Unlike small groups,
 * schedule is not a gate here — a breakout table meets during the event.
 *
 * `matchBreakoutGroups` uses this to *exclude* groups. The admin-facing
 * candidate picker uses it to *label* people who don't meet the group's
 * criteria while still allowing an override.
 */
export function passesBreakoutGates(
  candidate: CandidateProfile,
  profile: GroupProfile
): boolean {
  if (scoreGender(candidate.gender, profile.genderFocus) === 0.0) return false
  if (scoreLifeStage(candidate.lifeStageId, profile.lifeStageIds) === 0.0) return false
  return true
}

/** Everything `buildCandidateFrom{Member,Guest}` needs off an EventRegistrant row. */
const CANDIDATE_PROFILE_SELECT = {
  member: {
    select: {
      lifeStageId: true,
      gender: true,
      language: true,
      birthMonth: true,
      birthYear: true,
      ageRangeBucket: { select: { minAge: true, maxAge: true } },
      workCity: true,
      workIndustry: true,
      meetingPreference: true,
      schedulePreferences: {
        select: { dayOfWeek: true, timeStart: true, timeEnd: true },
      },
    },
  },
  guest: {
    select: {
      lifeStageId: true,
      gender: true,
      language: true,
      birthMonth: true,
      birthYear: true,
      ageRangeBucket: { select: { minAge: true, maxAge: true } },
      workCity: true,
      workIndustry: true,
      meetingPreference: true,
      scheduleDayOfWeek: true,
      scheduleTimeStart: true,
      scheduleTimeEnd: true,
    },
  },
} as const

/**
 * Resolve each registrant to a matching profile. A registrant with neither a
 * Member nor a Guest behind it (an anonymous walk-in) has nothing to match on
 * and gets EMPTY_CANDIDATE — every factor scores as unknown.
 */
async function loadCandidateProfiles(
  registrantIds: string[]
): Promise<Map<string, CandidateProfile>> {
  if (registrantIds.length === 0) return new Map()

  const rows = await db.eventRegistrant.findMany({
    where: { id: { in: registrantIds } },
    select: { id: true, ...CANDIDATE_PROFILE_SELECT },
  })

  return new Map(
    rows.map((r) => [
      r.id,
      r.member
        ? buildCandidateFromMember(r.member)
        : r.guest
        ? buildCandidateFromGuest(r.guest)
        : EMPTY_CANDIDATE,
    ])
  )
}

export async function matchBreakoutGroups(
  registrantId: string,
  owner: BreakoutOwner,
  options?: { excludeAssigned?: boolean; limit?: number }
): Promise<MatchResult[]> {
  const [profiles, assignments] = await Promise.all([
    loadCandidateProfiles([registrantId]),
    db.breakoutGroupMember.findMany({
      where: { registrantId },
      select: { breakoutGroupId: true },
    }),
  ])

  const candidate = profiles.get(registrantId)
  if (!candidate) return []

  const assignedGroupIds = new Set(assignments.map((m) => m.breakoutGroupId))

  const groups = await db.breakoutGroup.findMany({
    // A group that is switched off — or held back for manual assignment — is not
    // suggested. This is the automatic route; an admin who wants someone in there
    // adds them from the group's own page, which stays open for both.
    // See `AUTO_ASSIGNABLE_BREAKOUT_WHERE`.
    //
    // Scoped by owner (CCF-148): the tables in play are one event's standing set
    // or a Collab cluster's set for the day, never both.
    where: { ...owner, ...AUTO_ASSIGNABLE_BREAKOUT_WHERE },
    select: BREAKOUT_GROUP_SCORE_SELECT,
  })

  const weights = await loadBreakoutWeights()

  return groups
    .map((g) => ({ row: g, profile: buildBreakoutGroupProfile(g) }))
    .filter(({ row, profile }) => {
      if (options?.excludeAssigned && assignedGroupIds.has(row.id)) return false
      if (profile.memberLimit !== null && profile.currentCount >= profile.memberLimit) return false
      return passesBreakoutGates(candidate, profile)
    })
    .map(({ profile }) => scoreGroup(candidate, profile, weights, BREAKOUT_ACTIVE_WEIGHT_KEYS))
    .sort(byBreakoutRank)
    .slice(0, options?.limit ?? 5)
}

export type BreakoutCandidateMatch = {
  registrantId: string
  result: MatchResult
  /** False when the candidate fails the group's gender or life stage gate. */
  passesGates: boolean
}

/**
 * Turn a registrant's linked person into a matching profile.
 *
 * Exported so a caller that already selected the person columns for its own
 * purposes can build the profile from those rows instead of making the matching
 * layer re-query the same people. Anyone with neither a Member nor a Guest
 * behind them is an anonymous walk-in: nothing to match on, so every factor
 * scores as unknown.
 */
export function buildCandidateFromRegistrant(r: {
  member: Parameters<typeof buildCandidateFromMember>[0] | null
  guest: Parameters<typeof buildCandidateFromGuest>[0] | null
}): CandidateProfile {
  return r.member
    ? buildCandidateFromMember(r.member)
    : r.guest
    ? buildCandidateFromGuest(r.guest)
    : EMPTY_CANDIDATE
}

/**
 * Score many candidates against ONE breakout group — the inverse of
 * `matchBreakoutGroups`, for the admin candidate picker. It needs a fit signal
 * for everyone in the pool, *including* people who fail the group's gates,
 * since an admin must still be able to place them deliberately.
 *
 * Takes pre-built profiles rather than ids: the picker has already read these
 * people to render them, and re-reading them here would double the cost of
 * opening the sheet. Returns unsorted; callers decide the ordering.
 */
export async function scoreCandidatesForBreakout(
  groupId: string,
  owner: BreakoutOwner,
  profiles: Map<string, CandidateProfile>
): Promise<BreakoutCandidateMatch[]> {
  if (profiles.size === 0) return []

  const group = await db.breakoutGroup.findFirst({
    where: { id: groupId, ...owner },
    select: BREAKOUT_GROUP_SCORE_SELECT,
  })
  if (!group) return []

  const weights = await loadBreakoutWeights()
  const groupProfile = buildBreakoutGroupProfile(group)

  return [...profiles.entries()].map(([registrantId, candidate]) => ({
    registrantId,
    result: scoreGroup(candidate, groupProfile, weights, BREAKOUT_ACTIVE_WEIGHT_KEYS),
    passesGates: passesBreakoutGates(candidate, groupProfile),
  }))
}
