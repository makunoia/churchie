/**
 * The one place that knows how to fold one person's duplicate record into another.
 *
 * Split out of the duplicate-profiles server action for the same reason
 * `promote-guest.ts` was split out of its four callers: the rules are worth testing
 * on their own, and a `"use server"` module exports every function as a callable
 * endpoint. `actions.ts` keeps `auth()`, the per-group transaction and
 * `revalidatePath`; everything below is the merge itself.
 *
 * Three invariants the whole file exists to hold:
 *
 * 1. **The losing rows are deleted.** Not archived, not linked, not left behind with a
 *    flag — `lib/people/duplicate-activity.ts` has always documented the merge as
 *    "one-way and irreversible", and a Guest quietly retained under the keeper's
 *    `memberId` was a record the admin did not choose to keep, invisible on the Guests
 *    list and on the duplicates page but very much still there.
 * 2. **Nothing the loser held is lost.** Because of (1) there is no row left to go and
 *    look at, so every re-point has to be exhaustive and every value the keeper refuses
 *    has to be reported. `mergeScalars` returns the refusals; the caller writes them to
 *    the keeper's `MemberLog`.
 * 3. **One row per person per event.** Two `EventRegistrant` rows for one human on one
 *    event is what made a completed merge still look like two people on the registrants
 *    screen. Duplicates are folded, not carried across.
 *
 * A note on ordering that is load-bearing throughout: **delete the loser before writing
 * the keeper**. `Member.email`, `Member.selfServiceToken`, `Guest.selfServiceToken` and
 * `Volunteer.leaderApprovalToken` are all unique, and a value copied from a row that
 * still exists collides with that row. The loser is read into memory first, so deleting
 * early costs nothing.
 */

import type { Guest, Member, Prisma, VolunteerStatus } from "@/app/generated/prisma/client"
import { db } from "@/lib/db"
import { mergePortalTokens } from "@/lib/people/portal-tokens"
import { formatPhilippinePhone } from "@/lib/utils"
import { repointFamilyLinks } from "@/lib/family-links"
import { buildStoredScheduleSlot } from "@/lib/matching/candidate-schedule"
import {
  MERGE_LOG_ACTION,
  describeMerge,
  mergeScalars,
  type FieldConflict,
  type FoldSummary,
  type MergeSpec,
} from "@/lib/people/merge-fields"
import { PROMOTABLE_GUEST_SELECT } from "@/lib/people/promote-guest"

type TxClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]

export type LoserRef = { id: string; type: "member" | "guest" }

export type MergeGroupInput = {
  keeperId: string
  keeperType: "member" | "guest"
  losers: LoserRef[]
  /** Admin running the merge. `MemberLog` has no actor column, so it goes in the text. */
  performedBy?: string | null
}

// ─── Field policies ───────────────────────────────────────────────────────────

/**
 * What a Member carries from another Member.
 *
 * An allowlist, not "everything minus a delete list". `smallGroupId` and `groupStatus`
 * are both absent on purpose — they move together or not at all, handled by
 * `resolveGroupPlacement` below, because copying `groupStatus` alone left the keeper
 * marked as a DGroup member with no DGroup, a state the schema documents as impossible.
 * `email` is absent for the same reason: it is unique and needs a lookup, not a copy.
 */
const MEMBER_FROM_MEMBER: MergeSpec = {
  nickname: "keeper-wins",
  phone: "keeper-wins",
  address: "keeper-wins",
  notes: "append",
  lifeStageId: "keeper-wins",
  ageRangeBucketId: "keeper-wins",
  gender: "keeper-wins",
  language: "union",
  birthMonth: "keeper-wins",
  birthYear: "keeper-wins",
  workCity: "keeper-wins",
  workIndustry: "keeper-wins",
  meetingPreference: "keeper-wins",
  dateJoined: "keeper-wins",
}

/**
 * Guest columns this branch must not copy straight across.
 *
 * `memberId` is the promotion link, `email` is unique and needs a lookup, and the three
 * schedule columns have no Member equivalent at all — they become a `SchedulePreference`
 * row instead. Each is handled by a dedicated resolver below.
 */
const GUEST_COLUMNS_HANDLED_ELSEWHERE = new Set([
  "memberId",
  "email",
  "scheduleDayOfWeek",
  "scheduleTimeStart",
  "scheduleTimeEnd",
])

const GUEST_FIELD_OVERRIDES: MergeSpec = { notes: "append", language: "union" }

/**
 * What a Member carries from a Guest — **derived** from `PROMOTABLE_GUEST_SELECT`, not
 * hand-listed.
 *
 * That constant is the single definition of what a Guest brings into a Member, and this
 * branch keeping its own copy is exactly how `notes`, the schedule and the claimed DGroup
 * came to be dropped here while `promoteGuestRecord` carried them. Deriving it means a
 * column added to the promotion seam is carried by the merge automatically, which is the
 * property the seam was created for (CCF-123) and that this fifth copy never had.
 */
const MEMBER_FROM_GUEST: MergeSpec = Object.fromEntries(
  Object.keys(PROMOTABLE_GUEST_SELECT)
    .filter((column) => !GUEST_COLUMNS_HANDLED_ELSEWHERE.has(column))
    .map((column) => [column, GUEST_FIELD_OVERRIDES[column] ?? "keeper-wins"]),
)

const GUEST_FROM_GUEST: MergeSpec = {
  nickname: "keeper-wins",
  phone: "keeper-wins",
  email: "keeper-wins",
  notes: "append",
  lifeStageId: "keeper-wins",
  ageRangeBucketId: "keeper-wins",
  gender: "keeper-wins",
  language: "union",
  birthMonth: "keeper-wins",
  birthYear: "keeper-wins",
  workCity: "keeper-wins",
  workIndustry: "keeper-wins",
  meetingPreference: "keeper-wins",
}

const REGISTRANT_SPEC: MergeSpec = {
  firstName: "keeper-wins",
  lastName: "keeper-wins",
  nickname: "keeper-wins",
  email: "keeper-wins",
  mobileNumber: "keeper-wins",
  paymentReference: "keeper-wins",
  dietaryPreference: "keeper-wins",
  dietaryOther: "keeper-wins",
  registrationClusterId: "keeper-wins",
  attendedAt: "keeper-wins",
}

const VOLUNTEER_SPEC: MergeSpec = {
  notes: "append",
  leaderNotes: "append",
  assignedRoleId: "keeper-wins",
  signUpClusterId: "keeper-wins",
  attendedAt: "keeper-wins",
}

/** A pending signup cannot undo a decision. Confirmation wins conflicting decisions. */
const STATUS_RANK: Record<VolunteerStatus, number> = { Pending: 0, Rejected: 1, Confirmed: 2 }

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Merges every loser into the keeper. Runs inside a transaction the caller owns, so a
 * throw anywhere rolls the whole group back.
 *
 * Returns the number of losers actually merged — a loser that no longer exists counts
 * zero rather than one. It used to count one, so re-running a group (which happens
 * whenever the same pair is flagged by both phone and email) reported work it hadn't done.
 */
export async function mergeDuplicateGroup(
  tx: TxClient,
  input: MergeGroupInput,
): Promise<{ merged: number }> {
  if (input.losers.length === 0) throw new Error("No records to merge")
  if (input.losers.some((l) => l.id === input.keeperId)) {
    throw new Error("Keeper cannot be in the losers list")
  }

  return input.keeperType === "member"
    ? mergeIntoMember(tx, input.keeperId, input.losers, input.performedBy ?? null)
    : mergeIntoGuest(tx, input.keeperId, input.losers, input.performedBy ?? null)
}

// ─── Member keeper ────────────────────────────────────────────────────────────

async function mergeIntoMember(
  tx: TxClient,
  keeperId: string,
  losers: LoserRef[],
  performedBy: string | null,
): Promise<{ merged: number }> {
  const keeper = await tx.member.findUnique({ where: { id: keeperId } })
  if (!keeper) throw new Error("Keeper member not found")

  let merged = 0

  for (const ref of losers) {
    const done =
      ref.type === "member"
        ? await absorbMember(tx, keeper, ref.id, performedBy)
        : await absorbGuest(tx, keeper, ref.id, performedBy)
    if (done) merged++
  }

  return { merged }
}

/** Folds a losing Member into the keeper Member and deletes it. */
async function absorbMember(
  tx: TxClient,
  keeper: Member,
  loserId: string,
  performedBy: string | null,
): Promise<boolean> {
  const loser = await tx.member.findUnique({ where: { id: loserId } })
  if (!loser) return false

  const conflicts: FieldConflict[] = []
  const folds: FoldSummary[] = []

  // Counts for the audit line, read before the re-point moves them.
  const carried = {
    registration: await tx.eventRegistrant.count({ where: { memberId: loser.id } }),
    "volunteer role": await tx.volunteer.count({ where: { memberId: loser.id } }),
    "DGroup request": await tx.smallGroupMemberRequest.count({ where: { memberId: loser.id } }),
    "led DGroup": await tx.smallGroup.count({ where: { leaderId: loser.id } }),
  }

  // Person-scoped rows. `performedGroupLogs` and `confirmationSubmissions` are the two
  // that were missing: both are SetNull, so deleting the loser silently anonymised its
  // audit trail instead of failing loudly.
  const keeperVolunteers = await tx.volunteer.findMany({
    where: { memberId: keeper.id }, select: { id: true },
  })
  await tx.volunteer.updateMany({ where: { memberId: loser.id }, data: { memberId: keeper.id } })
  await tx.smallGroupMemberRequest.updateMany({ where: { memberId: loser.id }, data: { memberId: keeper.id } })
  await tx.smallGroupLog.updateMany({ where: { memberId: loser.id }, data: { memberId: keeper.id } })
  await tx.smallGroupLog.updateMany({ where: { performedByMemberId: loser.id }, data: { performedByMemberId: keeper.id } })
  await tx.confirmationSubmission.updateMany({ where: { submittedByMemberId: loser.id }, data: { submittedByMemberId: keeper.id } })
  await tx.memberLog.updateMany({ where: { memberId: loser.id }, data: { memberId: keeper.id } })
  await tx.schedulePreference.updateMany({ where: { memberId: loser.id }, data: { memberId: keeper.id } })
  await tx.smallGroup.updateMany({ where: { leaderId: loser.id }, data: { leaderId: keeper.id } })
  await repointFamilyLinks(tx, { memberId: loser.id }, { memberId: keeper.id })

  folds.push(...(await moveRegistrants(tx, { memberId: loser.id }, { memberId: keeper.id })))
  folds.push(...(await foldVolunteers(tx, keeper.id, new Set(keeperVolunteers.map(v => v.id)))))
  await dedupeSchedulePreferences(tx, keeper.id)

  // A Guest the loser was promoted from is a second identity on a record being deleted.
  // Its rows move to the keeper and it goes too — leaving it would resurrect it as an
  // active guest the moment the loser's `Guest.memberId` was set to null by the delete,
  // putting the same person straight back on the duplicates page.
  const loserGuest = await tx.guest.findUnique({ where: { memberId: loser.id } })

  // Delete before writing the keeper — see the file header.
  await tx.member.delete({ where: { id: loser.id } })

  const { update, conflicts: fieldConflicts } = mergeScalars(
    keeper as unknown as Record<string, unknown>,
    loser as unknown as Record<string, unknown>,
    MEMBER_FROM_MEMBER,
  )
  conflicts.push(...fieldConflicts)

  Object.assign(update, await resolveEmail(tx, keeper, loser.email, conflicts))
  Object.assign(update, resolveGroupPlacement(keeper, loser, conflicts))
  Object.assign(update, resolveSatellite({ ...keeper, ...update } as Member, loser.upwardSatellite, conflicts))
  Object.assign(
    update,
    mergePortalTokens(keeper, loser),
  )

  await applyKeeperUpdate(tx, keeper, update)
  if (loserGuest) {
    // The member has been deleted, so its guest promotion FK is now null.
    // Use the full guest merge to preserve profile values, schedules and audit history.
    await absorbGuest(tx, keeper, loserGuest.id, performedBy)
  }
  await logMerge(tx, keeper.id, {
    loserName: `${loser.firstName} ${loser.lastName}`.trim(),
    loserType: "member",
    loserId: loser.id,
    carried,
    folds,
    conflicts,
    performedBy,
  })

  return true
}

/** Folds a losing Guest into the keeper Member and deletes it. */
async function absorbGuest(
  tx: TxClient,
  keeper: Member,
  loserId: string,
  performedBy: string | null,
): Promise<boolean> {
  const loser = await tx.guest.findUnique({ where: { id: loserId } })
  if (!loser) return false

  // A guest already promoted to somebody else is not a duplicate of this keeper — it is
  // a different person's history. `getDuplicateProfiles` filters these out, but this is
  // a callable endpoint and a caller-supplied id must not be able to steal the link.
  if (loser.memberId && loser.memberId !== keeper.id) {
    throw new Error("That guest is already linked to another member. Merge those first.")
  }

  const conflicts: FieldConflict[] = []
  const carried = {
    registration: await tx.eventRegistrant.count({ where: { guestId: loser.id } }),
    "DGroup request": await tx.smallGroupMemberRequest.count({ where: { guestId: loser.id } }),
  }

  const folds = await absorbGuestRows(tx, loser.id, keeper.id)
  await dedupeSchedulePreferences(tx, keeper.id)

  await tx.guest.delete({ where: { id: loser.id } })

  const { update, conflicts: fieldConflicts } = mergeScalars(
    keeper as unknown as Record<string, unknown>,
    loser as unknown as Record<string, unknown>,
    MEMBER_FROM_GUEST,
  )
  conflicts.push(...fieldConflicts)

  Object.assign(update, await resolveEmail(tx, keeper, loser.email, conflicts))
  await recordClaimedGroup(tx, keeper, loser, conflicts)
  Object.assign(update, resolveSatellite({ ...keeper, ...update } as Member, loser.claimedSatellite, conflicts))
  Object.assign(update, mergePortalTokens(keeper, loser))

  await applyKeeperUpdate(tx, keeper, update)

  // The guest's single availability slot becomes a real SchedulePreference, the same
  // translation `buildPromotedMemberData` does. Copying the raw columns was never an
  // option — Member has no such columns — which is why they were simply dropped.
  const slot = buildStoredScheduleSlot(
    loser.scheduleDayOfWeek,
    loser.scheduleTimeStart,
    loser.scheduleTimeEnd,
  )
  if (slot) {
    const existing = await tx.schedulePreference.findFirst({
      where: {
        memberId: keeper.id,
        dayOfWeek: slot.dayOfWeek,
        timeStart: slot.timeStart,
        timeEnd: slot.timeEnd,
      },
      select: { id: true },
    })
    if (!existing) {
      await tx.schedulePreference.create({
        data: {
          memberId: keeper.id,
          dayOfWeek: slot.dayOfWeek,
          timeStart: slot.timeStart,
          timeEnd: slot.timeEnd,
        },
      })
    }
  }

  await logMerge(tx, keeper.id, {
    loserName: `${loser.firstName} ${loser.lastName}`.trim(),
    loserType: "guest",
    loserId: loser.id,
    carried,
    folds,
    conflicts,
    performedBy,
  })

  return true
}

/**
 * Moves every row a Guest owns onto a Member. Shared by the guest→member merge and by
 * the guest a losing Member was promoted from — both need the guest identity emptied
 * before the row is deleted.
 *
 * All four `guestId` foreign keys in the schema are covered. Three cascade
 * (`FamilyMember`, `EventRegistrant`, `SmallGroupMemberRequest`) so a miss would delete
 * data outright; `SmallGroupLog` is SetNull, so a miss there fails quietly and leaves an
 * audit row attributed to nobody.
 */
async function absorbGuestRows(
  tx: TxClient,
  guestId: string,
  memberId: string,
): Promise<FoldSummary[]> {
  await tx.smallGroupMemberRequest.updateMany({
    where: { guestId },
    data: { guestId: null, memberId },
  })
  await tx.smallGroupLog.updateMany({ where: { guestId }, data: { guestId: null, memberId } })
  await repointFamilyLinks(tx, { guestId }, { memberId })
  return moveRegistrants(tx, { guestId }, { memberId, guestId: null })
}

// ─── Guest keeper ─────────────────────────────────────────────────────────────

async function mergeIntoGuest(
  tx: TxClient,
  keeperId: string,
  losers: LoserRef[],
  performedBy: string | null,
): Promise<{ merged: number }> {
  const keeper = await tx.guest.findUnique({ where: { id: keeperId } })
  if (!keeper) throw new Error("Keeper guest not found")

  let merged = 0

  for (const ref of losers) {
    if (ref.type !== "guest") {
      throw new Error("Cannot merge a Member into a Guest. Pick the Member as the keeper.")
    }
    const loser = await tx.guest.findUnique({ where: { id: ref.id } })
    if (!loser) continue
    if (keeper.memberId && loser.memberId && keeper.memberId !== loser.memberId) {
      throw new Error("These guests are linked to different members. Merge those members first.")
    }

    // Same fold as the member branch: two guest rows registered for one event are one
    // person registered once, and carrying both across shows them twice on the roster.
    const folds = await moveRegistrants(tx, { guestId: loser.id }, { guestId: keeper.id })
    await tx.smallGroupMemberRequest.updateMany({ where: { guestId: loser.id }, data: { guestId: keeper.id } })
    await tx.smallGroupLog.updateMany({ where: { guestId: loser.id }, data: { guestId: keeper.id } })
    await repointFamilyLinks(tx, { guestId: loser.id }, { guestId: keeper.id })

    // `Guest.memberId` is unique, so a promotion link can only move once the loser row
    // is gone. Read it out before the delete.
    const inheritMemberId = loser.memberId && !keeper.memberId ? loser.memberId : null

    await tx.guest.delete({ where: { id: loser.id } })

    const { update, conflicts } = mergeScalars(
      keeper as unknown as Record<string, unknown>,
      loser as unknown as Record<string, unknown>,
      GUEST_FROM_GUEST,
    )
    // A schedule is one answer, and local/satellite claims are alternatives. Filling
    // their columns independently can invent a schedule or assert two placements.
    for (const [label, fields] of [
      ["schedule", ["scheduleDayOfWeek", "scheduleTimeStart", "scheduleTimeEnd"]],
      ["claimed DGroup", ["claimedSmallGroupId", "claimedSatellite"]],
    ] as const) {
      const kept = fields.map(field => keeper[field])
      const incoming = fields.map(field => loser[field])
      const hasValue = (values: readonly unknown[]) => values.some(value => value != null && value !== "")
      if (!hasValue(incoming)) continue
      if (!hasValue(kept)) {
        for (const field of fields) update[field] = loser[field]
      } else if (JSON.stringify(kept) !== JSON.stringify(incoming)) {
        conflicts.push({ field: label, kept: JSON.stringify(kept), dropped: JSON.stringify(incoming) })
      }
    }
    if (inheritMemberId) update.memberId = inheritMemberId
    Object.assign(update, mergePortalTokens(keeper, loser))
    if (typeof update.phone === "string") update.phone = formatPhilippinePhone(update.phone)

    if (Object.keys(update).length > 0) {
      await tx.guest.update({
        where: { id: keeper.id },
        data: update as Prisma.GuestUncheckedUpdateInput,
      })
      Object.assign(keeper, update)
    }

    // A Guest has no log table — `MemberLog.memberId` is required and there is no guest
    // equivalent — so the merge report has nowhere structured to go. Appending it to
    // `notes` keeps it on the record an admin will actually open, which matters more
    // here than tidiness: the losing row is deleted, so this is the only account of it.
    const note = describeMerge({
      loserName: `${loser.firstName} ${loser.lastName}`.trim(),
      loserType: "guest", loserId: loser.id, performedBy, carried: {}, folds, conflicts,
    })
    const notes = keeper.notes ? `${keeper.notes.trimEnd()}\n\n${note}` : note
    await tx.guest.update({ where: { id: keeper.id }, data: { notes } })
    keeper.notes = notes

    merged++
  }

  return { merged }
}

// ─── Registrant folding ───────────────────────────────────────────────────────

type PersonWhere = { memberId: string; guestId?: never } | { guestId: string; memberId?: never }
type PersonData = { memberId?: string | null; guestId?: string | null }

/**
 * Re-points a person's registrations onto the keeper, folding any that land on an event
 * where the keeper is already registered.
 *
 * `EventRegistrant` has no unique constraint on `[eventId, memberId]`, so the old
 * straight `updateMany` produced two rows for one human on one event — the person
 * appeared twice on the registrants list, which is what made a completed merge look
 * like it had not run.
 */
async function moveRegistrants(
  tx: TxClient,
  from: PersonWhere,
  to: PersonData,
): Promise<FoldSummary[]> {
  const keeperId = to.memberId
  const incoming = await tx.eventRegistrant.findMany({
    where: from,
    select: { id: true, eventId: true },
  })
  if (incoming.length === 0) return []

  // The keeper's existing rows, read before the move so the two sets stay distinguishable.
  const existing = keeperId
    ? await tx.eventRegistrant.findMany({
        where: { memberId: keeperId },
        select: { id: true, eventId: true },
      })
    : await tx.eventRegistrant.findMany({
        where: { guestId: to.guestId as string },
        select: { id: true, eventId: true },
      })
  const keepByEvent = new Map(existing.map((r) => [r.eventId, r.id]))
  const originalSeats = await tx.breakoutGroupMember.findMany({
    where: { registrantId: { in: existing.map(row => row.id) } },
    select: { registrantId: true, breakoutGroupId: true },
  })
  const seatKey = (seat: { registrantId: string; breakoutGroupId: string }) =>
    `${seat.registrantId}:${seat.breakoutGroupId}`
  const originalSeatKeys = new Set(originalSeats.map(seatKey))

  await tx.eventRegistrant.updateMany({ where: from, data: to })

  const folds: FoldSummary[] = []
  for (const row of incoming) {
    const keepId = keepByEvent.get(row.eventId)
    if (!keepId || keepId === row.id) {
      // First registration this person has on the event — it just becomes the keeper's.
      if (!keepId) keepByEvent.set(row.eventId, row.id)
      continue
    }
    folds.push(await foldRegistrant(tx, keepId, row.id))
  }

  // Collab tables can seat registrations from different events. Those registrations
  // must both survive, but the merged person must still occupy only one table per
  // owner. Per-registration folding above cannot see this cross-event collision.
  const seats = await tx.breakoutGroupMember.findMany({
    where: { registrant: to },
    orderBy: { assignedAt: "asc" },
    select: {
      registrantId: true, breakoutGroupId: true,
      breakoutGroup: { select: { eventId: true, clusterId: true, name: true } },
    },
  })
  const orderedSeats = [
    ...seats.filter(seat => originalSeatKeys.has(seatKey(seat))),
    ...seats.filter(seat => !originalSeatKeys.has(seatKey(seat))),
  ]
  const occupied = new Map<string, string>()
  for (const seat of orderedSeats) {
    const owner = ownerKey(seat.breakoutGroup)
    const keptTable = occupied.get(owner)
    if (keptTable === undefined) {
      occupied.set(owner, seat.breakoutGroup.name)
      continue
    }
    await tx.breakoutGroupMember.delete({
      where: { breakoutGroupId_registrantId: {
        breakoutGroupId: seat.breakoutGroupId, registrantId: seat.registrantId,
      } },
    })
    folds.push({ kind: "breakout seat", eventName: owner, conflicts: [
      { field: "table", kept: keptTable, dropped: seat.breakoutGroup.name },
    ] })
  }

  return folds
}

/** Moves one registrant row's dependents onto another, then deletes it. */
async function foldRegistrant(tx: TxClient, keepId: string, dropId: string): Promise<FoldSummary> {
  const drop = await tx.eventRegistrant.findUniqueOrThrow({
    where: { id: dropId },
    include: { event: { select: { name: true } } },
  })
  const keep = await tx.eventRegistrant.findUniqueOrThrow({ where: { id: keepId } })

  // Attendance — `@@unique([occurrenceId, registrantId])`. A sitting both rows recorded
  // is one arrival, so the duplicate is simply left to cascade away with the row.
  const keptOccurrences = new Set(
    (
      await tx.occurrenceAttendee.findMany({
        where: { registrantId: keepId },
        select: { occurrenceId: true },
      })
    ).map((a) => a.occurrenceId),
  )
  const movableAttendance = (
    await tx.occurrenceAttendee.findMany({
      where: { registrantId: dropId },
      select: { id: true, occurrenceId: true },
    })
  ).filter((a) => !keptOccurrences.has(a.occurrenceId))
  if (movableAttendance.length > 0) {
    await tx.occurrenceAttendee.updateMany({
      where: { id: { in: movableAttendance.map((a) => a.id) } },
      data: { registrantId: keepId },
    })
  }

  // Breakout seats — one seat per person *per owner*, not per row, so a seat is only
  // movable when the keeper holds none in that owner's set. Otherwise the person would
  // come out of the merge sitting at two tables of the same event.
  const keptSeats = await tx.breakoutGroupMember.findMany({
    where: { registrantId: keepId },
    select: { breakoutGroupId: true, breakoutGroup: { select: { eventId: true, clusterId: true } } },
  })
  const occupiedOwners = new Set(keptSeats.map((s) => ownerKey(s.breakoutGroup)))
  const dropSeats = await tx.breakoutGroupMember.findMany({
    where: { registrantId: dropId },
    select: { breakoutGroupId: true, breakoutGroup: { select: { eventId: true, clusterId: true } } },
  })
  for (const seat of dropSeats) {
    if (occupiedOwners.has(ownerKey(seat.breakoutGroup))) continue
    occupiedOwners.add(ownerKey(seat.breakoutGroup))
    await tx.breakoutGroupMember.update({
      where: {
        breakoutGroupId_registrantId: { breakoutGroupId: seat.breakoutGroupId, registrantId: dropId },
      },
      data: { registrantId: keepId },
    })
  }

  // Baptism opt-in — `registrantId` is unique *globally*, so at most one survives.
  const keepBaptism = await tx.baptismOptIn.findUnique({ where: { registrantId: keepId } })
  if (!keepBaptism) {
    const dropBaptism = await tx.baptismOptIn.findUnique({ where: { registrantId: dropId } })
    if (dropBaptism) {
      await tx.baptismOptIn.update({
        where: { id: dropBaptism.id },
        data: { registrantId: keepId },
      })
    }
  }

  // Bus seats — no unique constraint, so dedupe by bus.
  const keptBuses = new Set(
    (
      await tx.busPassenger.findMany({ where: { registrantId: keepId }, select: { busId: true } })
    ).map((p) => p.busId),
  )
  const movableBuses = (
    await tx.busPassenger.findMany({
      where: { registrantId: dropId },
      select: { id: true, busId: true },
    })
  ).filter((p) => !keptBuses.has(p.busId))
  if (movableBuses.length > 0) {
    await tx.busPassenger.updateMany({
      where: { id: { in: movableBuses.map((p) => p.id) } },
      data: { registrantId: keepId },
    })
  }

  await tx.eventRegistrant.delete({ where: { id: dropId } })

  const { update, conflicts } = mergeScalars(
    keep as unknown as Record<string, unknown>,
    drop as unknown as Record<string, unknown>,
    REGISTRANT_SPEC,
  )
  // Paid is a fact about the person, not the row: if either row was paid, they paid.
  if (drop.isPaid && !keep.isPaid) update.isPaid = true
  if (Object.keys(update).length > 0) {
    await tx.eventRegistrant.update({
      where: { id: keepId },
      data: update as Prisma.EventRegistrantUncheckedUpdateInput,
    })
  }

  return { kind: "registration", eventName: drop.event.name, conflicts }
}

/** A breakout table belongs to exactly one owner — an event or a cluster. */
function ownerKey(group: { eventId: string | null; clusterId: string | null }): string {
  return group.eventId ? `event:${group.eventId}` : `cluster:${group.clusterId}`
}

// ─── Volunteer folding ────────────────────────────────────────────────────────

/**
 * Collapses a member's duplicate `Volunteer` rows, one per event.
 *
 * Called after the re-point, so both rows already belong to the keeper. Nine relations
 * hang off `Volunteer` and two of them carry uniques that include `volunteerId`, so this
 * is the widest fold in the file — but leaving it undone means the person shows twice on
 * the event's Volunteers screen and holds two sign-ups for one shift.
 */
async function foldVolunteers(tx: TxClient, memberId: string, keeperIds: Set<string>): Promise<FoldSummary[]> {
  const rows = await tx.volunteer.findMany({
    where: { memberId },
    orderBy: { createdAt: "asc" },
    select: { id: true, eventId: true, event: { select: { name: true } } },
  })

  const keepByEvent = new Map<string, string>()
  const folds: FoldSummary[] = []

  // Prefer rows owned by the selected keeper before the re-point. Signup age must
  // not decide which committee, role, and public approval link survive.
  const ordered = [...rows.filter(row => keeperIds.has(row.id)), ...rows.filter(row => !keeperIds.has(row.id))]
  for (const row of ordered) {
    const keepId = keepByEvent.get(row.eventId)
    if (!keepId) {
      keepByEvent.set(row.eventId, row.id)
      continue
    }
    const conflicts = await foldVolunteer(tx, keepId, row.id)
    folds.push({ kind: "volunteer role", eventName: row.event.name, conflicts })
  }

  return folds
}

async function foldVolunteer(tx: TxClient, keepId: string, dropId: string): Promise<FieldConflict[]> {
  const keep = await tx.volunteer.findUniqueOrThrow({ where: { id: keepId } })
  const drop = await tx.volunteer.findUniqueOrThrow({ where: { id: dropId } })

  // Attendance — `@@unique([occurrenceId, volunteerId])`.
  const keptOccurrences = new Set(
    (
      await tx.occurrenceAttendee.findMany({
        where: { volunteerId: keepId },
        select: { occurrenceId: true },
      })
    ).map((a) => a.occurrenceId),
  )
  const movableAttendance = (
    await tx.occurrenceAttendee.findMany({
      where: { volunteerId: dropId },
      select: { id: true, occurrenceId: true },
    })
  ).filter((a) => !keptOccurrences.has(a.occurrenceId))
  if (movableAttendance.length > 0) {
    await tx.occurrenceAttendee.updateMany({
      where: { id: { in: movableAttendance.map((a) => a.id) } },
      data: { volunteerId: keepId },
    })
  }

  // Catch Mech volunteer follow-up session — `@@unique([eventId, volunteerId])`. Both
  // rows are on the same event by construction, so the keeper's own session wins outright.
  const keepSession = await tx.catchMechVolunteerSession.findFirst({
    where: { volunteerId: keepId },
    select: { id: true },
  })
  if (!keepSession) {
    await tx.catchMechVolunteerSession.updateMany({
      where: { volunteerId: dropId },
      data: { volunteerId: keepId },
    })
  } else {
    const dropSessions = await tx.catchMechVolunteerSession.findMany({
      where: { volunteerId: dropId }, select: { id: true },
    })
    await tx.confirmationSubmission.updateMany({
      where: { volunteerSessionId: { in: dropSessions.map(session => session.id) } },
      data: { volunteerSessionId: keepSession.id },
    })
  }

  await tx.catchMechSession.updateMany({
    where: { facilitatorVolunteerId: dropId },
    data: { facilitatorVolunteerId: keepId },
  })
  await tx.confirmationSubmission.updateMany({
    where: { facilitatorVolunteerId: dropId },
    data: { facilitatorVolunteerId: keepId },
  })
  await tx.smallGroupMemberRequest.updateMany({
    where: { declinedByVolunteerId: dropId },
    data: { declinedByVolunteerId: keepId },
  })
  await tx.occurrenceSubFacilitator.updateMany({
    where: { substituteId: dropId },
    data: { substituteId: keepId },
  })

  // Bus seats — dedupe by bus.
  const keptBuses = new Set(
    (await tx.busPassenger.findMany({ where: { volunteerId: keepId }, select: { busId: true } })).map(
      (p) => p.busId,
    ),
  )
  const movableBuses = (
    await tx.busPassenger.findMany({
      where: { volunteerId: dropId },
      select: { id: true, busId: true },
    })
  ).filter((p) => !keptBuses.has(p.busId))
  if (movableBuses.length > 0) {
    await tx.busPassenger.updateMany({
      where: { id: { in: movableBuses.map((p) => p.id) } },
      data: { volunteerId: keepId },
    })
  }

  await tx.breakoutGroup.updateMany({ where: { facilitatorId: dropId }, data: { facilitatorId: keepId } })
  await tx.breakoutGroup.updateMany({ where: { coFacilitatorId: dropId }, data: { coFacilitatorId: keepId } })
  // One person cannot be both halves of a table's staffing — if the two folded rows led
  // and co-led the same group, the co-facilitator slot opens back up.
  await tx.breakoutGroup.updateMany({
    where: { facilitatorId: keepId, coFacilitatorId: keepId },
    data: { coFacilitatorId: null },
  })

  // `leaderApprovalToken` is unique — the loser has to be gone before it can move.
  await tx.volunteer.delete({ where: { id: dropId } })

  const { update, conflicts } = mergeScalars(
    keep as unknown as Record<string, unknown>,
    drop as unknown as Record<string, unknown>,
    VOLUNTEER_SPEC,
  )
  if (keep.committeeId !== drop.committeeId) {
    delete update.assignedRoleId
    conflicts.push({ field: "committee", kept: keep.committeeId, dropped: drop.committeeId })
    if (drop.assignedRoleId) conflicts.push({
      field: "assigned role", kept: keep.assignedRoleId ?? "(none)", dropped: drop.assignedRoleId,
    })
  }
  if (keep.preferredRoleId !== drop.preferredRoleId) conflicts.push({
    field: "preferred role", kept: keep.preferredRoleId, dropped: drop.preferredRoleId,
  })
  // A decision already given must not be withdrawn by a merge.
  if (STATUS_RANK[drop.status] > STATUS_RANK[keep.status]) update.status = drop.status
  if (!keep.leaderApprovalToken && drop.leaderApprovalToken) {
    update.leaderApprovalToken = drop.leaderApprovalToken
  }
  if (Object.keys(update).length > 0) {
    await tx.volunteer.update({
      where: { id: keepId },
      data: update as Prisma.VolunteerUncheckedUpdateInput,
    })
  }
  return conflicts
}

// ─── Coupled / unique fields ──────────────────────────────────────────────────

/**
 * `Member.email` is unique, and the loser's address may belong to a third member
 * entirely — a second duplicate of the same person, which is the ordinary case when
 * someone appears three times.
 *
 * Copying it blindly threw P2002 and rolled the whole merge back: nothing transferred
 * and the loser still there, reported to the admin as a bare "data conflict". Taking it
 * only when it is free, and reporting it when it is not, is the same escape hatch
 * `promoteGuestRecord` offers its public callers via `reuseExistingMemberByEmail`.
 */
async function resolveEmail(
  tx: TxClient,
  keeper: Member,
  loserEmail: string | null,
  conflicts: FieldConflict[],
): Promise<{ email?: string }> {
  if (!loserEmail?.trim()) return {}
  const email = loserEmail.trim()
  if (keeper.email) {
    if (keeper.email !== email) {
      conflicts.push({ field: "email", kept: keeper.email, dropped: email })
    }
    return {}
  }
  const taken = await tx.member.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, id: { not: keeper.id } },
    select: { firstName: true, lastName: true },
  })
  if (taken) {
    conflicts.push({
      field: "email",
      kept: "(none)",
      dropped: `${email} — already used by ${taken.firstName} ${taken.lastName}`,
    })
    return {}
  }
  return { email }
}

/**
 * `smallGroupId` and `groupStatus` move as a pair or not at all.
 *
 * They used to be handled separately — `smallGroupId` deliberately excluded to avoid
 * circular references, `groupStatus` carried by the generic field copy — which left a
 * keeper with no DGroup marked as a DGroup Member. Every screen that reads
 * `groupStatus` then claimed a membership no group had a record of.
 */
function resolveGroupPlacement(
  keeper: Member,
  loser: Member,
  conflicts: FieldConflict[],
): { smallGroupId?: string; groupStatus?: Member["groupStatus"] } {
  if (!loser.smallGroupId) return {}
  if (keeper.upwardSatellite) {
    conflicts.push({ field: "DGroup", kept: keeper.upwardSatellite, dropped: loser.smallGroupId })
    return {}
  }
  if (keeper.smallGroupId) {
    if (keeper.smallGroupId !== loser.smallGroupId) {
      conflicts.push({
        field: "DGroup",
        kept: keeper.smallGroupId,
        dropped: loser.smallGroupId,
      })
    }
    return {}
  }
  return { smallGroupId: loser.smallGroupId, groupStatus: loser.groupStatus ?? "Member" }
}

/** Preserve a self-reported DGroup as a request awaiting confirmation. */
async function recordClaimedGroup(
  tx: TxClient,
  keeper: Member,
  loser: Guest,
  conflicts: FieldConflict[],
): Promise<void> {
  if (!loser.claimedSmallGroupId) return
  if (keeper.smallGroupId) {
    if (keeper.smallGroupId !== loser.claimedSmallGroupId) {
      conflicts.push({
        field: "DGroup",
        kept: keeper.smallGroupId,
        dropped: `${loser.claimedSmallGroupId} (self-reported at check-in)`,
      })
    }
    return
  }
  const group = await tx.smallGroup.findUnique({
    where: { id: loser.claimedSmallGroupId },
    select: { id: true, status: true },
  })
  if (!group || group.status === "Inactive" || keeper.upwardSatellite) {
    conflicts.push({ field: "claimed DGroup", kept: keeper.upwardSatellite ?? "(unassigned)", dropped: loser.claimedSmallGroupId })
    return
  }
  const pending = await tx.smallGroupMemberRequest.findFirst({
    where: { memberId: keeper.id, status: "Pending" }, select: { id: true, smallGroupId: true },
  })
  if (pending && pending.smallGroupId !== group.id) {
    conflicts.push({ field: "claimed DGroup", kept: pending.smallGroupId ?? "(pending placement)", dropped: group.id })
  }
  if (!pending) {
    await tx.smallGroupMemberRequest.create({ data: {
      memberId: keeper.id, smallGroupId: group.id, status: "Pending",
      notes: "Self-reported DGroup carried from a duplicate profile; awaiting confirmation.",
    } })
    await tx.smallGroupLog.create({ data: {
      smallGroupId: group.id, memberId: keeper.id, action: "TempAssignmentCreated",
      toGroupId: group.id, description: "Duplicate profile's DGroup claim awaits confirmation.",
    } })
  }
  return
}

/**
 * `upwardSatellite` is mutually exclusive with `smallGroupId` — a leader is either here
 * or at another satellite — so it is only taken when the keeper has neither.
 */
function resolveSatellite(
  keeper: Member,
  satellite: string | null,
  conflicts: FieldConflict[],
): { upwardSatellite?: string } {
  if (!satellite) return {}
  if (keeper.upwardSatellite) {
    if (keeper.upwardSatellite !== satellite) {
      conflicts.push({ field: "satellite", kept: keeper.upwardSatellite, dropped: satellite })
    }
    return {}
  }
  if (keeper.smallGroupId) {
    conflicts.push({ field: "satellite", kept: "(has a local DGroup)", dropped: satellite })
    return {}
  }
  return { upwardSatellite: satellite }
}

// ─── Shared writes ────────────────────────────────────────────────────────────

async function applyKeeperUpdate(
  tx: TxClient,
  keeper: Member,
  update: Record<string, unknown>,
): Promise<void> {
  if (typeof update.phone === "string") update.phone = formatPhilippinePhone(update.phone)
  await tx.member.update({
    where: { id: keeper.id },
    data: update as Prisma.MemberUncheckedUpdateInput,
  })
  // Keep the in-memory keeper current so a second loser in the same group contests
  // against what the first one already wrote.
  Object.assign(keeper, update)
  await synchronizeLedGroups(tx, keeper)
}

async function synchronizeLedGroups(tx: TxClient, keeper: Member): Promise<void> {
  const led = await tx.smallGroup.findMany({ where: { leaderId: keeper.id }, select: { id: true } })
  const ledIds = new Set(led.map(g => g.id))
  let parentId = keeper.smallGroupId
  const visited = new Set<string>()
  while (parentId) {
    if (ledIds.has(parentId) || visited.has(parentId)) {
      throw new Error("This merge would create a circular DGroup hierarchy. Resolve the group placement first.")
    }
    visited.add(parentId)
    const parent = await tx.smallGroup.findUnique({ where: { id: parentId }, select: { parentGroupId: true } })
    parentId = parent?.parentGroupId ?? null
  }
  await tx.smallGroup.updateMany({ where: { leaderId: keeper.id }, data: {
    parentGroupId: keeper.smallGroupId, parentSatellite: keeper.smallGroupId ? null : keeper.upwardSatellite,
  } })
}

/** Drops schedule slots that became identical once both members' were on one record. */
async function dedupeSchedulePreferences(tx: TxClient, memberId: string): Promise<void> {
  const prefs = await tx.schedulePreference.findMany({
    where: { memberId },
    orderBy: { createdAt: "asc" },
    select: { id: true, dayOfWeek: true, timeStart: true, timeEnd: true },
  })
  const seen = new Set<string>()
  const dupes: string[] = []
  for (const p of prefs) {
    const key = `${p.dayOfWeek}|${p.timeStart}|${p.timeEnd ?? ""}`
    if (seen.has(key)) dupes.push(p.id)
    else seen.add(key)
  }
  if (dupes.length > 0) {
    await tx.schedulePreference.deleteMany({ where: { id: { in: dupes } } })
  }
}

type MergeLogInput = Parameters<typeof describeMerge>[0]

async function logMerge(tx: TxClient, memberId: string, report: MergeLogInput): Promise<void> {
  await tx.memberLog.create({
    data: {
      memberId,
      action: MERGE_LOG_ACTION,
      description: describeMerge(report),
    },
  })
}
