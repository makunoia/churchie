"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireBreakoutWrite } from "@/lib/events/require-event-write"
import { breakoutGroupSchema } from "@/lib/validations/breakout-group"
import type { BreakoutGroupFormValues } from "@/lib/validations/breakout-group"
import { matchBreakoutGroups } from "@/lib/matching"
import type { Prisma } from "@/app/generated/prisma/client"
import { unassignedCandidateWhere } from "@/lib/breakouts/candidate-pool"
import { anyOwner, isClusterOwner, type BreakoutOwner, type BreakoutSet } from "@/lib/breakouts/owner"
import {
  breakoutCandidateEventIds,
  breakoutCandidateWhere,
} from "@/lib/breakouts/candidate-events"
import { resolvePoolScope, resolveSurfaceBreakoutOwner } from "@/lib/events/pool-scope"
import { isEventStaffViewer } from "@/lib/events/staff-viewer"
import { assignBreakoutForRegistrant } from "@/lib/events/registration-core"
import { fetchBreakoutAvailability } from "@/lib/breakout-suggestion-server"
import {
  breakoutPickerOptions,
  resolveBreakoutNotice,
  suggestBreakoutGroup,
  withoutOccupancy,
} from "@/lib/breakout-suggestion"
import type { CheckinBreakoutChoices } from "@/lib/breakouts/checkin-choices"
import type { Gender } from "@/app/generated/prisma/client"
import { personKeyFor } from "@/lib/clusters/roster"
import { MAX_BREAKOUT_BATCH } from "@/lib/breakouts/candidate-filters"
import { registrantName, registrantNameSelect } from "@/lib/metadata"
import type { BatchFailure } from "@/components/batch/types"
import {
  tryCreateSmallGroupRequestFromBreakout,
  tryCancelSmallGroupRequestFromBreakout,
  tryTransferSmallGroupRequestFromBreakout,
} from "@/lib/create-small-group-request"
import { clearedMatchingProfile, missingTimothyFields } from "@/lib/breakouts/profile"

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string }

/**
 * Every action here is scoped by a {@link BreakoutOwner} rather than a bare
 * event id (CCF-148). A breakout group belongs either to one event — a standing
 * table — or to a Collab cluster, whose tables are set up for the day. The owner
 * does double duty: it authorizes the write and it scopes it, exactly as the
 * event id used to.
 *
 * Where a query used `{ id: groupId, eventId }` it now uses
 * `{ id: groupId, ...owner }`, which is the same shape of guard — the point of
 * scoping the write itself, rather than trusting a separate read, is unchanged.
 */

/**
 * Which events' volunteers may staff this owner's tables.
 *
 * The same list as the candidate events, but named separately because the two
 * questions are separate and only happen to coincide: "whose registrants may sit
 * here" and "whose volunteers may run this". Keeping them distinct is what lets
 * the union half and the ownership half of CCF-148 be reasoned about apart.
 */
async function poolVolunteerEventIds(owner: BreakoutOwner): Promise<string[]> {
  return breakoutCandidateEventIds(owner)
}

/**
 * Revalidate the surfaces a breakout change is visible on.
 *
 * The two owners live at different paths, and the event owner additionally
 * touches the public pickers. Centralised so a new action can't revalidate the
 * event paths for a cluster-owned group and silently show stale tables.
 */
function revalidateBreakoutSurfaces(
  owner: BreakoutOwner,
  opts?: { groupId?: string; publicPickers?: boolean; sessions?: boolean }
) {
  if (isClusterOwner(owner)) {
    const { clusterId } = owner
    revalidatePath(`/cluster/${clusterId}/breakouts`)
    if (opts?.groupId) revalidatePath(`/cluster/${clusterId}/breakouts/${opts.groupId}`)
    revalidatePath(`/cluster/${clusterId}/dashboard`)
    revalidatePath(`/cluster/${clusterId}/registrants`)
    return
  }
  const { eventId } = owner
  revalidatePath(`/event/${eventId}/breakouts`)
  if (opts?.groupId) revalidatePath(`/event/${eventId}/breakouts/${opts.groupId}`)
  revalidatePath(`/event/${eventId}/registrants`)
  if (opts?.publicPickers) {
    revalidatePath(`/events/${eventId}/register`)
    revalidatePath(`/events/${eventId}/walk-in`)
    revalidatePath(`/event/${eventId}/forms/EventRegister`)
  }
  // Session detail renders each group's capacity, so a roster change moves a
  // number there too. The occurrence id isn't known here — revalidate the segment.
  if (opts?.sessions) revalidatePath(`/event/${eventId}/sessions`, "layout")
}

// ─── Timothy profile validation ───────────────────────────────────────────────

/**
 * When a facilitator volunteer is a Timothy (has no led small groups),
 * the breakout group's matching profile must be filled in so that the system
 * has enough data to set up their future small group.
 *
 * `missingTimothyFields` is shared with both edit drawers so the client can't
 * accept a profile this rejects.
 */
async function validateTimothyProfile(
  facilitatorId: string | null | undefined,
  profile: Parameters<typeof missingTimothyFields>[0]
): Promise<string | null> {
  if (!facilitatorId) return null

  const volunteer = await db.volunteer.findUnique({
    where: { id: facilitatorId },
    select: { member: { select: { _count: { select: { ledGroups: true } } } } },
  })
  if (!volunteer) return null

  const isTimothy = volunteer.member._count.ledGroups === 0
  if (!isTimothy) return null

  const missing = missingTimothyFields(profile)
  if (missing.length > 0) {
    return `Timothy profile requires: ${missing.join(", ")}`
  }
  return null
}

// ─── Breakout Group CRUD ──────────────────────────────────────────────────────

export async function createBreakoutGroup(
  owner: BreakoutOwner,
  data: BreakoutGroupFormValues
): Promise<ActionResult<{ id: string }>> {
  const denied = await requireBreakoutWrite(owner)
  if (denied) return { success: false, error: denied.error }

  const parsed = breakoutGroupSchema.safeParse(data)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }
  }
  // `manualAssignOnly` is destructured out with the non-matching fields on
  // purpose: `profile` is what `validateTimothyProfile` reads and what
  // `clearedMatchingProfile` mirrors, and this is a routing setting, not a
  // criterion a Timothy has to fill in.
  const {
    name,
    facilitatorId,
    coFacilitatorId,
    memberLimit,
    manualAssignOnly,
    linkedSmallGroupId,
    ...profile
  } = parsed.data

  const timothyError = await validateTimothyProfile(facilitatorId, profile)
  if (timothyError) return { success: false, error: timothyError }

  try {
    const group = await db.breakoutGroup.create({
      data: {
        // Spreading the owner sets exactly one of the two columns, so the XOR
        // holds by construction rather than by a check after the fact.
        ...owner,
        name,
        facilitatorId: facilitatorId ?? null,
        coFacilitatorId: coFacilitatorId ?? null,
        memberLimit: memberLimit ?? null,
        manualAssignOnly: manualAssignOnly ?? false,
        linkedSmallGroupId: linkedSmallGroupId ?? null,
        lifeStages: { connect: profile.lifeStageIds.map((id) => ({ id })) },
        genderFocus: profile.genderFocus ?? null,
        language: profile.language,
        ageRangeMin: profile.ageRangeMin ?? null,
        ageRangeMax: profile.ageRangeMax ?? null,
      },
      select: { id: true },
    })
    revalidateBreakoutSurfaces(owner)
    return { success: true, data: { id: group.id } }
  } catch {
    return { success: false, error: "Failed to create breakout group" }
  }
}

export async function updateBreakoutGroup(
  groupId: string,
  owner: BreakoutOwner,
  data: BreakoutGroupFormValues
): Promise<ActionResult> {
  const denied = await requireBreakoutWrite(owner)
  if (denied) return { success: false, error: denied.error }

  const parsed = breakoutGroupSchema.safeParse(data)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }
  }
  // See `createBreakoutGroup` on why `manualAssignOnly` is kept out of `profile`.
  const {
    name,
    facilitatorId,
    coFacilitatorId,
    memberLimit,
    manualAssignOnly,
    linkedSmallGroupId,
    ...profile
  } = parsed.data

  const timothyError = await validateTimothyProfile(facilitatorId, profile)
  if (timothyError) return { success: false, error: timothyError }

  // Scoped by owner: `requireBreakoutWrite` checks the *argument* owner, so
  // without this an admin scoped to event A could pass event B's group id.
  const existing = await db.breakoutGroup.findFirst({
    where: { id: groupId, ...owner },
    select: { facilitatorId: true, coFacilitatorId: true, manualAssignOnly: true },
  })
  if (!existing) return { success: false, error: "Breakout group not found" }

  // An absent key means "not on the form", not "clear it". Neither edit drawer
  // has a co-facilitator control — that slot is assigned from the detail page —
  // so writing `coFacilitatorId ?? null` silently detached the co-facilitator on
  // every save from either drawer.
  const nextFacilitatorId = facilitatorId === undefined ? existing.facilitatorId : facilitatorId
  const nextCoFacilitatorId =
    coFacilitatorId === undefined ? existing.coFacilitatorId : coFacilitatorId
  // Same rule: a caller that never showed the control must not switch it off.
  const nextManualAssignOnly =
    manualAssignOnly === undefined ? existing.manualAssignOnly : manualAssignOnly

  // The schema compares the two *submitted* ids; it can't see a stored one that
  // wasn't submitted, so the same volunteer could land in both slots.
  if (nextFacilitatorId !== null && nextFacilitatorId === nextCoFacilitatorId) {
    return {
      success: false,
      error: "Facilitator and co-facilitator must be different volunteers",
    }
  }

  // Emptying the facilitator slot clears the profile, whatever the form sent —
  // the drawer blanks its own fields on the same change, but the server is the
  // one that decides. It's the *transition* that clears: a group created without
  // a facilitator keeps criteria someone typed, and later saves don't wipe them.
  const unlinkedFacilitator = existing.facilitatorId !== null && nextFacilitatorId === null

  try {
    await db.breakoutGroup.update({
      where: { id: groupId },
      data: {
        name,
        facilitatorId: nextFacilitatorId,
        coFacilitatorId: nextCoFacilitatorId,
        memberLimit: memberLimit ?? null,
        // Outside the ternary below: emptying the facilitator clears the
        // *matching profile*, and how a group is reached is not one of its
        // criteria. A table held back for manual assignment stays held back when
        // its facilitator drops out.
        manualAssignOnly: nextManualAssignOnly,
        ...(unlinkedFacilitator
          ? { linkedSmallGroupId: null, ...clearedMatchingProfile() }
          : {
              linkedSmallGroupId: linkedSmallGroupId ?? null,
              lifeStages: { set: profile.lifeStageIds.map((id) => ({ id })) },
              genderFocus: profile.genderFocus ?? null,
              language: profile.language,
              ageRangeMin: profile.ageRangeMin ?? null,
              ageRangeMax: profile.ageRangeMax ?? null,
            }),
      },
    })
    // The edit drawer is mounted on the detail page too. `publicPickers` because
    // the drawer edits what the public form *ranks* (gender focus, life stages,
    // member limit) and now what it suggests at all (`manualAssignOnly`) — the
    // same reason `setBreakoutGroupEnabled` passes it.
    revalidateBreakoutSurfaces(owner, { groupId, publicPickers: true })
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to update breakout group" }
  }
}

/**
 * Take a breakout group in or out of play.
 *
 * Off blocks every *automatic and public* route into the group — the
 * registration picker, the walk-in picker, auto-assign, match suggestions — and
 * nothing else. The roster, the facilitator and the catch-mech follow-through
 * stay exactly as they are, and an admin standing on the group's own screen can
 * still add or transfer people in deliberately. See `BreakoutGroup.isEnabled`.
 */
export async function setBreakoutGroupEnabled(
  groupId: string,
  owner: BreakoutOwner,
  isEnabled: boolean
): Promise<ActionResult> {
  const denied = await requireBreakoutWrite(owner)
  if (denied) return { success: false, error: denied.error }

  try {
    // updateMany so the owner scope is part of the write itself rather than a
    // separate read the next request could race past.
    const { count } = await db.breakoutGroup.updateMany({
      where: { id: groupId, ...owner },
      data: { isEnabled },
    })
    if (count === 0) return { success: false, error: "Breakout group not found" }

    // The public surfaces that offer the picker, and the form builder whose
    // Breakout warning counts how many groups are still switched on.
    revalidateBreakoutSurfaces(owner, { groupId, publicPickers: true })
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to update breakout group" }
  }
}

export async function deleteBreakoutGroup(
  groupId: string,
  owner: BreakoutOwner
): Promise<ActionResult> {
  const denied = await requireBreakoutWrite(owner)
  if (denied) return { success: false, error: denied.error }

  try {
    // deleteMany rather than delete so the owner scope is part of the write, the
    // way its siblings above have it. `delete({ where: { id } })` trusted the
    // caller's owner argument without ever checking the group belonged to it.
    const { count } = await db.breakoutGroup.deleteMany({ where: { id: groupId, ...owner } })
    if (count === 0) return { success: false, error: "Breakout group not found" }
    revalidateBreakoutSurfaces(owner)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to delete breakout group" }
  }
}

// ─── Registrant assignment ────────────────────────────────────────────────────

const breakoutBatchSchema = z.object({
  groupId: z.string().min(1, "Breakout group is required"),
  registrantIds: z
    .array(z.string().min(1))
    .max(MAX_BREAKOUT_BATCH, `Cannot add more than ${MAX_BREAKOUT_BATCH} registrants at once`),
})

/**
 * Every member who facilitates or co-facilitates *any* of the breakout groups in
 * play (CCF-87 — a facilitator can't also be a participant).
 *
 * One query for the whole set rather than a per-row lookup. Shared by the add and
 * transfer paths so the rule can't drift between them;
 * `autoAssignRegistrantToBreakout` keeps its own narrower existence check because
 * it runs unauthenticated on the public check-in path.
 *
 * Owner-scoped, so on a collab day a facilitator of one of the day's tables is
 * excluded from sitting at another of them — the tables are one set even though
 * the attendees arrive through two events.
 */
async function facilitatorMemberIds(owner: BreakoutOwner): Promise<Set<string>> {
  const groups = await db.breakoutGroup.findMany({
    where: owner,
    select: {
      facilitator: { select: { memberId: true } },
      coFacilitator: { select: { memberId: true } },
    },
  })
  return new Set(
    groups.flatMap((g) =>
      [g.facilitator?.memberId, g.coFacilitator?.memberId].filter(
        (id): id is string => id != null
      )
    )
  )
}

/**
 * One seat per person, not per registrant row.
 *
 * `BreakoutGroupMember` is keyed by `registrantId`, and until Collab clusters a
 * person had exactly one registrant row per event, so "this row is unseated"
 * and "this person is unseated" were the same statement. Under a Collab the
 * person holds a row on every member event, and two of those rows could be
 * seated at two different tables on the same day.
 *
 * `personKeyFor` is shared with the cluster roster (`lib/clusters/roster.ts`)
 * rather than re-derived, so the two surfaces cannot disagree about who counts
 * as the same person.
 */
const personKeyOf = personKeyFor

/** The person keys already holding a seat at one of the owner's tables. */
async function seatedPersonKeys(owner: BreakoutOwner): Promise<Set<string>> {
  const rows = await db.breakoutGroupMember.findMany({
    where: { breakoutGroup: owner },
    select: { registrant: { select: { id: true, memberId: true, guestId: true } } },
  })
  return new Set(rows.map((r) => personKeyOf(r.registrant)))
}

/**
 * Add several registrants to a breakout group in one pass.
 *
 * This is the single entry point for placing anyone into a breakout group —
 * `assignRegistrantToBreakout` (the registrant detail page) delegates here with
 * a one-element array, so the guards below can't drift between the two callers.
 *
 * Every check runs server-side even though the picker pre-filters: its candidate
 * list is a snapshot that may be stale by the time Add is pressed.
 */
export async function addRegistrantsToBreakout(
  groupId: string,
  registrantIds: string[],
  owner: BreakoutOwner
): Promise<ActionResult<{ added: number; failed: BatchFailure[] }>> {
  const denied = await requireBreakoutWrite(owner)
  if (denied) return { success: false, error: denied.error }

  const parsed = breakoutBatchSchema.safeParse({ groupId, registrantIds })
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }
  }

  const ids = [...new Set(parsed.data.registrantIds)]
  if (ids.length === 0) return { success: true, data: { added: 0, failed: [] } }

  // Event-scoped on purpose, not day-scoped like `breakoutCandidateWhere`.
  //
  // On a Collab the picker and `autoAssignBreakouts` narrow to the day's
  // registrations, because they are *choosing* people and both ministries' whole
  // series is the wrong list to choose from. This action is the admin acting on a
  // choice already made, so it stays the wider check: anyone registered to one of
  // the day's events. `carryOverBreakoutGroups` seats people on inherited series
  // rows that hold no day registration, and a walk-in can be seated before their
  // registration catches up — narrowing here would refuse both.
  const candidateEventIds = await breakoutCandidateEventIds(owner)
  const spansEvents = candidateEventIds.length > 1

  try {
    // Scoped to the owner's candidate events, so an id from outside them simply
    // isn't found.
    const registrants = await db.eventRegistrant.findMany({
      where: { id: { in: ids }, eventId: { in: candidateEventIds } },
      select: {
        id: true,
        memberId: true,
        guestId: true,
        ...registrantNameSelect,
        // Scoped to the tables in play, not globally: on a collab day a person's
        // standing placement in their ministry's own table is not a reason to
        // refuse them a seat at the day's. See `unassignedCandidateWhere`.
        breakoutGroupMemberships: {
          where: { breakoutGroup: owner },
          select: { breakoutGroupId: true },
          take: 1,
        },
      },
    })
    const byId = new Map(registrants.map((r) => [r.id, r]))

    const facilitators = await facilitatorMemberIds(owner)
    // One seat per PERSON, not per registrant row — unconditionally, not just
    // under a Collab. A duplicate sign-up gives someone two EventRegistrant rows
    // on a single plain event, and the per-row check below is blind to that: both
    // rows read as unseated, so the same human lands at two tables and can be
    // decided into two different DGroups.
    const seated = await seatedPersonKeys(owner)

    const failed: BatchFailure[] = []
    const eligible: string[] = []

    for (const id of ids) {
      const registrant = byId.get(id)
      const name = registrantName(registrant, "Unknown")

      if (!registrant) {
        failed.push({
          id,
          name,
          reason: spansEvents
            ? "is not a registrant of this event day"
            : "is not a registrant of this event",
        })
      } else if (registrant.breakoutGroupMemberships.length > 0) {
        failed.push({ id, name, reason: "is already in a breakout group" })
      } else if (seated.has(personKeyOf(registrant))) {
        failed.push({ id, name, reason: "is already in a breakout group" })
      } else if (registrant.memberId && facilitators.has(registrant.memberId)) {
        failed.push({ id, name, reason: "is a facilitator and cannot be a member" })
      } else {
        eligible.push(id)
        // Claimed within the batch too, so one submission cannot seat the same
        // person twice via two of their registrant rows.
        seated.add(personKeyOf(registrant))
      }
    }

    // Capacity is claimed under a row lock on the group.
    //
    // A transaction alone is NOT enough here: under Postgres' default READ
    // COMMITTED isolation two concurrent batches both read `count = 0`, both
    // decide there is room, and the group ends up over its limit. Updating the
    // group row first takes a FOR UPDATE lock, so the second batch blocks until
    // the first commits and then re-reads the true count (READ COMMITTED takes
    // a fresh snapshot per statement).
    const accepted = await db.$transaction(async (tx) => {
      const locked = await tx.breakoutGroup.updateMany({
        where: { id: groupId, ...owner },
        data: { updatedAt: new Date() },
      })
      if (locked.count === 0) return null

      const group = await tx.breakoutGroup.findFirst({
        where: { id: groupId, ...owner },
        select: { memberLimit: true, _count: { select: { members: true } } },
      })
      if (!group) return null

      const room =
        group.memberLimit === null ? eligible.length : group.memberLimit - group._count.members
      const take = Math.max(0, Math.min(eligible.length, room))

      if (take > 0) {
        await tx.breakoutGroupMember.createMany({
          data: eligible.slice(0, take).map((registrantId) => ({
            breakoutGroupId: groupId,
            registrantId,
          })),
          skipDuplicates: true,
        })
      }
      return eligible.slice(0, take)
    })

    if (accepted === null) return { success: false, error: "Breakout group not found" }

    for (const id of eligible.slice(accepted.length)) {
      failed.push({
        id,
        name: registrantName(byId.get(id), "Unknown"),
        reason: "would exceed the group's member limit",
      })
    }

    // Best-effort side effect, deliberately outside the transaction: a failure
    // to raise the small-group request must not roll back the placement.
    for (const id of accepted) {
      await tryCreateSmallGroupRequestFromBreakout(groupId, id)
    }

    revalidateBreakoutSurfaces(owner, { groupId })

    return { success: true, data: { added: accepted.length, failed } }
  } catch {
    return { success: false, error: "Failed to add registrants to breakout group" }
  }
}

export async function removeRegistrantFromBreakout(
  groupId: string,
  registrantId: string,
  owner: BreakoutOwner
): Promise<ActionResult> {
  const denied = await requireBreakoutWrite(owner)
  if (denied) return { success: false, error: denied.error }

  try {
    // The compound-key delete doesn't scope by owner on its own, so confirm the
    // group is one of this owner's before touching its roster.
    const group = await db.breakoutGroup.findFirst({
      where: { id: groupId, ...owner },
      select: { id: true },
    })
    if (!group) return { success: false, error: "Breakout group not found" }

    await db.breakoutGroupMember.delete({
      where: { breakoutGroupId_registrantId: { breakoutGroupId: groupId, registrantId } },
    })
    await tryCancelSmallGroupRequestFromBreakout(groupId, registrantId)
    revalidateBreakoutSurfaces(owner, { sessions: true })
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to remove registrant from breakout group" }
  }
}

const breakoutTransferSchema = z
  .object({
    fromGroupId: z.string().min(1, "Source breakout group is required"),
    toGroupId: z.string().min(1, "Destination breakout group is required"),
    registrantId: z.string().min(1, "Registrant is required"),
  })
  .refine((d) => d.fromGroupId !== d.toGroupId, {
    message: "Pick a different breakout group",
    path: ["toGroupId"],
  })

/**
 * Move one registrant between breakout groups in a single atomic step (CCF-139).
 *
 * Composing remove + add would leave the registrant in *no* group between the
 * two calls — and permanently so if the add then failed on capacity. Both writes
 * happen in one transaction here, so a failure leaves them exactly where they
 * were.
 *
 * Order inside the transaction matters: `BreakoutGroupMember`'s primary key is
 * `[breakoutGroupId, registrantId]` and there is no unique on `registrantId`
 * alone, so "one group per registrant" is an application invariant the database
 * will not enforce. Creating before deleting would silently double-place them.
 */
export async function transferRegistrantToBreakout(
  fromGroupId: string,
  toGroupId: string,
  registrantId: string,
  owner: BreakoutOwner
): Promise<ActionResult> {
  const denied = await requireBreakoutWrite(owner)
  if (denied) return { success: false, error: denied.error }

  const parsed = breakoutTransferSchema.safeParse({
    fromGroupId,
    toGroupId,
    registrantId,
  })
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }
  }

  // Event-scoped for the same reason as `addRegistrantsToBreakout`, and more
  // plainly so: a transfer moves somebody already sitting at one of these tables.
  const candidateEventIds = await breakoutCandidateEventIds(owner)

  try {
    // Scoped to the owner's candidate events, so an id from outside them simply
    // isn't found.
    const registrant = await db.eventRegistrant.findFirst({
      where: { id: registrantId, eventId: { in: candidateEventIds } },
      select: { id: true, memberId: true },
    })
    if (!registrant) {
      return {
        success: false,
        error:
          candidateEventIds.length > 1
            ? "Not a registrant of this event day"
            : "Not a registrant of this event",
      }
    }

    // Re-checked rather than assumed: they passed this when first placed, but a
    // facilitator can have been appointed in the meantime.
    if (registrant.memberId) {
      const facilitators = await facilitatorMemberIds(owner)
      if (facilitators.has(registrant.memberId)) {
        return { success: false, error: "A facilitator cannot be a breakout group member" }
      }
    }

    // The compound-key delete below doesn't scope by owner on its own.
    const source = await db.breakoutGroup.findFirst({
      where: { id: fromGroupId, ...owner },
      select: { id: true },
    })
    if (!source) return { success: false, error: "Breakout group not found" }

    const outcome = await db.$transaction(async (tx) => {
      // Claim a seat under a row lock on the destination. A transaction alone is
      // NOT enough: under READ COMMITTED two concurrent transfers both read the
      // same count, both decide there is room, and the group ends up over its
      // limit. Updating the row first takes a FOR UPDATE lock, so the second
      // blocks until the first commits and then re-reads the true count.
      const locked = await tx.breakoutGroup.updateMany({
        where: { id: toGroupId, ...owner },
        data: { updatedAt: new Date() },
      })
      if (locked.count === 0) return "missing-destination" as const

      const destination = await tx.breakoutGroup.findFirst({
        where: { id: toGroupId, ...owner },
        select: { memberLimit: true, _count: { select: { members: true } } },
      })
      if (!destination) return "missing-destination" as const

      if (
        destination.memberLimit !== null &&
        destination._count.members >= destination.memberLimit
      ) {
        return "full" as const
      }

      const removed = await tx.breakoutGroupMember.deleteMany({
        where: { breakoutGroupId: fromGroupId, registrantId },
      })
      if (removed.count === 0) return "not-in-source" as const

      await tx.breakoutGroupMember.create({
        data: { breakoutGroupId: toGroupId, registrantId },
      })
      return "moved" as const
    })

    if (outcome === "missing-destination") {
      return { success: false, error: "Destination breakout group not found" }
    }
    if (outcome === "full") {
      return { success: false, error: "That breakout group is already at its member limit" }
    }
    if (outcome === "not-in-source") {
      return { success: false, error: "No longer a member of this breakout group" }
    }

    // Best-effort side effect, deliberately outside the transaction: a failure to
    // re-point the small-group request must not roll back the move.
    await tryTransferSmallGroupRequestFromBreakout(fromGroupId, toGroupId, registrantId)

    revalidateBreakoutSurfaces(owner, { groupId: fromGroupId, sessions: true })
    revalidateBreakoutSurfaces(owner, { groupId: toGroupId })
    if (!isClusterOwner(owner)) revalidatePath(`/event/${owner.eventId}/catch-mech`)

    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to transfer registrant" }
  }
}

// ─── Facilitator assignment ───────────────────────────────────────────────────

// ─── Auto-assign on check-in ─────────────────────────────────────────────────

/**
 * The seats that answer for this surface — what the already-seated and
 * already-a-facilitator guards ask about.
 *
 * **A seat counts against you if it is in the set being filled, or if it was made
 * for today.** On a Collab day the cluster's set is today's; a member event's
 * standing tables are dormant, not being run. So the two directions are not the
 * same question, and the guard is deliberately asymmetric:
 *
 *  - Filling the **day's** set (`"cluster"` — the shared form, the day's kiosk):
 *    only the day's seats answer. A standing seat is not an answer about today.
 *  - Filling an **event's own** set (`"event"`): both answer. The day's seat is
 *    today's placement, and there is nothing to gain by moving someone into a
 *    table that isn't running.
 *
 * The `"cluster"` direction is a fix. It used to span both sets on the reasoning
 * that a person seated at the day's table must not pick up a second seat at their
 * event's — which is the `"event"` direction, and stays. Applied symmetrically it
 * broke the commonest shape of collab day: `EventRegistrant` is one row per
 * person per SERIES and `BreakoutGroupMember` has no per-occurrence scoping, so a
 * recurring event's regular holds a seat at their standing table permanently. The
 * day's kiosk found it, reported them already placed and skipped the Breakout
 * step — and with `deferBreakoutToCheckin` holding registration off *because* the
 * kiosk was the one asking, the regular finished the day seated nowhere and was
 * shown the name of a table that wasn't running.
 *
 * Note this is wider than the write in the `"event"` direction, where
 * `assignBreakoutForRegistrant` scopes `current` to the surface's owner alone.
 * That is not drift: `current` also has to name the row to MOVE for an explicit
 * pick, and a pick of an event table must not delete the day's seat.
 *
 * Combine the result with `AND`, never a spread — it carries an `OR` whenever
 * both sets are in play.
 */
async function surfaceBreakoutSet(
  eventId: string,
  breakoutSet: BreakoutSet
): Promise<Prisma.BreakoutGroupWhereInput> {
  const { breakoutOwner, clusterBreakoutOwner } = await resolvePoolScope(eventId)
  if (!clusterBreakoutOwner) return { ...breakoutOwner }
  return breakoutSet === "cluster"
    ? { ...clusterBreakoutOwner }
    : anyOwner([breakoutOwner, clusterBreakoutOwner])
}

/**
 * Called after a registrant checks in to an occurrence.
 * Silently assigns them to the best-matching breakout group if they're not
 * already assigned to one. Never throws — failures are swallowed so they
 * never block the check-in flow.
 *
 * Deliberately unguarded: the public check-in page (`/events/[id]/checkin`)
 * calls this with no session. Same for `getRegistrantBreakoutGroupName` below.
 * It keeps taking an event id rather than an owner for that reason — the caller
 * is a public page that knows which event it is serving and nothing more — and
 * resolves the owner itself.
 *
 * Both guards below were event-scoped and are now owner-scoped, which is a fix
 * as much as a widening: on a collab day the tables belong to the cluster, so
 * `breakoutGroup: { eventId }` matched nothing and the already-seated check
 * waved through someone who was already at a table, seating them twice.
 */
export async function autoAssignRegistrantToBreakout(
  registrantId: string,
  eventId: string,
  breakoutSet: BreakoutSet = "event"
): Promise<void> {
  try {
    const owner = await resolveSurfaceBreakoutOwner(eventId, breakoutSet)
    // See `surfaceBreakoutSet` for which seats answer here. Filling the day's set
    // asks only about the day's seats — a standing seat at the event's own table
    // is not an answer about today, and treating it as one left the day's
    // regulars seated nowhere. Filling the event's own set still asks about both.
    const thisSet = await surfaceBreakoutSet(eventId, breakoutSet)

    const alreadyAssigned = await db.breakoutGroupMember.findFirst({
      where: { registrantId, breakoutGroup: thisSet },
      select: { breakoutGroupId: true },
    })
    if (alreadyAssigned) return

    const registrant = await db.eventRegistrant.findUnique({
      where: { id: registrantId },
      select: { memberId: true, guestId: true },
    })

    // One seat per person, whatever the owner. Under a Collab the same person
    // holds a registration on every member event; on a plain event a duplicate
    // sign-up gives them two rows. Check-in fires this per row either way, so the
    // per-row guard above is not enough on its own.
    if (registrant?.memberId || registrant?.guestId) {
      const seatedElsewhere = await db.breakoutGroupMember.findFirst({
        where: {
          breakoutGroup: thisSet,
          registrant: registrant.memberId
            ? { memberId: registrant.memberId }
            : { guestId: registrant.guestId },
        },
        select: { breakoutGroupId: true },
      })
      if (seatedElsewhere) return
    }

    if (registrant?.memberId) {
      // AND, not a spread: a group filter may itself carry an `OR`, and a second
      // `OR` key in the same object would replace it — leaving a check that
      // matches a facilitator of any table anywhere.
      const isFacilitator = await db.breakoutGroup.findFirst({
        where: {
          AND: [
            thisSet,
            {
              OR: [
                { facilitator: { memberId: registrant.memberId } },
                { coFacilitator: { memberId: registrant.memberId } },
              ],
            },
          ],
        },
        select: { id: true },
      })
      if (isFacilitator) return
    }

    const matches = await matchBreakoutGroups(registrantId, owner, {
      excludeAssigned: true,
      limit: 1,
    })
    if (matches.length === 0) return

    const topMatch = matches[0]

    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: topMatch.groupId, registrantId },
    })
    await tryCreateSmallGroupRequestFromBreakout(topMatch.groupId, registrantId)

    revalidateBreakoutSurfaces(owner)
  } catch {
    // Swallow — auto-assign is best-effort and must not interrupt check-in
  }
}

/**
 * Reads a registrant's current breakout group assignment for an event's day.
 * Used by the public check-in success screen to show the person which breakout
 * group they belong to. Best-effort — returns null when unassigned or on error.
 *
 * Spans BOTH sets, and takes no `BreakoutSet` to choose between them. Every other
 * breakout call has to know which set it is filling, because a write lands in one
 * of them; this one only asks "where are you sitting", and the honest answer is
 * wherever that is. Narrowing it to the event's set would tell someone seated at
 * the collab day's table they had no group — which is the bug this originally
 * fixed, in the opposite direction.
 *
 * **The day's set is asked FIRST, and that ordering is the answer rather than a
 * tie-break.** Holding a seat in each set is an ordinary state, not a fault: a
 * recurring event's regular keeps their standing seat for the whole series while
 * the collab day seats them at one of its own. A single `findFirst` over the
 * union returned whichever row Postgres happened to reach first, so the screen
 * named the standing table about as often as today's. This is a check-in
 * confirmation — the only table it can usefully name is the one being run in the
 * room the person is standing in.
 */
export async function getRegistrantBreakoutGroupName(
  registrantId: string,
  eventId: string
): Promise<{ name: string } | null> {
  try {
    const { breakoutOwner, clusterBreakoutOwner } = await resolvePoolScope(eventId)
    // Ordered, not unioned. Off a collab day the first entry is the only one.
    for (const owner of [clusterBreakoutOwner, breakoutOwner]) {
      if (!owner) continue
      const membership = await db.breakoutGroupMember.findFirst({
        where: { registrantId, breakoutGroup: owner },
        select: { breakoutGroup: { select: { name: true } } },
      })
      if (membership) return { name: membership.breakoutGroup.name }
    }
    return null
  } catch {
    return null
  }
}

// ─── Picking a group at check-in (CCF-149) ───────────────────────────────────

/**
 * The profile the suggester ranks on, read off whichever person record the
 * registrant is linked to.
 *
 * An anonymous registrant — neither FK set, personal fields only — has none of
 * these, and that is a legitimate answer rather than a failure: unknown gender
 * and life stage never rule a group *out* of the browse list, they only stop a
 * suggestion being made. See `isEligible` / `breakoutPickerOptions`.
 */
async function checkinRegistrantProfile(registrantId: string): Promise<{
  gender: Gender | null
  birthYear: number | null
  lifeStageId: string | null
}> {
  const row = await db.eventRegistrant.findUnique({
    where: { id: registrantId },
    select: {
      member: { select: { gender: true, birthYear: true, lifeStageId: true } },
      guest: { select: { gender: true, birthYear: true, lifeStageId: true } },
    },
  })
  const person = row?.member ?? row?.guest ?? null
  return {
    gender: person?.gender ?? null,
    birthYear: person?.birthYear ?? null,
    lifeStageId: person?.lifeStageId ?? null,
  }
}

/**
 * Whether this person already holds a seat under this owner, and where.
 *
 * Matched by PERSON rather than by the registrant row, because one human holds a
 * row per member event under a Collab and can hold two on a single event from a
 * duplicate sign-up. This is the same lookup `assignBreakoutForRegistrant` runs
 * before it writes; doing it here as well is what stops the kiosk *offering* a
 * step whose only possible outcome is "you're already seated".
 */
async function seatedGroupFor(
  registrantId: string,
  groups: Prisma.BreakoutGroupWhereInput
): Promise<{ name: string } | null> {
  const registrant = await db.eventRegistrant.findUnique({
    where: { id: registrantId },
    select: { memberId: true, guestId: true },
  })
  // Guard both-null before branching: an anonymous registrant has neither FK, and
  // `{ memberId: null }` would match every other anonymous row.
  const personFilter = registrant?.memberId
    ? { memberId: registrant.memberId }
    : registrant?.guestId
      ? { guestId: registrant.guestId }
      : null
  const seat = await db.breakoutGroupMember.findFirst({
    where: {
      breakoutGroup: groups,
      ...(personFilter ? { registrant: personFilter } : { registrantId }),
    },
    select: { breakoutGroup: { select: { name: true } } },
  })
  return seat ? { name: seat.breakoutGroup.name } : null
}

/**
 * Has this person's attendance actually been recorded for this event/session?
 *
 * The one guard `assignBreakoutForRegistrant` cannot supply, and the reason this
 * wrapper exists at all. `pickCheckinBreakout` is reachable without a session —
 * the check-in kiosk is a public route — and it takes a caller-supplied group id
 * and registrant id. Without this, it is an open endpoint for seating any
 * registrant at any table of any event.
 *
 * Free on the real path: the step runs *after* the check-in write, so anyone who
 * can see it has already passed.
 */
async function isCheckedInFor(
  registrantId: string,
  occurrenceId: string | null
): Promise<boolean> {
  if (occurrenceId !== null) {
    const attendance = await db.occurrenceAttendee.findUnique({
      where: { occurrenceId_registrantId: { occurrenceId, registrantId } },
      select: { id: true },
    })
    return attendance !== null
  }
  const registrant = await db.eventRegistrant.findUnique({
    where: { id: registrantId },
    select: { attendedAt: true },
  })
  return registrant?.attendedAt != null
}

/** Does this person run one of the owner's tables? They attend as staff, not as a guest. */
async function facilitatesAnyGroup(
  registrantId: string,
  groups: Prisma.BreakoutGroupWhereInput
): Promise<boolean> {
  const registrant = await db.eventRegistrant.findUnique({
    where: { id: registrantId },
    select: { memberId: true },
  })
  if (!registrant?.memberId) return false
  // AND, not a spread: `groups` is a caller-supplied filter that may itself carry
  // an `OR`, and two `OR` keys in one object silently overwrite each other.
  const group = await db.breakoutGroup.findFirst({
    where: {
      AND: [
        groups,
        {
          OR: [
            { facilitator: { memberId: registrant.memberId } },
            { coFacilitator: { memberId: registrant.memberId } },
          ],
        },
      ],
    },
    select: { id: true },
  })
  return group !== null
}

/**
 * The breakout groups to offer someone who has just checked in, ranked.
 *
 * Deliberately unguarded, like `autoAssignRegistrantToBreakout` and
 * `getRegistrantBreakoutGroupName` above: the public check-in kiosks call it. It
 * keeps taking an event id for the same reason — the caller is a public page that
 * knows which event it is serving and nothing more — and resolves the owner
 * itself, so a Collab day offers the CLUSTER's tables rather than the member
 * event's standing ones.
 *
 * Returns `null` when there is nothing to say and the step should simply not
 * appear: no enabled groups at all, or the person is staff at one of them. A
 * *gated* empty list is different and comes back as a `notice` — dropping the step
 * silently in that case is what made an enabled Breakout toggle look like it did
 * nothing on the walk-in form.
 *
 * The candidate set matches the REGISTRATION form's, not the door's: every
 * enabled table, ungated. It read the other way round for a while, on the
 * reasoning that a kiosk and a door are the same physical moment, and that was
 * wrong twice over.
 *
 * It hid the step. Every branch of `facilitatorGate` requires a facilitator
 * relation to exist, so a table with nobody assigned to it can never pass — and
 * a table whose host simply hasn't arrived yet is the ordinary state of the
 * first half hour. Both left the person looking at an "awaiting-facilitator"
 * notice instead of a suggestion, which is the whole reason the step exists.
 *
 * Worse, it distorted the ranking. `resolveFillLevels` reduces the whole
 * candidate set at once, so `fillLevel` is relative to whatever was loaded, and
 * "the emptiest table" only means "the emptiest of all of them" when the set IS
 * all of them. A gated subset is at its worst in the window where exactly one
 * facilitator has checked in: the set collapses to that single table and every
 * arrival stacks into it — precisely the opposite of the spread the suggestion
 * is for.
 *
 * The door keeps the gate. There a staffer is doing the placing and handing
 * someone to a table with nobody running it is a real handover to nobody.
 */
export async function getCheckinBreakoutChoices(
  registrantId: string,
  eventId: string,
  occurrenceId: string | null,
  breakoutSet: BreakoutSet = "event"
): Promise<ActionResult<CheckinBreakoutChoices | null>> {
  try {
    const registrant = await db.eventRegistrant.findUnique({
      where: { id: registrantId },
      select: { eventId: true },
    })
    if (!registrant || registrant.eventId !== eventId) {
      return { success: false, error: "Registration not found" }
    }

    // Which seats count as "already spoken for" — see `surfaceBreakoutSet`. The
    // day's kiosk asks about the day's seats alone; asking wider is what made it
    // skip its own step for every regular who already held a standing seat. The
    // set this kiosk actually FILLS is `breakoutSet`, resolved further down by
    // `fetchBreakoutAvailability`.
    const thisSet = await surfaceBreakoutSet(eventId, breakoutSet)

    if (await facilitatesAnyGroup(registrantId, thisSet)) {
      return { success: true, data: null }
    }

    const seated = await seatedGroupFor(registrantId, thisSet)
    if (seated) {
      return {
        success: true,
        data: {
          suggested: null,
          options: [],
          hasCandidates: false,
          notice: null,
          seatedGroupName: seated.name,
        },
      }
    }

    const { candidates, totalGroups } = await fetchBreakoutAvailability(
      eventId,
      occurrenceId,
      false,
      breakoutSet
    )
    if (totalGroups === 0) return { success: true, data: null }

    // Occupancy is an admin-facing operational number. A person at the kiosk has
    // no business knowing how many are at each table, and until it is stripped the
    // counts sit in the action's payload — unrendered, but there for anyone who
    // looks. A signed-in staffer running the kiosk keeps them, exactly as at the
    // door.
    const visible = (await isEventStaffViewer())
      ? candidates
      : withoutOccupancy(candidates)

    const profile = await checkinRegistrantProfile(registrantId)

    return {
      success: true,
      data: {
        suggested: suggestBreakoutGroup(visible, profile),
        options: breakoutPickerOptions(visible, profile),
        hasCandidates: visible.length > 0,
        notice: resolveBreakoutNotice({
          offerPicker: true,
          candidateCount: visible.length,
          totalGroups,
        }),
        seatedGroupName: null,
      },
    }
  } catch {
    return { success: false, error: "Could not load breakout groups" }
  }
}

/**
 * Seat someone at the table they picked at check-in.
 *
 * A thin wrapper over `assignBreakoutForRegistrant`, which is a lib function
 * rather than an action and so cannot be called from a client component. It is
 * where every rule that matters already lives: the Breakout module on the
 * registrant's OWN event (which is what makes this correct on a Collab, where the
 * table belongs to the cluster and the module switch does not), `pickedIsInPlay`
 * as an owner comparison, `isEnabled`, capacity, one seat per person, and the
 * move-not-duplicate transaction.
 *
 * What this wrapper adds is {@link isCheckedInFor} — see there for why a public
 * route taking a caller-supplied group id needs it.
 */
export async function pickCheckinBreakout(
  registrantId: string,
  eventId: string,
  occurrenceId: string | null,
  groupId: string,
  breakoutSet: BreakoutSet = "event"
): Promise<ActionResult<{ name: string } | null>> {
  try {
    if (!(await isCheckedInFor(registrantId, occurrenceId))) {
      return { success: false, error: "Check in first, then pick a group" }
    }

    const profile = await checkinRegistrantProfile(registrantId)
    const assigned = await assignBreakoutForRegistrant(
      registrantId,
      eventId,
      groupId,
      profile,
      // A staffer running the kiosk may have a reason to go over a table's limit;
      // a self-serve arrival does not. The same line the door draws.
      await isEventStaffViewer(),
      { occurrenceId },
      false,
      breakoutSet
    )
    // A refused pick (full, switched off, another day's table) comes back as the
    // placement they already had, or null. Either way the caller reports what is
    // true rather than what was asked for.
    if (!assigned) return { success: false, error: "That group is no longer available" }

    revalidateBreakoutSurfaces(await resolveSurfaceBreakoutOwner(eventId, breakoutSet))
    return { success: true, data: { name: assigned.name } }
  } catch {
    return { success: false, error: "Could not save your group" }
  }
}

// ─── Auto-assign ─────────────────────────────────────────────────────────────

export async function autoAssignBreakouts(
  owner: BreakoutOwner
): Promise<ActionResult<{ assigned: number; skipped: number }>> {
  const denied = await requireBreakoutWrite(owner)
  if (denied) return { success: false, error: denied.error }

  // Day-scoped on a Collab: auto-assign fills the day's tables from the day's
  // registrations, not from every regular either ministry has ever had.
  const candidateWhere = await breakoutCandidateWhere(owner)

  try {
    const unassigned = await db.eventRegistrant.findMany({
      where: {
        ...candidateWhere,
        ...unassignedCandidateWhere(owner),
      },
      select: { id: true, memberId: true, guestId: true },
    })

    if (unassigned.length === 0) {
      return { success: true, data: { assigned: 0, skipped: 0 } }
    }

    let assigned = 0
    let skipped = 0

    // One seat per person, whatever the owner. A Collab candidate list holds one
    // row per member event; a plain event can still hold two rows for one person
    // through a duplicate sign-up. Either way, without this the same person is
    // placed once per registration row.
    const seated = await seatedPersonKeys(owner)

    for (const registrant of unassigned) {
      const key = personKeyOf(registrant)
      if (seated.has(key)) {
        skipped++
        continue
      }

      const matches = await matchBreakoutGroups(registrant.id, owner, {
        excludeAssigned: true,
        limit: 1,
      })

      if (matches.length === 0) {
        skipped++
        continue
      }

      await db.breakoutGroupMember.create({
        data: { breakoutGroupId: matches[0].groupId, registrantId: registrant.id },
      })
      await tryCreateSmallGroupRequestFromBreakout(matches[0].groupId, registrant.id)
      seated.add(key)
      assigned++
    }

    revalidateBreakoutSurfaces(owner)
    return { success: true, data: { assigned, skipped } }
  } catch {
    return { success: false, error: "Failed to auto-assign registrants" }
  }
}

// ─── Facilitator assignment ───────────────────────────────────────────────────

/**
 * Assign or clear one of a breakout group's two facilitator slots.
 *
 * This deliberately does **not** touch the matching profile. It used to copy the
 * facilitator's linked DGroup criteria over the group's own, which meant a
 * facilitator change silently rewrote what the group matched for and made the
 * profile read-only in both edit drawers. A breakout table is not its
 * facilitator's DGroup — the criteria are the group's, hand-entered and always
 * editable.
 *
 * `linkedSmallGroupId` still travels with a facilitator change, but only as
 * Catch Mech routing: it decides which DGroup receives this group's member
 * requests (`resolveLinkedSmallGroup`). Absent means "not submitted", not
 * "clear it".
 */
export async function setFacilitator(
  groupId: string,
  volunteerId: string | null,
  role: "facilitator" | "coFacilitator",
  owner: BreakoutOwner,
  linkedSmallGroupId?: string | null
): Promise<ActionResult> {
  const denied = await requireBreakoutWrite(owner)
  if (denied) return { success: false, error: denied.error }

  try {
    if (volunteerId !== null) {
      // The volunteer POOL, not the group's event — this is the union half of
      // CCF-148. On a collab day either ministry's confirmed volunteers may run
      // any of the day's tables, and a volunteer stays owned by the event they
      // signed up under.
      const volunteerEventIds = await poolVolunteerEventIds(owner)
      const volunteer = await db.volunteer.findFirst({
        where: { id: volunteerId, eventId: { in: volunteerEventIds } },
        select: { id: true },
      })
      if (!volunteer) {
        return {
          success: false,
          error:
            volunteerEventIds.length > 1
              ? "Volunteer not found for this event day"
              : "Volunteer not found for this event",
        }
      }
      const group = await db.breakoutGroup.findFirst({
        where: { id: groupId, ...owner },
        select: { facilitatorId: true, coFacilitatorId: true },
      })
      if (!group) return { success: false, error: "Breakout group not found" }
      const otherSlot = role === "facilitator" ? group.coFacilitatorId : group.facilitatorId
      if (otherSlot === volunteerId) {
        return {
          success: false,
          error: "Facilitator and co-facilitator must be different volunteers",
        }
      }
    }

    // Unassigning the facilitator takes the group's matching profile and Catch
    // Mech target with it — a table nobody runs matches for nothing. Only this
    // slot: the co-facilitator is a second pair of hands, not the owner, and a
    // swap between two facilitators leaves the criteria untouched.
    const unlinked = role === "facilitator" && volunteerId === null

    // findFirst + update rather than a bare update by id: clearing a slot skips
    // the owner-scoped read above, so without this an owner argument could name
    // a group it doesn't own.
    const target = await db.breakoutGroup.findFirst({
      where: { id: groupId, ...owner },
      select: { id: true },
    })
    if (!target) return { success: false, error: "Breakout group not found" }

    await db.breakoutGroup.update({
      where: { id: groupId },
      data: role === "facilitator"
        ? unlinked
          ? { facilitatorId: null, linkedSmallGroupId: null, ...clearedMatchingProfile() }
          : {
              facilitatorId: volunteerId,
              ...(linkedSmallGroupId !== undefined ? { linkedSmallGroupId } : {}),
            }
        : { coFacilitatorId: volunteerId },
    })
    revalidateBreakoutSurfaces(owner, { groupId })
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to update facilitator" }
  }
}
