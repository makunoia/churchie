import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { db } from "@/lib/db"
import { requireEventModule } from "@/lib/events/require-module"
import { BreakoutDetail } from "./breakout-detail"
import { GroupActions } from "./group-actions"
import { BreakoutNavHeader } from "./breakout-nav-header"
import { BreadcrumbOverride } from "@/components/breadcrumb-context"
import { breakoutOccupancy } from "@/lib/breakouts/occupancy"
import { eventSurface } from "@/lib/breakouts/owner"

/**
 * Name only. A facilitator's DGroups are shown ("Leads X") and one of them may
 * be picked as the Catch Mech target — neither needs its matching criteria,
 * which the breakout group no longer inherits.
 */
const ledGroupsSelect = {
  select: { id: true, name: true },
} as const

async function getBreakoutGroup(groupId: string, eventId: string) {
  return db.breakoutGroup.findFirst({
    where: { id: groupId, eventId },
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
              // The row's own event, so a member links to their registrant page in
              // the right workspace even when a cluster owns the table (CCF-148).
              eventId: true,
              memberId: true,
              guestId: true,
              firstName: true,
              lastName: true,
              nickname: true,
              mobileNumber: true,
              attendedAt: true,
              occurrenceAttendances: {
                select: { occurrence: { select: { date: true } } },
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

async function getEventContext(eventId: string) {
  return db.event.findUnique({
    where: { id: eventId },
    select: {
      type: true,
      volunteers: {
        where: { status: "Confirmed" },
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              ledGroups: ledGroupsSelect,
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
    where: { id: groupId, eventId: id },
    select: { name: true },
  })
  return { title: group?.name ?? "Breakout Group" }
}

export default async function BreakoutGroupDetailPage({
  params,
}: {
  params: Promise<{ id: string; groupId: string }>
}) {
  const { id: eventId, groupId } = await params
  await requireEventModule(eventId, "Breakout")
  const [group, eventData, lifeStages, totalOccurrences, siblingGroups] = await Promise.all([
    getBreakoutGroup(groupId, eventId),
    getEventContext(eventId),
    db.lifeStage.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    db.eventOccurrence.count({ where: { eventId } }),
    // Transfer targets for the members table (CCF-139). Fetched here rather than
    // via a client round-trip since the page already fans out.
    db.breakoutGroup.findMany({
      where: { eventId, id: { not: groupId } },
      select: { id: true, name: true, memberLimit: true, _count: { select: { members: true } } },
      orderBy: { name: "asc" },
    }),
  ])

  if (!group || !eventData) notFound()

  const surface = eventSurface(eventId)
  const confirmedVolunteers = [...eventData.volunteers]

  return (
    <>
      <BreadcrumbOverride
        href={`/event/${eventId}/breakouts/${groupId}`}
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
          eventId,
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
          members: group.members,
          eventType: eventData.type,
          totalOccurrences,
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
