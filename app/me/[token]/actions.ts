"use server"

import { randomUUID } from "crypto"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import type { Prisma } from "@/app/generated/prisma/client"
import { db } from "@/lib/db"
import { portalTokenWhere } from "@/lib/people/portal-tokens"
import { findSpouse, type SpouseInfo } from "@/lib/family-links"
import { PROMOTABLE_GUEST_SELECT, promoteGuestRecord } from "@/lib/people/promote-guest"
import { PERSON_NAME_FIELDS, personSearchWhere } from "@/lib/search/name-search"
import { upwardSatelliteSchema } from "@/lib/validations/small-group"

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string }

async function getMemberByToken(token: string) {
  if (!token) return null
  return db.member.findFirst({
    where: portalTokenWhere(token),
    select: {
      id: true,
      firstName: true,
      lastName: true,
      smallGroupId: true,
      upwardSatellite: true,
    },
  })
}

/**
 * Whether this person has answered "who is your leader?" — the prerequisite for
 * adding groups they lead. Three answers count, because all three name someone:
 * a confirmed DGroup here, a declared satellite, or a request awaiting a leader.
 * A pending request counts on purpose: they have answered, and holding the rest
 * of the portal hostage to someone else's confirmation helps nobody.
 */
async function hasDeclaredLeader(member: {
  id: string
  smallGroupId: string | null
  upwardSatellite: string | null
}): Promise<boolean> {
  if (member.smallGroupId || member.upwardSatellite) return true
  const pending = await db.smallGroupMemberRequest.findFirst({
    where: { memberId: member.id, status: "Pending" },
    select: { id: true },
  })
  return pending !== null
}

/**
 * The request + log pair written whenever someone asks to join a DGroup through
 * the portal. Shared by the member's change-group flow and the guest's very
 * first declaration so the two produce identical, indistinguishable history.
 */
async function createJoinRequest(
  tx: Prisma.TransactionClient,
  args: {
    memberId: string
    memberName: string
    toGroupId: string
    fromGroupId?: string | null
  }
) {
  const { memberId, memberName, toGroupId, fromGroupId = null } = args
  await tx.smallGroupMemberRequest.create({
    data: { smallGroupId: toGroupId, memberId, fromGroupId },
  })
  await tx.smallGroupLog.create({
    data: {
      smallGroupId: toGroupId,
      action: "TempAssignmentCreated",
      memberId,
      fromGroupId,
      toGroupId,
      description: `${memberName} requested to ${fromGroupId ? "transfer to" : "join"} this group via the member portal (pending leader confirmation)`,
    },
  })
}

/** Verifies the token belongs to the leader of the given group. */
async function getLedGroup(token: string, groupId: string) {
  const member = await getMemberByToken(token)
  if (!member) return null
  const group = await db.smallGroup.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      name: true,
      leaderId: true,
      memberLimit: true,
      _count: {
        select: {
          members: true,
          childGroups: true,
          memberRequests: { where: { status: "Pending" } },
        },
      },
    },
  })
  if (!group || group.leaderId !== member.id) return null
  return { member, group }
}

function revalidateGroupPages(groupId: string) {
  revalidatePath("/small-groups")
  revalidatePath(`/small-groups/${groupId}`)
}

// ─── My Group (transfer requests) ────────────────────────────────────────────

export async function requestGroupChange(
  token: string,
  toGroupId: string
): Promise<ActionResult> {
  try {
    const member = await getMemberByToken(token)
    if (!member) return { success: false, error: "Invalid or expired link" }

    if (member.smallGroupId === toGroupId) {
      return { success: false, error: "You are already in this group" }
    }

    const toGroup = await db.smallGroup.findUnique({
      where: { id: toGroupId },
      select: {
        id: true,
        name: true,
        status: true,
        memberLimit: true,
        _count: { select: { members: true } },
      },
    })
    if (!toGroup || toGroup.status === "Inactive") {
      return { success: false, error: "Group not found" }
    }
    if (
      toGroup.memberLimit !== null &&
      toGroup._count.members >= toGroup.memberLimit
    ) {
      return { success: false, error: "This group is already full" }
    }

    const existing = await db.smallGroupMemberRequest.findFirst({
      where: { memberId: member.id, status: "Pending" },
      select: { id: true, smallGroupId: true },
    })
    if (existing?.smallGroupId === toGroupId) {
      return {
        success: false,
        error: "You already have a pending request for this group",
      }
    }

    const memberName = `${member.firstName} ${member.lastName}`
    await db.$transaction(async (tx) => {
      // A member can only have one pending request — replace any previous one
      if (existing?.smallGroupId) {
        await tx.smallGroupMemberRequest.update({
          where: { id: existing.id },
          data: { status: "Rejected", resolvedAt: new Date() },
        })
        await tx.smallGroupLog.create({
          data: {
            smallGroupId: existing.smallGroupId,
            action: "TempAssignmentRejected",
            memberId: member.id,
            description: `${memberName} withdrew their request via the member portal`,
          },
        })
      }
      // The declared satellite is deliberately NOT cleared here. A request is an
      // intention, not a move: until a leader confirms it, "my DGroup is at CCF
      // Cebu" is still the only true answer, and clearing it on a request that
      // then gets rejected would leave the member with no upward record at all.
      // `clearUpwardSatelliteOnConfirm` drops it at confirmation instead.
      await createJoinRequest(tx, {
        memberId: member.id,
        memberName,
        toGroupId,
        fromGroupId: member.smallGroupId,
      })
    })

    revalidateGroupPages(toGroupId)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to submit request" }
  }
}

export async function cancelGroupChange(
  token: string,
  requestId: string
): Promise<ActionResult> {
  try {
    const member = await getMemberByToken(token)
    if (!member) return { success: false, error: "Invalid or expired link" }

    const request = await db.smallGroupMemberRequest.findUnique({
      where: { id: requestId },
      select: { id: true, memberId: true, smallGroupId: true, status: true },
    })
    if (!request || request.memberId !== member.id) {
      return { success: false, error: "Request not found" }
    }
    if (request.status !== "Pending") {
      return { success: false, error: "This request has already been resolved" }
    }
    // Only a Catch Mech decline is groupless, and those are never Pending.
    const smallGroupId = request.smallGroupId
    if (!smallGroupId) return { success: false, error: "Request not found" }

    await db.$transaction([
      db.smallGroupMemberRequest.update({
        where: { id: request.id },
        data: { status: "Rejected", resolvedAt: new Date() },
      }),
      db.smallGroupLog.create({
        data: {
          smallGroupId,
          action: "TempAssignmentRejected",
          memberId: member.id,
          description: `${member.firstName} ${member.lastName} cancelled their request via the member portal`,
        },
      }),
    ])

    revalidateGroupPages(smallGroupId)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to cancel request" }
  }
}

// ─── My Group (leader reports to another satellite) ──────────────────────────

/**
 * Someone whose own DGroup leader sits outside CCF Eastwood has nobody here to
 * request to join — they name the satellite instead. Passing `null` clears it,
 * putting them back on the request-to-join path.
 *
 * Recorded in two places, deliberately: on `Member.upwardSatellite`, because the
 * portal now asks this *before* anyone adds the groups they lead and a member who
 * leads nothing would otherwise have nowhere to put the answer; and mirrored onto
 * `SmallGroup.parentSatellite` for every group they do lead, which is where the
 * admin form and the group hierarchy read it from. It is mutually exclusive with
 * `parentGroupId` on the group side and with `smallGroupId` on the member side.
 */
export async function setUpwardSatellite(
  token: string,
  satellite: string | null
): Promise<ActionResult> {
  try {
    const member = await getMemberByToken(token)
    if (!member) return { success: false, error: "Invalid or expired link" }

    const parsed = upwardSatelliteSchema.safeParse(satellite)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? "Unknown CCF satellite",
      }
    }
    const value = parsed.data

    // Read for the revalidation list below; no longer a gate. Leading a group
    // used to be required here, which put the question after the thing it is
    // supposed to come before.
    const ledGroups = await db.smallGroup.findMany({
      where: { leaderId: member.id },
      select: { id: true },
    })

    const memberName = `${member.firstName} ${member.lastName}`

    await db.$transaction(async (tx) => {
      await tx.member.update({
        where: { id: member.id },
        data: { upwardSatellite: value },
      })

      // Matched by leader rather than by the ids read above, so a group created
      // between that read and this write is covered too.
      await tx.smallGroup.updateMany({
        where: { leaderId: member.id },
        // The parent is either a DGroup here or a satellite — never both.
        data: value
          ? { parentSatellite: value, parentGroupId: null }
          : { parentSatellite: null },
      })

      if (!value) return

      // Their DGroup now sits at another satellite, so the Eastwood membership
      // that stood in for it no longer holds.
      if (member.smallGroupId) {
        await tx.member.update({
          where: { id: member.id },
          data: { smallGroupId: null, groupStatus: null },
        })
        await tx.smallGroupLog.create({
          data: {
            smallGroupId: member.smallGroupId,
            action: "MemberRemoved",
            memberId: member.id,
            performedByMemberId: member.id,
            description: `${memberName} left this group — their DGroup is at ${value} (another CCF satellite), set via the member portal`,
          },
        })
      }

      // Any pending request to join a DGroup here contradicts the declaration.
      // Read inside the transaction, and as a list: one request is all the
      // portal can produce, but a stray second must not survive the withdrawal.
      const pending = await tx.smallGroupMemberRequest.findMany({
        where: { memberId: member.id, status: "Pending" },
        select: { id: true, smallGroupId: true },
      })
      if (pending.length > 0) {
        await tx.smallGroupMemberRequest.updateMany({
          where: { id: { in: pending.map((r) => r.id) } },
          data: { status: "Rejected", resolvedAt: new Date() },
        })
        await tx.smallGroupLog.createMany({
          data: pending
            .filter((r): r is { id: string; smallGroupId: string } => r.smallGroupId !== null)
            .map((r) => ({
              smallGroupId: r.smallGroupId,
              action: "TempAssignmentRejected" as const,
              memberId: member.id,
              performedByMemberId: member.id,
              description: `${memberName} withdrew their request — their DGroup is at ${value} (another CCF satellite)`,
            })),
        })
      }
    })

    revalidatePath("/small-groups")
    for (const g of ledGroups) revalidatePath(`/small-groups/${g.id}`)
    if (member.smallGroupId) revalidatePath(`/small-groups/${member.smallGroupId}`)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to save your DGroup" }
  }
}

// ─── Guest onboarding ────────────────────────────────────────────────────────

export type DeclareLeaderInput =
  | { scope: "eastwood"; groupId: string }
  | { scope: "satellite"; satellite: string }

/**
 * A guest's first and only step in the portal: name your leader.
 *
 * Answering promotes them to a Member — without a DGroup, because naming a
 * leader is not the same as being confirmed into their group. `SmallGroup.leaderId`
 * requires a Member, so this is also what makes it possible for them to register
 * the groups they lead on the next screen. From here on they are indistinguishable
 * from anyone else in the portal, which is why the answer is recorded through the
 * same two paths a member uses: a pending request, or a declared satellite.
 *
 * The Guest row is kept (it is their history) and its self-reported claim fields
 * are updated to match, the way the check-in kiosk writes them.
 */
export async function declareLeaderAndJoin(
  token: string,
  input: DeclareLeaderInput
): Promise<ActionResult<{ token: string }>> {
  try {
    if (!token) return { success: false, error: "Invalid or expired link" }

    const guest = await db.guest.findFirst({
      where: portalTokenWhere(token),
      select: { id: true, ...PROMOTABLE_GUEST_SELECT },
    })
    if (!guest) return { success: false, error: "Invalid or expired link" }
    if (guest.memberId) {
      return { success: false, error: "You've already told us who your leader is" }
    }

    // Validate before promoting: a rejected answer must leave them a guest.
    let satellite: string | null = null
    let toGroup: { id: string; name: string } | null = null

    if (input.scope === "satellite") {
      const parsed = upwardSatelliteSchema.safeParse(input.satellite)
      if (!parsed.success || !parsed.data) {
        return {
          success: false,
          error: parsed.success
            ? "Please choose a CCF satellite"
            : (parsed.error.issues[0]?.message ?? "Unknown CCF satellite"),
        }
      }
      satellite = parsed.data
    } else {
      const group = await db.smallGroup.findUnique({
        where: { id: input.groupId },
        select: {
          id: true,
          name: true,
          status: true,
          memberLimit: true,
          _count: { select: { members: true } },
        },
      })
      if (!group || group.status === "Inactive") {
        return { success: false, error: "Group not found" }
      }
      if (group.memberLimit !== null && group._count.members >= group.memberLimit) {
        return { success: false, error: "This group is already full" }
      }
      toGroup = { id: group.id, name: group.name }
    }

    const guestName = `${guest.firstName} ${guest.lastName}`

    const memberToken = await db.$transaction(async (tx) => {
      const { memberId } = await promoteGuestRecord(tx, {
        guestId: guest.id,
        guest,
        dateJoined: new Date(),
        // Naming a leader is an intention, not a confirmed placement.
        group: null,
        // Public token flow — an email already belonging to a Member means this
        // is that Member, not a second copy of them.
        reuseExistingMemberByEmail: true,
        schedule: "normalized",
      })

      // A reused Member may already have a portal token; only mint a new one when
      // there is none, so an existing link keeps working.
      const existing = await tx.member.findUnique({
        where: { id: memberId },
        select: { selfServiceToken: true },
      })
      const nextToken = existing?.selfServiceToken ?? randomUUID()

      await tx.member.update({
        where: { id: memberId },
        data: {
          selfServiceToken: nextToken,
          upwardSatellite: satellite,
        },
      })

      // Keep the guest's own self-reported answer in step with the declaration.
      // The two claim fields are mutually exclusive.
      await tx.guest.update({
        where: { id: guest.id },
        data: {
          claimedSatellite: satellite,
          claimedSmallGroupId: toGroup?.id ?? null,
        },
      })

      if (toGroup) {
        await createJoinRequest(tx, {
          memberId,
          memberName: guestName,
          toGroupId: toGroup.id,
        })
      }

      return nextToken
    })

    revalidatePath("/guests")
    revalidatePath("/members")
    if (toGroup) revalidateGroupPages(toGroup.id)
    else revalidatePath("/small-groups")

    return { success: true, data: { token: memberToken } }
  } catch {
    return { success: false, error: "Failed to save your DGroup" }
  }
}

// ─── Led groups: details ─────────────────────────────────────────────────────

/** Leader-editable subset of the group profile — logistics, matching fields, and
 *  group type. Remaining structural fields (leader, parent, life stage) stay
 *  admin-only. Couples groups always host married pairs → gender focus is Mixed. */
const nullableCity = z
  .string()
  .optional()
  .transform((v) => (v == null || v.trim() === "" ? null : v.trim()))

const nullablePositiveInt = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) =>
    v == null || v === "" ? null : typeof v === "number" ? v : parseInt(v, 10)
  )
  .pipe(z.number().int().positive().nullable())

const nullableTime = (message: string) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => (v == null || v === "" ? null : v))
    .pipe(z.string().regex(/^\d{2}:\d{2}$/, message).nullable())

const ledGroupDetailsSchema = z
  .object({
    name: z.string().min(1, "Group name is required").trim(),
    groupType: z.preprocess(
      (v) => (v === "" || v == null ? "Regular" : v),
      z.enum(["Regular", "Couples"])
    ),
    meetingFormat: z.enum(["Online", "Hybrid", "InPerson"]),
    locationCity: nullableCity,
    language: z.array(z.string()).default([]),
    ageRangeMin: nullablePositiveInt,
    ageRangeMax: nullablePositiveInt,
    memberLimit: nullablePositiveInt,
    scheduleDayOfWeek: z.number().int().min(0).max(6),
    // Times are optional — a leader may only know the day the group meets.
    scheduleTimeStart: nullableTime("Invalid start time"),
    scheduleTimeEnd: nullableTime("Invalid end time"),
  })
  .refine(
    (v) =>
      v.scheduleTimeStart == null ||
      v.scheduleTimeEnd == null ||
      v.scheduleTimeStart < v.scheduleTimeEnd,
    {
      message: "End time must be after start time",
      path: ["scheduleTimeEnd"],
    }
  )
  .refine(
    (v) =>
      v.ageRangeMin == null ||
      v.ageRangeMax == null ||
      v.ageRangeMin <= v.ageRangeMax,
    { message: "Max age must be greater than or equal to min age", path: ["ageRangeMax"] }
  )

export type LedGroupDetailsInput = {
  name: string
  groupType: string
  meetingFormat: string
  locationCity: string
  language: string[]
  ageRangeMin: string
  ageRangeMax: string
  memberLimit: string
  scheduleDayOfWeek: number
  scheduleTimeStart: string
  scheduleTimeEnd: string
}

/** Creates a brand-new small group led by the token holder. Remaining structural
 *  fields (life stage, parent) are left at their defaults for an admin to refine.
 *  Couples groups are created with Mixed gender focus. */
export async function createLedGroup(
  token: string,
  raw: LedGroupDetailsInput
): Promise<ActionResult<{ id: string }>> {
  try {
    const member = await getMemberByToken(token)
    if (!member) return { success: false, error: "Invalid or expired link" }

    // Discipleship runs upward before it runs downward: we ask who disciples you
    // before recording who you disciple, so nobody enters the tree rootless.
    if (!(await hasDeclaredLeader(member))) {
      return {
        success: false,
        error: "Tell us who your DGroup leader is before adding a group you lead",
      }
    }

    const parsed = ledGroupDetailsSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? "Invalid group details",
      }
    }

    const {
      name,
      groupType,
      meetingFormat,
      locationCity,
      language,
      ageRangeMin,
      ageRangeMax,
      memberLimit,
      scheduleDayOfWeek,
      scheduleTimeStart,
      scheduleTimeEnd,
    } = parsed.data

    const leaderName = `${member.firstName} ${member.lastName}`
    const created = await db.$transaction(async (tx) => {
      const group = await tx.smallGroup.create({
        data: {
          name,
          leaderId: member.id,
          groupType,
          // Couples groups host married pairs — gender focus is always Mixed.
          genderFocus: groupType === "Couples" ? "Mixed" : undefined,
          // A satellite declared before this group existed belongs on it too —
          // that is where the admin form and the hierarchy read it from.
          parentSatellite: member.upwardSatellite,
          meetingFormat,
          locationCity,
          language,
          ageRangeMin,
          ageRangeMax,
          memberLimit,
          scheduleDayOfWeek,
          scheduleTimeStart,
          scheduleTimeEnd,
        },
        select: { id: true },
      })
      await tx.smallGroupLog.create({
        data: {
          smallGroupId: group.id,
          action: "GroupCreated",
          performedByMemberId: member.id,
          description: `Group "${name}" was created by ${leaderName} via the member portal`,
        },
      })
      return group
    })

    revalidateGroupPages(created.id)
    return { success: true, data: { id: created.id } }
  } catch {
    return { success: false, error: "Failed to create group" }
  }
}

export async function updateLedGroupDetails(
  token: string,
  groupId: string,
  raw: LedGroupDetailsInput
): Promise<ActionResult> {
  try {
    const ctx = await getLedGroup(token, groupId)
    if (!ctx) return { success: false, error: "Invalid or expired link" }

    const parsed = ledGroupDetailsSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? "Invalid group details",
      }
    }

    const {
      name,
      groupType,
      meetingFormat,
      locationCity,
      language,
      ageRangeMin,
      ageRangeMax,
      memberLimit,
      scheduleDayOfWeek,
      scheduleTimeStart,
      scheduleTimeEnd,
    } = parsed.data

    // A leader can't set a limit below the current roster size.
    if (memberLimit !== null && ctx.group._count.members > memberLimit) {
      return {
        success: false,
        error: `This group already has ${ctx.group._count.members} members — the limit can't be lower than that`,
      }
    }

    await db.smallGroup.update({
      where: { id: groupId },
      data: {
        name,
        groupType,
        // Couples groups host married pairs — gender focus is always Mixed.
        // Leave gender focus untouched when a group isn't Couples.
        ...(groupType === "Couples" ? { genderFocus: "Mixed" } : {}),
        meetingFormat,
        locationCity,
        language,
        ageRangeMin,
        ageRangeMax,
        memberLimit,
        scheduleDayOfWeek,
        scheduleTimeStart,
        scheduleTimeEnd,
      },
    })

    revalidateGroupPages(groupId)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to update group details" }
  }
}

/**
 * Deletes a group the token holder leads, for the case it exists to serve: one
 * created here by mistake. Only an *empty* group qualifies, and "empty" means
 * more than an empty roster — a group can also be somebody's parent, or have
 * people waiting at the door. Each of those is a person the delete would affect
 * silently (members are unassigned, child groups orphaned, requests cascaded
 * away by the FKs), so each gets its own refusal instead.
 */
export async function deleteLedGroup(
  token: string,
  groupId: string
): Promise<ActionResult> {
  try {
    const ctx = await getLedGroup(token, groupId)
    if (!ctx) return { success: false, error: "Invalid or expired link" }

    const { group } = ctx
    if (group._count.members > 0) {
      return {
        success: false,
        error: "Remove everyone from this group before deleting it",
      }
    }
    if (group._count.childGroups > 0) {
      return {
        success: false,
        error: "Other DGroups report to this one — an admin needs to move them first",
      }
    }
    if (group._count.memberRequests > 0) {
      return {
        success: false,
        error: "Someone is waiting to join this group — respond to the request first",
      }
    }

    await db.smallGroup.delete({ where: { id: groupId } })

    revalidateGroupPages(groupId)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to delete group" }
  }
}

// ─── Led groups: roster ──────────────────────────────────────────────────────

export type MemberSearchResult = {
  id: string
  name: string
  currentGroupName: string | null
}

export async function searchMembersToAdd(
  token: string,
  groupId: string,
  query: string
): Promise<ActionResult<{ members: MemberSearchResult[] }>> {
  try {
    const ctx = await getLedGroup(token, groupId)
    if (!ctx) return { success: false, error: "Invalid or expired link" }

    const q = query.trim()
    if (q.length < 2) return { success: true, data: { members: [] } }

    const members = await db.member.findMany({
      where: {
        AND: [
          // `not` alone would also exclude members with no group (NULL)
          { OR: [{ smallGroupId: null }, { smallGroupId: { not: groupId } }] },
          personSearchWhere(q, { fields: PERSON_NAME_FIELDS }) ?? {},
        ],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        smallGroup: { select: { name: true } },
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      take: 10,
    })

    return {
      success: true,
      data: {
        members: members.map((m) => ({
          id: m.id,
          name: `${m.firstName} ${m.lastName}`,
          currentGroupName: m.smallGroup?.name ?? null,
        })),
      },
    }
  } catch {
    return { success: false, error: "Search failed" }
  }
}

export async function addMemberToLedGroup(
  token: string,
  groupId: string,
  memberId: string
): Promise<ActionResult> {
  try {
    const ctx = await getLedGroup(token, groupId)
    if (!ctx) return { success: false, error: "Invalid or expired link" }
    const { group, member: leader } = ctx

    if (
      group.memberLimit !== null &&
      group._count.members >= group.memberLimit
    ) {
      return {
        success: false,
        error: `This group has reached its member limit of ${group.memberLimit}`,
      }
    }

    const target = await db.member.findUnique({
      where: { id: memberId },
      select: {
        firstName: true,
        lastName: true,
        smallGroupId: true,
        smallGroup: { select: { name: true } },
      },
    })
    if (!target) return { success: false, error: "Member not found" }
    if (target.smallGroupId === groupId) {
      return { success: false, error: "This member is already in your group" }
    }

    const targetName = `${target.firstName} ${target.lastName}`
    const leaderName = `${leader.firstName} ${leader.lastName}`
    const fromGroupId = target.smallGroupId

    await db.$transaction([
      db.member.update({
        where: { id: memberId },
        data: { smallGroupId: groupId, groupStatus: "Member" },
      }),
      db.smallGroupLog.create({
        data: {
          smallGroupId: groupId,
          action: fromGroupId ? "MemberTransferred" : "MemberAdded",
          memberId,
          fromGroupId,
          toGroupId: fromGroupId ? groupId : null,
          description: fromGroupId
            ? `${targetName} was transferred from ${target.smallGroup?.name ?? "another group"} by ${leaderName} via the member portal`
            : `${targetName} was added to the group by ${leaderName} via the member portal`,
        },
      }),
    ])

    revalidateGroupPages(groupId)
    if (fromGroupId) revalidatePath(`/small-groups/${fromGroupId}`)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to add member" }
  }
}

/** Token-authed spouse lookup (from Family data) for the couples add flow. */
export async function getSpouseForLedGroupMember(
  token: string,
  memberId: string
): Promise<ActionResult<SpouseInfo | null>> {
  try {
    const member = await getMemberByToken(token)
    if (!member) return { success: false, error: "Invalid or expired link" }
    const spouse = await findSpouse(memberId)
    return { success: true, data: spouse }
  } catch {
    return { success: false, error: "Failed to look up spouse" }
  }
}

/**
 * Adds a married couple to a Couples group the token holder leads, in one
 * transaction. Each spouse's one-group-per-member rule applies — their
 * smallGroupId is set to this group, moving them out of any previous group.
 */
export async function addCoupleToLedGroup(
  token: string,
  groupId: string,
  memberId: string,
  spouseMemberId: string
): Promise<ActionResult> {
  try {
    const ctx = await getLedGroup(token, groupId)
    if (!ctx) return { success: false, error: "Invalid or expired link" }
    const { group, member: leader } = ctx

    if (memberId === spouseMemberId) {
      return { success: false, error: "A member cannot be their own spouse" }
    }

    if (
      group.memberLimit !== null &&
      group._count.members + 2 > group.memberLimit
    ) {
      return {
        success: false,
        error: `Adding both spouses would exceed the member limit of ${group.memberLimit}`,
      }
    }

    const [member, spouse] = await Promise.all([
      db.member.findUnique({
        where: { id: memberId },
        select: { firstName: true, lastName: true, smallGroupId: true },
      }),
      db.member.findUnique({
        where: { id: spouseMemberId },
        select: { firstName: true, lastName: true, smallGroupId: true },
      }),
    ])
    if (!member || !spouse) return { success: false, error: "Member not found" }

    const leaderName = `${leader.firstName} ${leader.lastName}`
    const fromGroupIds = new Set(
      [member.smallGroupId, spouse.smallGroupId].filter(
        (id): id is string => !!id && id !== groupId
      )
    )

    await db.$transaction(async (tx) => {
      for (const [id, person, from] of [
        [memberId, member, member.smallGroupId],
        [spouseMemberId, spouse, spouse.smallGroupId],
      ] as const) {
        await tx.member.update({
          where: { id },
          data: { smallGroupId: groupId, groupStatus: "Member" },
        })
        const transferred = !!from && from !== groupId
        await tx.smallGroupLog.create({
          data: {
            smallGroupId: groupId,
            action: transferred ? "MemberTransferred" : "MemberAdded",
            memberId: id,
            fromGroupId: transferred ? from : null,
            toGroupId: transferred ? groupId : null,
            performedByMemberId: leader.id,
            description: `${person.firstName} ${person.lastName} was added to the group as a couple by ${leaderName} via the member portal`,
          },
        })
      }
    })

    revalidateGroupPages(groupId)
    for (const from of fromGroupIds) revalidatePath(`/small-groups/${from}`)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to add couple" }
  }
}

export async function removeMemberFromLedGroup(
  token: string,
  groupId: string,
  memberId: string
): Promise<ActionResult> {
  try {
    const ctx = await getLedGroup(token, groupId)
    if (!ctx) return { success: false, error: "Invalid or expired link" }
    const { member: leader } = ctx

    const target = await db.member.findUnique({
      where: { id: memberId },
      select: { firstName: true, lastName: true, smallGroupId: true },
    })
    if (!target || target.smallGroupId !== groupId) {
      return { success: false, error: "This member is not in your group" }
    }

    await db.$transaction([
      db.member.update({
        where: { id: memberId },
        data: { smallGroupId: null, groupStatus: null },
      }),
      db.smallGroupLog.create({
        data: {
          smallGroupId: groupId,
          action: "MemberRemoved",
          memberId,
          description: `${target.firstName} ${target.lastName} was removed from the group by ${leader.firstName} ${leader.lastName} via the member portal`,
        },
      }),
    ])

    revalidateGroupPages(groupId)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to remove member" }
  }
}
