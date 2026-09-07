"use server"

import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { isSuperAdmin } from "@/lib/permissions"
import { displayPersonName, personNameKey } from "@/lib/people/name-key"
import { mergeDuplicateGroup, type LoserRef } from "@/lib/people/merge-profiles"
// Not re-exported from here: Turbopack's server-action transform treats a
// re-export in a "use server" module as a runtime export and tries to register
// it as an action. Consumers import the type from the lib module directly.
import { EMPTY_ACTIVITY, type RecordActivity } from "@/lib/people/duplicate-activity"

type DuplicateRecord = {
  id: string
  firstName: string
  lastName: string
  recordType: "member" | "guest"
  activity: RecordActivity
}

export type DuplicateField = "phone" | "email" | "name"

type DuplicateGroup = {
  field: DuplicateField
  value: string
  records: DuplicateRecord[]
}

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string }

/** Identity of a record across both tables — ids are unique, the type keeps it readable. */
function recordKey(r: { id: string; recordType: "member" | "guest" }): string {
  return `${r.recordType}:${r.id}`
}

/**
 * Activity counts for the records that actually landed in a duplicate group.
 *
 * Scoped to those ids on purpose: `getDuplicateProfiles` reads every Member and
 * every active Guest to find the groups, and hanging `_count` off those two
 * queries would aggregate across the whole table to describe a handful of rows.
 */
async function loadActivity(groups: DuplicateGroup[]): Promise<Map<string, RecordActivity>> {
  const memberIds = new Set<string>()
  const guestIds = new Set<string>()
  for (const g of groups) {
    for (const r of g.records) {
      ;(r.recordType === "member" ? memberIds : guestIds).add(r.id)
    }
  }

  const out = new Map<string, RecordActivity>()
  if (memberIds.size === 0 && guestIds.size === 0) return out

  const memberIdList = [...memberIds]
  const guestIdList = [...guestIds]

  const [members, guests, registrants] = await Promise.all([
    memberIdList.length
      ? db.member.findMany({
          where: { id: { in: memberIdList } },
          select: {
            id: true,
            createdAt: true,
            updatedAt: true,
            upwardSatellite: true,
            smallGroup: { select: { name: true } },
            _count: { select: { ledGroups: true, volunteers: true, familyMemberships: true } },
          },
        })
      : [],
    guestIdList.length
      ? db.guest.findMany({
          where: { id: { in: guestIdList } },
          select: {
            id: true,
            createdAt: true,
            updatedAt: true,
            claimedSatellite: true,
            claimedSmallGroup: { select: { name: true } },
            _count: { select: { familyMemberships: true } },
          },
        })
      : [],
    db.eventRegistrant.findMany({
      where: {
        OR: [
          ...(memberIdList.length ? [{ memberId: { in: memberIdList } }] : []),
          ...(guestIdList.length ? [{ guestId: { in: guestIdList } }] : []),
        ],
      },
      select: {
        memberId: true,
        guestId: true,
        attendedAt: true,
        createdAt: true,
        // OneTime attendance lives on `attendedAt`; MultiDay/Recurring on these rows.
        _count: { select: { occurrenceAttendances: true } },
      },
    }),
  ])

  type Tally = { events: number; checkIns: number; lastAt: Date | null }
  const tallies = new Map<string, Tally>()
  for (const r of registrants) {
    // Both FKs null is an anonymous registrant — it belongs to no profile and
    // must not be keyed, or it would fold into whichever branch is checked first.
    if (!r.memberId && !r.guestId) continue
    const key = r.memberId ? `member:${r.memberId}` : `guest:${r.guestId}`
    const t = tallies.get(key) ?? { events: 0, checkIns: 0, lastAt: null }
    t.events += 1
    t.checkIns += (r.attendedAt ? 1 : 0) + r._count.occurrenceAttendances
    if (!t.lastAt || r.createdAt > t.lastAt) t.lastAt = r.createdAt
    tallies.set(key, t)
  }

  function lastActivity(updatedAt: Date, lastAt: Date | null): string {
    return (lastAt && lastAt > updatedAt ? lastAt : updatedAt).toISOString()
  }

  for (const m of members) {
    const key = `member:${m.id}`
    const t = tallies.get(key)
    out.set(key, {
      events: t?.events ?? 0,
      checkIns: t?.checkIns ?? 0,
      ledGroups: m._count.ledGroups,
      volunteerRoles: m._count.volunteers,
      familyLinks: m._count.familyMemberships,
      groupName: m.smallGroup?.name ?? null,
      groupIsClaimed: false,
      satellite: m.upwardSatellite,
      lastActivityAt: lastActivity(m.updatedAt, t?.lastAt ?? null),
      createdAt: m.createdAt.toISOString(),
    })
  }

  for (const g of guests) {
    const key = `guest:${g.id}`
    const t = tallies.get(key)
    out.set(key, {
      events: t?.events ?? 0,
      checkIns: t?.checkIns ?? 0,
      ledGroups: 0,
      volunteerRoles: 0,
      familyLinks: g._count.familyMemberships,
      // Self-reported at check-in, never confirmed — the UI labels it as a claim.
      groupName: g.claimedSmallGroup?.name ?? null,
      groupIsClaimed: g.claimedSmallGroup !== null,
      satellite: g.claimedSatellite,
      lastActivityAt: lastActivity(g.updatedAt, t?.lastAt ?? null),
      createdAt: g.createdAt.toISOString(),
    })
  }

  return out
}

/**
 * Guarded like the two merge actions below, not because the page is Super Admin
 * only — a `"use server"` export is a callable endpoint no matter who renders the
 * page that uses it. What comes back is every duplicate candidate's DGroup,
 * satellite, led-group count, volunteer roles, household links and activity
 * dates, so an unauthenticated POST here is a bulk read of the directory.
 */
export async function getDuplicateProfiles(): Promise<ActionResult<DuplicateGroup[]>> {
  const session = await auth()
  if (!isSuperAdmin(session)) return { success: false, error: "Unauthorized" }

  try {
    const [members, guests] = await Promise.all([
      db.member.findMany({
        select: { id: true, firstName: true, lastName: true, phone: true, email: true },
      }),
      db.guest.findMany({
        where: { memberId: null },
        select: { id: true, firstName: true, lastName: true, phone: true, email: true },
      }),
    ])

    const phoneMap = new Map<string, DuplicateRecord[]>()
    const emailMap = new Map<string, DuplicateRecord[]>()
    // Keyed by the normalized name key; `value` keeps the first spelling seen so
    // the UI shows a real name rather than the sorted, de-accented key.
    const nameMap = new Map<string, { value: string; records: DuplicateRecord[] }>()

    function index(
      base: Omit<DuplicateRecord, "activity">,
      phone: string | null,
      email: string | null,
    ) {
      // Counts are attached in one scoped pass once the groups are known — see
      // `loadActivity`. Until then every record carries the empty placeholder.
      const record: DuplicateRecord = { ...base, activity: EMPTY_ACTIVITY }
      if (phone) {
        const key = phone.trim().toLowerCase()
        phoneMap.set(key, [...(phoneMap.get(key) ?? []), record])
      }
      if (email) {
        const key = email.trim().toLowerCase()
        emailMap.set(key, [...(emailMap.get(key) ?? []), record])
      }
      const nameKey = personNameKey(record.firstName, record.lastName)
      if (nameKey) {
        const existing = nameMap.get(nameKey)
        const value = existing?.value ?? displayPersonName(record.firstName, record.lastName)
        nameMap.set(nameKey, { value, records: [...(existing?.records ?? []), record] })
      }
    }

    for (const m of members) {
      index(
        { id: m.id, firstName: m.firstName, lastName: m.lastName, recordType: "member" },
        m.phone,
        m.email,
      )
    }

    for (const g of guests) {
      index(
        { id: g.id, firstName: g.firstName, lastName: g.lastName, recordType: "guest" },
        g.phone,
        g.email,
      )
    }

    const groups: DuplicateGroup[] = []

    for (const [value, records] of phoneMap) {
      if (records.length > 1) groups.push({ field: "phone", value, records })
    }
    for (const [value, records] of emailMap) {
      if (records.length > 1) groups.push({ field: "email", value, records })
    }

    // A name match over people already flagged by a shared phone or email adds
    // nothing but a second card for the same merge decision, so drop any name
    // group whose records are all covered by one contact group.
    const contactSets = groups.map((g) => new Set(g.records.map(recordKey)))
    for (const { value, records } of nameMap.values()) {
      if (records.length < 2) continue
      const covered = contactSets.some((set) => records.every((r) => set.has(recordKey(r))))
      if (covered) continue
      groups.push({ field: "name", value, records })
    }

    const activity = await loadActivity(groups)
    const hydrated = groups.map((g) => ({
      ...g,
      records: g.records.map((r) => ({
        ...r,
        activity: activity.get(recordKey(r)) ?? EMPTY_ACTIVITY,
      })),
    }))

    return { success: true, data: hydrated }
  } catch {
    return { success: false, error: "Failed to load duplicate profiles" }
  }
}


// ─── Merge / resolve ──────────────────────────────────────────────────────────

export type ResolveDuplicateInput = {
  keeperId: string
  keeperType: "member" | "guest"
  losers: LoserRef[]
}

/**
 * Resolves a duplicate group by merging the losers into the keeper and deleting them.
 *
 * The merge itself lives in `lib/people/merge-profiles.ts` — everything here is the
 * request-scope shell around it: permission, one transaction per group, error mapping
 * and revalidation. That split is what lets the rules be tested without a session.
 *
 * Field strategy: the keeper wins every conflict, its empty fields are filled from the
 * loser, and any loser value that lost is written to the keeper's activity log rather
 * than discarded — the losing row no longer survives to be consulted.
 */
export async function resolveDuplicateGroup(
  input: ResolveDuplicateInput,
): Promise<ActionResult<{ merged: number }>> {
  const session = await auth()
  if (!isSuperAdmin(session)) return { success: false, error: "Unauthorized" }

  const result = await runSingleMerge(input, session?.user?.name ?? null)
  if (result.success) revalidateAfterMerge()
  return result
}

async function runSingleMerge(
  input: ResolveDuplicateInput,
  performedBy: string | null,
): Promise<ActionResult<{ merged: number }>> {
  if (input.losers.length === 0) {
    return { success: false, error: "No records to merge" }
  }
  if (input.losers.some((l) => l.id === input.keeperId)) {
    return { success: false, error: "Keeper cannot be in the losers list" }
  }

  try {
    const result = await db.$transaction(
      (tx) => mergeDuplicateGroup(tx, { ...input, performedBy }),
      { timeout: 30_000 },
    )
    return { success: true, data: result }
  } catch (e) {
    // Our own validation throws carry safe, user-facing messages. Anything from
    // Prisma (carries a `P####` code) must never be surfaced raw — map it to a
    // generic message per the project's error-handling convention.
    const code = (e as { code?: unknown })?.code
    if (typeof code === "string" && /^P\d+/.test(code)) {
      return { success: false, error: "Failed to merge records due to a data conflict." }
    }
    const msg = e instanceof Error ? e.message : "Failed to merge records"
    return { success: false, error: msg }
  }
}

export type BatchMergeItemResult =
  | { index: number; success: true; merged: number }
  | { index: number; success: false; error: string }

export type BatchMergeResult = {
  total: number
  succeeded: number
  failed: number
  totalMerged: number
  items: BatchMergeItemResult[]
}

/**
 * Resolves multiple duplicate groups in one call. Each group runs in its own
 * transaction so a failure in one doesn't roll back the others — the action
 * returns per-item results so the UI can surface partial successes.
 */
export async function resolveDuplicateGroups(
  inputs: ResolveDuplicateInput[],
): Promise<ActionResult<BatchMergeResult>> {
  const session = await auth()
  if (!isSuperAdmin(session)) return { success: false, error: "Unauthorized" }

  if (inputs.length === 0) {
    return { success: false, error: "Nothing to merge" }
  }

  const performedBy = session?.user?.name ?? null
  const items: BatchMergeItemResult[] = []
  let succeeded = 0
  let failed = 0
  let totalMerged = 0

  for (let i = 0; i < inputs.length; i++) {
    const result = await runSingleMerge(inputs[i], performedBy)
    if (result.success) {
      items.push({ index: i, success: true, merged: result.data.merged })
      succeeded++
      totalMerged += result.data.merged
    } else {
      items.push({ index: i, success: false, error: result.error })
      failed++
    }
  }

  revalidateAfterMerge()

  return {
    success: true,
    data: { total: inputs.length, succeeded, failed, totalMerged, items },
  }
}

/**
 * A merge reaches further than the three screens it starts from: it deletes people,
 * folds registrations and re-points volunteer rows, so the members and guests lists,
 * the duplicates page itself and every event roster can all be stale afterwards.
 */
function revalidateAfterMerge() {
  revalidatePath("/settings/duplicate-profiles")
  revalidatePath("/members")
  revalidatePath("/guests")
  revalidatePath("/event", "layout")
}
