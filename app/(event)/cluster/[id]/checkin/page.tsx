import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Target, UserCheck, UserRoundCheck, Users } from "lucide-react"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import {
  getAccessibleClusterEvents,
  getClusterCheckinShortcuts,
  getClusterDayRows,
} from "@/lib/clusters/aggregate"
import { clusterOffersPerEventCheckin } from "@/lib/clusters/checkin-shortcuts"
import { buildClusterRoster } from "@/lib/clusters/roster"
import {
  buildClusterCheckinStats,
  formatClusterCheckinRatio,
  type ClusterCheckinPerson,
} from "@/lib/clusters/checkin-board"
import { formatTurnoutRate } from "@/lib/events/turnout"
import { canWrite } from "@/lib/permissions"
import { clusterCheckinPath, clusterWalkInPath } from "@/lib/public-routes"
import { DetailPageHeader } from "@/components/detail-page-header"
import { StatCard } from "@/components/session-stat-card"
import { ClusterCheckinClient } from "./checkin-client"
import { ClusterCheckinShortcuts } from "./checkin-shortcuts"

export const metadata: Metadata = {
  title: "Check-in",
}

export default async function ClusterCheckinPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await auth()
  const { id } = await params

  const cluster = await db.eventCluster.findUnique({
    where: { id },
    select: {
      id: true,
      date: true,
      kind: true,
      publicToken: true,
      walkInIsOpen: true,
      checkInIsOpen: true,
    },
  })
  if (!cluster) notFound()

  const accessibleEvents = await getAccessibleClusterEvents(session, id)
  // The status board covers OneTime events and Recurring events whose link
  // names a session — for those, "checked in" means checked into THAT session.
  // Recurring events without a linked session (legacy links) stay on their own
  // sessions pages, as do MultiDay events.
  const events = accessibleEvents.filter(
    (e) => e.type === "OneTime" || (e.type === "Recurring" && e.linkedOccurrenceId)
  )
  const rows = await getClusterDayRows(events, {
    clusterId: cluster.id,
    date: cluster.date,
    kind: cluster.kind,
  })
  // Volunteers are on the board too — the public kiosk has always been able to
  // check one in, and a board that couldn't show them disagreed with the screen
  // the staffer at the door was using.
  // The board is the day's arrivals list, so it stays strictly day-scoped: a
  // standing series registrant with no evidence for today is not someone this
  // screen is waiting on. They remain visible on the roster and registrants
  // screens, which describe who is on the books rather than who is expected.
  const roster = buildClusterRoster(
    events,
    rows.filter((r) => r.onClusterDay)
  )

  // Per-event check-in doors — a Parallel day's, and nobody else's; see
  // `clusterOffersPerEventCheckin` for why a Collab day gets none. They cover
  // every accessible event, not just the ones the board can monitor: a MultiDay
  // event still has a check-in link a staffer needs, even though its arrivals
  // are tracked on its own sessions page.
  const perEventDoors = clusterOffersPerEventCheckin(cluster.kind)
  const shortcuts = perEventDoors
    ? await getClusterCheckinShortcuts(accessibleEvents, cluster.date)
    : []
  const writable = canWrite(session, "Events")

  const people: ClusterCheckinPerson[] = roster.rows.map((person) => {
    const cells = events
      .map((e) => ({ event: e, cell: person.perEvent[e.id] }))
      .filter((c) => c.cell !== undefined)
    // Their arrival, on whichever of the day's events they reached first. The
    // hour is formatted here rather than in the client: timestamps are stored in
    // UTC and read in Manila time, and formatting on both sides of hydration is
    // how the two come to disagree about what time it is.
    const arrivals = cells
      .map((c) => c.cell!.checkedInAt)
      .filter((at): at is Date => at !== null)
    const earliest = arrivals.reduce<Date | null>(
      (soonest, at) => (soonest === null || at < soonest ? at : soonest),
      null
    )
    return {
      key: person.key,
      name: `${person.firstName} ${person.lastName}`.trim(),
      phone: person.phone,
      isMember: person.isMember,
      isVolunteer: person.isVolunteer,
      gender: person.gender,
      events: cells.map((c) => ({
        eventId: c.event.id,
        eventName: c.event.name,
        registrantId: c.cell!.registrantId,
        kind: c.cell!.kind,
        checkedIn: c.cell!.checkedIn,
      })),
      checkedInAtFormatted:
        earliest?.toLocaleTimeString("en-PH", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Asia/Manila",
        }) ?? null,
    }
  })

  const stats = buildClusterCheckinStats(people)

  return (
    <>
      {/* The subtitle says what the screen is; the tiles below say what the
          numbers are. It used to carry "N of M checked in" itself, because the
          tiles it shared the page with restated exactly that and nothing more.
          The set below breaks the day down — attendees against volunteers, and a
          rate — so the ratio now has one home instead of two. */}
      <DetailPageHeader
        title="Check-in"
        subtitle={
          <p className="text-sm text-muted-foreground">
            {perEventDoors
              ? "Live status across the day\u2019s events"
              : "Live status for the day"}{" "}
            — attendance is recorded on the kiosk below
          </p>
        }
      />

      <div className="flex flex-1 flex-col gap-6 p-6">
        {/* The same tile set the session detail screen carries, in the same
            two/three/five step: the workspace sidebar is still expanded at
            tablet widths, so five tiles only lay out in a row once the viewport
            can afford them. */}
        {events.length > 0 && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
            <StatCard
              label="Expected"
              value={stats.expected}
              icon={<Users className="size-4" />}
            />
            {/* The gender split describes the room, so it rides the arrivals
                tile rather than the expected one — the same reading the session
                screen's Total tile has, where every row is someone present. */}
            <StatCard
              label="Checked in"
              value={stats.checkedInCount}
              icon={<UserRoundCheck className="size-4" />}
              genderBar={{ men: stats.menCount, women: stats.womenCount }}
              caption={
                // An empty day has nobody outstanding, which is not the same
                // claim as everyone having arrived.
                stats.expected === 0
                  ? "Nobody on the day yet"
                  : stats.notInCount === 0
                    ? "Everyone is in"
                    : `${stats.notInCount.toLocaleString()} not in yet`
              }
            />
            <StatCard
              label="Attendees"
              value={stats.attendeesCheckedIn}
              icon={<Users className="size-4" />}
              caption={`of ${stats.attendeesExpected.toLocaleString()} expected`}
            />
            <StatCard
              label="Volunteers"
              value={stats.volunteersCheckedIn}
              icon={<UserCheck className="size-4" />}
              caption={`of ${stats.volunteersExpected.toLocaleString()} expected`}
            />
            {/* Arrivals over the day's people — volunteers counted in both
                halves, since a cluster day's denominator is who it expects
                rather than who holds a registration. The caption spells the
                ratio out for the same reason every other turnout figure does. */}
            <StatCard
              label="Turnout"
              value={formatTurnoutRate(stats.turnout.rate)}
              icon={<Target className="size-4" />}
              caption={
                stats.expected === 0
                  ? "Nobody on the day yet"
                  : formatClusterCheckinRatio(stats)
              }
            />
          </div>
        )}

        <ClusterCheckinShortcuts
          shortcuts={shortcuts}
          canConfigure={writable}
          // The day's kiosk. Same treatment as the door beside it: hidden from
          // read-only staff because it writes attendance, and swapped for the
          // switch link while closed so the row never dead-ends.
          checkInHref={
            writable && accessibleEvents.length > 0 && cluster.checkInIsOpen
              ? clusterCheckinPath(cluster.publicToken)
              : null
          }
          checkInSettingsHref={
            writable && accessibleEvents.length > 0 && !cluster.checkInIsOpen
              ? `/cluster/${cluster.id}/forms/check-in`
              : null
          }
          // The door link registers and checks someone in across the day in one
          // pass. Hidden from read-only staff: it writes registrations and
          // attendance. Also null while the door is closed (CCF-133) — the
          // switch link takes over, so the button never dead-ends.
          walkInHref={
            writable && accessibleEvents.length > 0 && cluster.walkInIsOpen
              ? clusterWalkInPath(cluster.publicToken)
              : null
          }
          walkInSettingsHref={
            writable && accessibleEvents.length > 0 && !cluster.walkInIsOpen
              ? `/cluster/${cluster.id}/forms/walk-in`
              : null
          }
        />

        <ClusterCheckinClient
          clusterId={cluster.id}
          canEdit={writable}
          people={people}
          events={perEventDoors ? events.map((e) => ({ id: e.id, name: e.name })) : []}
          hasCheckinEvents={events.length > 0}
          // A Collab registrant holds exactly one of the day's events, so the
          // per-event badge column is the same word on every row — and the one
          // it isn't is the partner ministry's, which this day is built to stop
          // showing. Collapsed, an arrival is one line.
          showEventBreakdown={perEventDoors}
        />
      </div>
    </>
  )
}
