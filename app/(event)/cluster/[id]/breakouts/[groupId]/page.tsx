import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { ClusterKind } from "@/app/generated/prisma/client"
import { BreakoutDetail } from "@/app/(event)/event/[id]/breakouts/[groupId]/breakout-detail"
import { GroupActions } from "@/app/(event)/event/[id]/breakouts/[groupId]/group-actions"
import { BreakoutNavHeader } from "@/app/(event)/event/[id]/breakouts/[groupId]/breakout-nav-header"
import { BreadcrumbOverride } from "@/components/breadcrumb-context"
import { breakoutOccupancy } from "@/lib/breakouts/occupancy"
import { clusterSurface } from "@/lib/breakouts/owner"
import { getAccessibleClusterEvents } from "@/lib/clusters/aggregate"
import { clusterDayAttendedAt } from "@/lib/clusters/day-registration"

/**
 * One cluster-owned breakout table (CCF-148).
 *
 * The event workspace's detail screen already takes a `BreakoutSurface` and
 * drives every write through it, so this page is the same screen with the
 * cluster's owner and route base — not a fork. Without it, `basePath` built a
 * `/cluster/<id>/breakouts/<groupId>` href on the day's Breakouts list that
 * landed on a 404, and a collab day's tables could be created but never opened.
 *
 * Two things the event page gets from its event have to be read from the day
 * instead: the facilitator pool (the union of both ministries' standing
 * rosters, which is what facilitator eligibility draws on) and attendance,
 * which is folded to a single "Attended" for the day — see
 * {@link clusterDayAttendedAt}.
 */
async function getBreakoutGroup(groupId: string, clusterId: string) {
  return db.breakoutGroup.findFirst({
    where: { id: groupId, clusterId },
    include: {
      facilitator: {
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              ledGroups: { select: { id: true, name: true } },
            },
          },
        },
      },
      coFacilitator: {
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              ledGroups: { select: { id: true, name: true } },
            },
          },
        },
      },
      linkedSmallGroup: { select: { id: true, name: true } },
      lifeStages: { select: { id: true, name: true }, orderBy: { order: "asc" as const } },
      members: {
        orderBy: { assignedAt: "asc" },
        include: {
          registrant: {
            select: {
              id: true,
              // The row's own event — a cluster table seats people from either
              // member event, and their registrant page lives in that event's
              // workspace, which the cluster surface cannot supply.
              eventId: true,
              memberId: true,
              guestId: true,
              firstName: true,
              lastName: true,
              nickname: true,
              mobileNumber: true,
              attendedAt: true,
              occurrenceAttendances: {
                select: {
                  occurrenceId: true,
                  checkedInAt: true,
                  occurrence: { select: { date: true } },
                },
                orderBy: { occurrence: { date: "asc" } },
              },
              member: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  smallGroup: { select: { id: true, name: true } },
                  groupStatus: true,
                },
              },
              guest: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
      },
    },
  })
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; groupId: string }>
}): Promise<Metadata> {
  const { id, groupId } = await params
  const group = await db.breakoutGroup.findFirst({
    where: { id: groupId, clusterId: id },
    select: { name: true },
  })
  return { title: group?.name ?? "Breakout Group" }
}

export default async function ClusterBreakoutGroupDetailPage({
  params,
}: {
  params: Promise<{ id: string; groupId: string }>
}) {
  const { id: clusterId, groupId } = await params

  const [session, cluster, group, lifeStages, siblingGroups] = await Promise.all([
    auth(),
    db.eventCluster.findUnique({
      where: { id: clusterId },
      select: { id: true, kind: true, date: true },
    }),
    getBreakoutGroup(groupId, clusterId),
    db.lifeStage.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    db.breakoutGroup.findMany({
      where: { clusterId, id: { not: groupId } },
      select: { id: true, name: true, memberLimit: true, _count: { select: { members: true } } },
      orderBy: { name: "asc" },
    }),
  ])

  if (!cluster || !group) notFound()
  // Only a Collab owns tables — the same guard the day's Breakouts list applies.
  if (cluster.kind !== ClusterKind.Collab) notFound()

  const events = await getAccessibleClusterEvents(session, clusterId)
  const linkedOccurrenceByEvent = new Map(
    events.map((e) => [e.id, e.linkedOccurrenceId] as const)
  )

  // Facilitator eligibility is the union of both ministries' standing rosters,
  // not just the people who signed up through the day's form — the same pool
  // `getClusterBreakoutPool` hands the day's Breakouts list.
  const confirmedVolunteers = events.length
    ? await db.volunteer.findMany({
        where: { eventId: { in: events.map((e) => e.id) }, status: "Confirmed" },
        orderBy: { createdAt: "asc" },
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              ledGroups: { select: { id: true, name: true } },
            },
          },
        },
      })
    : []

  const surface = clusterSurface(clusterId)

  // A Collab day is one sitting, so the members table shows a single "Attended"
  // rather than a session tally: each person's own event's check-in for the day,
  // whichever of the two shapes it took, is projected onto `attendedAt` and the
  // occurrence list is emptied. `totalOccurrences: 0` then has nothing to count.
  const members = group.members.map((m) => ({
    ...m,
    registrant: {
      ...m.registrant,
      attendedAt: clusterDayAttendedAt(m.registrant, {
        date: cluster.date,
        linkedOccurrenceId: linkedOccurrenceByEvent.get(m.registrant.eventId) ?? null,
      }),
      occurrenceAttendances: [],
    },
  }))

  return (
    <>
      <BreadcrumbOverride
        href={`/cluster/${clusterId}/breakouts/${groupId}`}
        label={group.name}
      />
      <BreakoutNavHeader
        groupId={groupId}
        basePath={surface.basePath}
        title={group.name}
        subtitle={
          <p className="text-sm text-muted-foreground">
            {group.memberLimit != null
              ? `${breakoutOccupancy({ memberCount: group.members.length, memberLimit: group.memberLimit }).label} members`
              : "No member cap"}
            {/* The setting lives inside the edit drawer, so without this the
                only way to see it from the group's own page is to open the form. */}
            {group.manualAssignOnly && <> · Manual assignment only</>}
          </p>
        }
        action={
          <GroupActions
            group={{
              id: group.id,
              name: group.name,
              facilitatorId: group.facilitatorId,
              memberLimit: group.memberLimit,
              manualAssignOnly: group.manualAssignOnly,
              linkedSmallGroupId: group.linkedSmallGroupId,
              lifeStages: group.lifeStages,
              genderFocus: group.genderFocus,
              language: group.language,
              ageRangeMin: group.ageRangeMin,
              ageRangeMax: group.ageRangeMax,
            }}
            surface={surface}
            lifeStages={lifeStages}
            volunteers={confirmedVolunteers}
            isEnabled={group.isEnabled}
          />
        }
      />

      <div className="flex flex-1 flex-col gap-6 p-6">
        <BreakoutDetail
          surface={surface}
          group={{
            id: group.id,
            // Null on purpose: a cluster owns this table, so there is no event
            // behind it. The detail screen already reads this as nullable.
            eventId: null,
            name: group.name,
            facilitatorId: group.facilitatorId,
            facilitator: group.facilitator,
            coFacilitatorId: group.coFacilitatorId,
            coFacilitator: group.coFacilitator,
            linkedSmallGroupId: group.linkedSmallGroupId,
            linkedSmallGroup: group.linkedSmallGroup,
            lifeStages: group.lifeStages,
            genderFocus: group.genderFocus,
            language: group.language,
            ageRangeMin: group.ageRangeMin,
            ageRangeMax: group.ageRangeMax,
            memberLimit: group.memberLimit,
            members,
            eventType: "OneTime",
            totalOccurrences: 0,
          }}
          availableVolunteers={confirmedVolunteers}
          siblingGroups={siblingGroups.map((g) => ({
            id: g.id,
            name: g.name,
            memberLimit: g.memberLimit,
            memberCount: g._count.members,
          }))}
        />
      </div>
    </>
  )
}
