import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canExport, canImport, canWrite } from "@/lib/permissions"
import { isEstablishedAttendee, resolveAttendeeStatus } from "@/lib/session-stats"
import { ministryLabel } from "@/lib/events/ministry-label"
import { breakoutOccupancy } from "@/lib/breakouts/occupancy"
import { resolvePoolScope } from "@/lib/events/pool-scope"
import { anyOwner } from "@/lib/breakouts/owner"
import { BreadcrumbOverride } from "@/components/breadcrumb-context"
import { DetailPageHeader } from "@/components/detail-page-header"
import { SessionAttendeesTable } from "./session-attendees-table"
import { SessionExportButton } from "./session-export-button"
import { SessionImportButton } from "./session-import-button"

async function getOccurrenceDetail(occurrenceId: string) {
  const occurrence = await db.eventOccurrence.findUnique({
    where: { id: occurrenceId },
    include: {
      event: {
        select: {
          id: true,
          name: true,
          type: true,
          allMinistries: true,
          ministries: { include: { ministry: { select: { name: true } } } },
        },
      },
      attendees: {
        orderBy: { checkedInAt: "asc" },
        include: {
          registrant: {
            select: {
              id: true,
              memberId: true,
              guestId: true,
              member: { select: { firstName: true, lastName: true, gender: true } },
              guest: { select: { firstName: true, lastName: true, gender: true } },
              firstName: true,
              lastName: true,
              occurrenceAttendances: {
                select: {
                  occurrenceId: true,
                  occurrence: { select: { date: true } },
                },
              },
              breakoutGroupMemberships: {
                select: {
                  breakoutGroupId: true,
                  breakoutGroup: {
                    select: {
                      name: true,
                    },
                  },
                },
              },
            },
          },
          volunteer: {
            select: {
              id: true,
              member: { select: { firstName: true, lastName: true, gender: true } },
            },
          },
        },
      },
    },
  })

  if (!occurrence) return null

  // Which tables this session runs, and whose volunteers may staff them.
  //
  // BOTH sets under a Collab: this event's own standing tables, which it keeps
  // whether or not it shares a day, plus the day's cluster-owned ones. A sitting
  // can need a stand-in at either, and offering only one of them leaves the other
  // unstaffable — which is how the day's tables were unreachable before, and how
  // the event's own would be unreachable if the fix simply swapped the two.
  // Either ministry's roster can supply the substitute — see
  // lib/events/pool-scope.ts.
  const scope = await resolvePoolScope(occurrence.event.id)
  const sessionTables = anyOwner(
    scope.clusterBreakoutOwner
      ? [scope.breakoutOwner, scope.clusterBreakoutOwner]
      : [scope.breakoutOwner]
  )

  const [
    volunteers,
    breakoutGroups,
    subFacilitators,
    totalRegistrants,
    siblingOccurrences,
  ] = await Promise.all([
    db.volunteer.findMany({
      where: { eventId: { in: scope.volunteerEventIds } },
      select: {
        id: true,
        memberId: true,
        member: { select: { firstName: true, lastName: true } },
      },
    }),
    db.breakoutGroup.findMany({
      where: sessionTables,
      orderBy: { name: "asc" },
      include: {
        facilitator: {
          select: {
            // Facilitators are volunteers — presence comes from their own volunteer check-in.
            occurrenceAttendances: { where: { occurrenceId }, select: { id: true } },
            member: {
              select: {
                firstName: true,
                lastName: true,
                eventRegistrations: {
                  where: { eventId: { in: scope.candidateEventIds } },
                  select: {
                    occurrenceAttendances: {
                      where: { occurrenceId },
                      select: { id: true },
                    },
                  },
                },
              },
            },
          },
        },
        coFacilitator: {
          select: {
            occurrenceAttendances: { where: { occurrenceId }, select: { id: true } },
            member: {
              select: {
                firstName: true,
                lastName: true,
                eventRegistrations: {
                  where: { eventId: { in: scope.candidateEventIds } },
                  select: {
                    occurrenceAttendances: {
                      where: { occurrenceId },
                      select: { id: true },
                    },
                  },
                },
              },
            },
          },
        },
        members: {
          include: {
            registrant: {
              select: {
                id: true,
                memberId: true,
                occurrenceAttendances: {
                  select: {
                    occurrenceId: true,
                    isReturnerOverride: true,
                    occurrence: { select: { date: true } },
                  },
                },
              },
            },
          },
        },
      },
    }),
    db.occurrenceSubFacilitator.findMany({
      where: { occurrenceId },
      select: {
        breakoutGroupId: true,
        role: true,
        substituteId: true,
        substitute: { include: { member: { select: { firstName: true, lastName: true } } } },
      },
    }),
    // The turnout denominator — the whole series roster, matching the dashboard's
    // Turnout KPI. The numerator is derived client-side from the attendee rows so
    // it tracks optimistic edits; see `buildSessionAttendeeStats`.
    db.eventRegistrant.count({ where: { eventId: occurrence.event.id } }),
    // Chronological neighbours for the ← / → header nav. Sessions read in date
    // order regardless of how the list screen groups them into series.
    db.eventOccurrence.findMany({
      where: { eventId: occurrence.event.id },
      orderBy: { date: "asc" },
      select: { id: true },
    }),
  ])

  return {
    occurrence,
    volunteers,
    breakoutGroups,
    subFacilitators,
    totalRegistrants,
    siblingOccurrences,
  }
}

function getAttendeeName(registrant: {
  memberId: string | null
  member: { firstName: string; lastName: string } | null
  guest: { firstName: string; lastName: string } | null
  firstName: string | null
  lastName: string | null
}): string | null {
  if (registrant.member) return `${registrant.member.firstName} ${registrant.member.lastName}`
  if (registrant.guest) return `${registrant.guest.firstName} ${registrant.guest.lastName}`
  return `${registrant.firstName ?? ""} ${registrant.lastName ?? ""}`.trim() || null
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; occurrenceId: string }>
}): Promise<Metadata> {
  const { id, occurrenceId } = await params
  const occurrence = await db.eventOccurrence.findFirst({
    where: { id: occurrenceId, eventId: id },
    select: { date: true },
  })
  if (!occurrence) return { title: "Session" }
  // Shorter than the in-page header — a tab has no room for the weekday.
  return {
    title: occurrence.date.toLocaleDateString("en-PH", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
  }
}

export default async function OccurrenceDetailPage({
  params,
}: {
  params: Promise<{ id: string; occurrenceId: string }>
}) {
  const { id, occurrenceId } = await params
  const session = await auth()
  const data = await getOccurrenceDetail(occurrenceId)
  if (!data || data.occurrence.event.id !== id) notFound()

  const {
    occurrence,
    volunteers,
    breakoutGroups,
    subFacilitators,
    totalRegistrants,
    siblingOccurrences,
  } = data
  const canEdit = canWrite(session, "Events")

  const currentIndex = siblingOccurrences.findIndex((o) => o.id === occurrenceId)
  const prevOccurrenceId = currentIndex > 0 ? siblingOccurrences[currentIndex - 1].id : null
  const nextOccurrenceId =
    currentIndex !== -1 && currentIndex < siblingOccurrences.length - 1
      ? siblingOccurrences[currentIndex + 1].id
      : null

  // A registrant may also be a volunteer for this event (registered + checked in via the
  // normal flow, or imported as session attendance). Cross-reference by member so those
  // attendees are recognized as volunteers rather than plain members.
  const volunteerMemberIds = new Set(
    volunteers.map((v) => v.memberId).filter((id): id is string => id !== null),
  )

  const dateLabel = occurrence.date.toLocaleDateString("en-PH", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })

  const attendeesWithStats = occurrence.attendees.map((a) => {
    const checkedInAtFormatted = a.checkedInAt.toLocaleTimeString("en-PH", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Manila",
    })

    // Volunteer attendance row — recorded directly against the Volunteer, not a registrant.
    if (a.volunteer) {
      return {
        id: a.id,
        kind: "volunteer" as const,
        subjectId: a.volunteer.id,
        name: `${a.volunteer.member.firstName} ${a.volunteer.member.lastName}`.trim() || null,
        checkedInAtFormatted,
        // Volunteers are established — never tagged "New".
        isReturner: true,
        derivedIsReturner: true,
        hasStatusOverride: false,
        isMember: true,
        isVolunteer: true,
        breakoutGroupIds: [] as string[],
        breakoutGroupNames: [] as string[],
        gender: a.volunteer.member.gender ?? null,
      }
    }

    const r = a.registrant!
    const isVolunteer = r.memberId ? volunteerMemberIds.has(r.memberId) : false
    // Members and volunteers are established — never "New". Only first-time guests are
    // tagged New, and an admin can pin that on the row itself. The derived value travels
    // to the client too, so clearing an override is a plain toggle back.
    const derivedIsReturner =
      isVolunteer ||
      isEstablishedAttendee(!!r.memberId, r.occurrenceAttendances, occurrenceId, occurrence.date)
    const isReturner =
      isVolunteer ||
      resolveAttendeeStatus(
        a.isReturnerOverride,
        !!r.memberId,
        r.occurrenceAttendances,
        occurrenceId,
        occurrence.date,
      )

    return {
      id: a.id,
      kind: "registrant" as const,
      subjectId: r.id,
      name: getAttendeeName(r),
      checkedInAtFormatted,
      isReturner,
      derivedIsReturner,
      hasStatusOverride: a.isReturnerOverride !== null,
      isMember: !!r.memberId,
      isVolunteer,
      breakoutGroupIds: r.breakoutGroupMemberships.map((m) => m.breakoutGroupId),
      breakoutGroupNames: r.breakoutGroupMemberships.map((m) => m.breakoutGroup.name),
      gender: r.member?.gender ?? r.guest?.gender ?? null,
    }
  })

  // The stat cards are derived client-side from the same rows so they track optimistic
  // edits; only the header subtitle and the export's disabled state need a count here.
  const totalCount = attendeesWithStats.length

  const breakoutStats = breakoutGroups.map((bg) => {
    // A facilitator is present if they checked in as a volunteer (current path) or,
    // for legacy data, via a linked registrant attendance.
    const facilitatorPresent =
      (bg.facilitator?.occurrenceAttendances.length ?? 0) > 0 ||
      (bg.facilitator?.member.eventRegistrations.some(
        (r) => r.occurrenceAttendances.length > 0,
      ) ?? false)

    const coFacilitatorPresent =
      (bg.coFacilitator?.occurrenceAttendances.length ?? 0) > 0 ||
      (bg.coFacilitator?.member.eventRegistrations.some(
        (r) => r.occurrenceAttendances.length > 0,
      ) ?? false)

    const subFac = subFacilitators.find(
      (s) => s.breakoutGroupId === bg.id && s.role === "Facilitator",
    )
    const subCoFac = subFacilitators.find(
      (s) => s.breakoutGroupId === bg.id && s.role === "CoFacilitator",
    )

    const checkedInMembers = bg.members.filter((m) =>
      m.registrant.occurrenceAttendances.some((a) => a.occurrenceId === occurrenceId),
    )

    // Members are established — never "New". Only first-time guests count as New.
    // Mirrors the attendees table, admin override included, so the two tabs agree.
    const bgReturnerFlags = checkedInMembers.map((m) =>
      resolveAttendeeStatus(
        m.registrant.occurrenceAttendances.find((a) => a.occurrenceId === occurrenceId)
          ?.isReturnerOverride,
        !!m.registrant.memberId,
        m.registrant.occurrenceAttendances,
        occurrenceId,
        occurrence.date,
      ),
    )

    const bgNewCount = bgReturnerFlags.filter((isRet) => !isRet).length
    const bgReturneeCount = bgReturnerFlags.filter((isRet) => isRet).length

    return {
      id: bg.id,
      name: bg.name,
      facilitatorName: bg.facilitator?.member
        ? `${bg.facilitator.member.firstName} ${bg.facilitator.member.lastName}`
        : null,
      facilitatorPresent,
      subFacilitatorId: subFac?.substituteId ?? null,
      subFacilitatorName: subFac
        ? `${subFac.substitute.member.firstName} ${subFac.substitute.member.lastName}`
        : null,
      coFacilitatorName: bg.coFacilitator?.member
        ? `${bg.coFacilitator.member.firstName} ${bg.coFacilitator.member.lastName}`
        : null,
      coFacilitatorPresent,
      subCoFacilitatorId: subCoFac?.substituteId ?? null,
      subCoFacilitatorName: subCoFac
        ? `${subCoFac.substitute.member.firstName} ${subCoFac.substitute.member.lastName}`
        : null,
      newCount: bgNewCount,
      returneeCount: bgReturneeCount,
      totalCheckedIn: checkedInMembers.length,
      // Roster size, not today's turnout — capacity is about who is assigned to
      // the group, which is what a placement fills. The counts above are who
      // showed up. Keeping both on the row is why the columns are labelled.
      occupancy: breakoutOccupancy({
        memberCount: bg.members.length,
        memberLimit: bg.memberLimit,
      }),
    }
  })

  const breakoutGroupOptions = breakoutGroups.map((bg) => ({ id: bg.id, name: bg.name }))

  const volunteerOptions = volunteers.map((v) => ({
    value: v.id,
    label: `${v.member.firstName} ${v.member.lastName}`,
  }))

  return (
    <>
      <BreadcrumbOverride
        href={`/event/${id}/sessions/${occurrenceId}`}
        label={dateLabel}
      />
      <DetailPageHeader
        title={dateLabel}
        prevHref={
          prevOccurrenceId ? `/event/${id}/sessions/${prevOccurrenceId}` : null
        }
        nextHref={
          nextOccurrenceId ? `/event/${id}/sessions/${nextOccurrenceId}` : null
        }
        subtitle={
          <p className="text-sm text-muted-foreground">
            {ministryLabel(
              occurrence.event.allMinistries,
              occurrence.event.ministries.map((em) => em.ministry.name)
            )}
            {(occurrence.event.allMinistries ||
              occurrence.event.ministries.length > 0) &&
              " · "}
            {totalCount} attended
          </p>
        }
        action={
          <>
            {canImport(session, "Events") && (
              <SessionImportButton occurrenceId={occurrenceId} />
            )}
            {canExport(session, "Events") && (
              <SessionExportButton
                eventId={id}
                occurrenceId={occurrenceId}
                sessionDate={occurrence.date.toISOString().split("T")[0]}
                disabled={totalCount === 0}
              />
            )}
          </>
        }
      />

      <div className="flex flex-1 flex-col gap-6 p-6">
        <SessionAttendeesTable
          eventId={id}
          occurrenceId={occurrenceId}
          attendees={attendeesWithStats}
          breakoutGroups={breakoutGroupOptions}
          breakoutStats={breakoutStats}
          volunteerOptions={volunteerOptions}
          totalRegistrants={totalRegistrants}
          canEdit={canEdit}
        />
      </div>
    </>
  )
}
