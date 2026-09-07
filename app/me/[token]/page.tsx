import type { Metadata } from "next"
import { randomUUID } from "crypto"
import { notFound, redirect } from "next/navigation"
import { db } from "@/lib/db"
import { portalTokenWhere } from "@/lib/people/portal-tokens"
import { mapCouplesInRoster } from "@/lib/family-links"
import { getLeaderOptions } from "@/lib/small-groups/leader-options"
import { GuestOnboardingClient } from "./guest-onboarding-client"
import { MePortalClient } from "./me-portal-client"

/**
 * A guest holds a token of their own until they name their leader, which promotes
 * them. Resolving members first keeps a promoted guest's old link working: their
 * guest row survives promotion, so it is followed through to the member portal
 * rather than dead-ending on a screen they have already finished.
 */
async function resolveGuestToken(token: string) {
  const guest = await db.guest.findFirst({
    where: portalTokenWhere(token),
    select: {
      id: true,
      firstName: true,
      nickname: true,
      memberId: true,
      claimedSmallGroupId: true,
      claimedSatellite: true,
    },
  })
  if (!guest) notFound()

  if (guest.memberId) {
    const member = await db.member.findUnique({
      where: { id: guest.memberId },
      select: { id: true, selfServiceToken: true },
    })
    if (!member) notFound()
    let memberToken = member.selfServiceToken
    if (!memberToken) {
      memberToken = randomUUID()
      await db.member.update({
        where: { id: member.id },
        data: { selfServiceToken: memberToken },
      })
    }
    redirect(`/me/${memberToken}`)
  }

  return guest
}

export const metadata: Metadata = {
  title: { absolute: "Member Portal" },
}

export const dynamic = "force-dynamic"

export default async function MemberPortalPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const member = await db.member.findFirst({
    where: portalTokenWhere(token),
    select: {
      id: true,
      firstName: true,
      lastName: true,
      nickname: true,
      groupStatus: true,
      smallGroup: {
        select: {
          id: true,
          name: true,
          scheduleDayOfWeek: true,
          scheduleTimeStart: true,
          scheduleTimeEnd: true,
          leader: { select: { firstName: true, lastName: true } },
        },
      },
      upwardSatellite: true,
      ledGroups: {
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          groupType: true,
          parentSatellite: true,
          memberLimit: true,
          meetingFormat: true,
          locationCity: true,
          language: true,
          ageRangeMin: true,
          ageRangeMax: true,
          scheduleDayOfWeek: true,
          scheduleTimeStart: true,
          scheduleTimeEnd: true,
          members: {
            orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
            select: {
              id: true,
              firstName: true,
              lastName: true,
              groupStatus: true,
            },
          },
        },
      },
    },
  })
  if (!member) {
    const guest = await resolveGuestToken(token)
    return (
      <GuestOnboardingClient
        token={token}
        guest={{
          firstName: guest.firstName,
          nickname: guest.nickname,
          claimedGroupId: guest.claimedSmallGroupId,
          claimedSatellite: guest.claimedSatellite,
        }}
        leaderOptions={await getLeaderOptions()}
      />
    )
  }

  const [pendingRequest, leaderOptions] = await Promise.all([
    db.smallGroupMemberRequest.findFirst({
      where: { memberId: member.id, status: "Pending" },
      select: {
        id: true,
        smallGroup: { select: { id: true, name: true } },
      },
    }),
    getLeaderOptions(member.smallGroup?.id),
  ])

  // For Couples groups, derive each member's in-group spouse from Family data so
  // the roster can pair them. Non-couples groups skip the lookup entirely.
  const ledGroups = await Promise.all(
    member.ledGroups.map(async (g) => {
      if (g.groupType !== "Couples") {
        return { ...g, members: g.members.map((m) => ({ ...m, spouseId: null })) }
      }
      const pairs = await mapCouplesInRoster(g.members.map((m) => m.id))
      return {
        ...g,
        members: g.members.map((m) => ({ ...m, spouseId: pairs.get(m.id) ?? null })),
      }
    })
  )

  // Upward accountability belongs to the person, not to each group they lead, so
  // the portal shows a single satellite. The member column is the source of truth;
  // the fall back to the groups covers leaders who declared one before that column
  // existed.
  const upwardSatellite =
    member.upwardSatellite ??
    ledGroups.find((g) => g.parentSatellite)?.parentSatellite ??
    null

  // "Who is your leader?" comes before "which groups do you lead?" — the same
  // three answers `hasDeclaredLeader` accepts server-side.
  const canAddGroup = Boolean(
    member.smallGroup || upwardSatellite || pendingRequest
  )

  return (
    <MePortalClient
      token={token}
      member={{
        firstName: member.firstName,
        nickname: member.nickname,
        groupStatus: member.groupStatus,
      }}
      myGroup={member.smallGroup}
      upwardSatellite={upwardSatellite}
      canAddGroup={canAddGroup}
      pendingRequest={
        pendingRequest?.smallGroup
          ? {
              id: pendingRequest.id,
              groupId: pendingRequest.smallGroup.id,
              groupName: pendingRequest.smallGroup.name,
            }
          : null
      }
      ledGroups={ledGroups}
      leaderOptions={leaderOptions}
    />
  )
}
