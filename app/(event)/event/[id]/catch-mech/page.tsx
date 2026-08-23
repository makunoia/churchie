import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { AlertTriangle, ChevronRight, ClipboardCheck, UserX, Users } from "lucide-react"
import { auth } from "@/lib/auth"
import { canRead } from "@/lib/permissions"
import { db } from "@/lib/db"
import { unassignedCandidateWhere } from "@/lib/breakouts/candidate-pool"
import { resolveCatchMechScope } from "@/lib/catch-mech/scope"
import { PageHeader } from "@/components/page-header"
import { CatchMechTable } from "./catch-mech-table"
import { WeeklyConfirmationsChart } from "./weekly-confirmations-chart"
import { buildWeeklyBuckets } from "./weekly-buckets"
import { buildCatchMechGroupRows, type CatchMechStats } from "./aggregate"

export const metadata: Metadata = {
  title: "Catch Mech",
}

async function getCatchMechData(eventId: string) {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      name: true,
      modules: { select: { type: true } },
      volunteers: {
        where: { status: "Confirmed" },
        select: { id: true },
      },
    },
  })

  if (!event) return null
  if (!event.modules.some((m) => m.type === "CatchMech")) return null

  // Queried separately rather than nested under the event: on a Collab day the
  // tables in scope belong to the CLUSTER and are endorsed to this event through
  // their facilitator, so they are not reachable as `event.breakoutGroups`.
  const scope = await resolveCatchMechScope(eventId)
  const breakoutGroups = await db.breakoutGroup.findMany({
    where: scope.where,
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      facilitatorId: true,
      // coFacilitatorId is needed only for the response tally — a co-faci gets
      // their own session and their own form, so they are a separate responder.
      coFacilitatorId: true,
      facilitator: {
        select: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              ledGroups: { select: { id: true, name: true }, orderBy: { name: "asc" } },
            },
          },
        },
      },
      coFacilitator: { select: { id: true } },
      // Substitutes staff a table too — they answer the facilitator form, so they
      // must not also be counted as owing a volunteer response.
      subFacilitators: { select: { substituteId: true } },
      members: {
        select: {
          registrant: {
            select: {
              id: true,
              memberId: true,
              guestId: true,
              member: { select: { firstName: true, lastName: true, smallGroupId: true } },
              guest: { select: { firstName: true, lastName: true, memberId: true } },
            },
          },
        },
      },
    },
  })

  const breakoutGroupIds = breakoutGroups.map((bg) => bg.id)

  // Fetch all requests for these breakout groups (single query)
  const allRequests = await db.smallGroupMemberRequest.findMany({
    where: { breakoutGroupId: { in: breakoutGroupIds } },
    select: {
      id: true,
      breakoutGroupId: true,
      memberId: true,
      guestId: true,
      status: true,
      declineReason: true,
      resolvedAt: true,
    },
  })

  // Weekly confirmation velocity (bucketing is pure — see weekly-buckets.ts)
  const weeklyBuckets = buildWeeklyBuckets(
    allRequests
      .filter((r) => r.status === "Confirmed" && r.resolvedAt)
      .map((r) => r.resolvedAt as Date)
  )

  // Build per-group rows + aggregate stats (pure, see aggregate.ts)
  const { groupRows, stats } = buildCatchMechGroupRows(breakoutGroups, allRequests)

  // Facilitator response rate — distinct responders over everyone expected to answer.
  // Counted from submissions, not sessions: a session exists as soon as a faci
  // verifies their mobile, which is not the same as answering the form.
  const submitted = await db.confirmationSubmission.findMany({
    where: { eventId, source: "CatchMech", facilitatorVolunteerId: { not: null } },
    select: { facilitatorVolunteerId: true },
    distinct: ["facilitatorVolunteerId"],
  })
  const expectedResponders = breakoutGroups.flatMap((bg) =>
    [bg.facilitatorId, bg.coFacilitatorId].filter((v): v is string => v !== null)
  )
  const respondedSet = new Set(submitted.map((s) => s.facilitatorVolunteerId))
  const response = {
    responded: expectedResponders.filter((v) => respondedSet.has(v)).length,
    expected: expectedResponders.length,
  }

  // Everyone who staffs a table in any role. They answer the FACILITATOR form —
  // the volunteer entry now redirects them there — so counting them as owing a
  // volunteer response too would make the two cards overlap and permanently
  // depress the volunteer rate.
  const staffingVolunteerIds = new Set(
    breakoutGroups.flatMap((bg) => [
      ...[bg.facilitatorId, bg.coFacilitatorId].filter((v): v is string => v !== null),
      ...bg.subFacilitators.map((slot) => slot.substituteId),
    ])
  )

  const volunteerSubmissions = await db.confirmationSubmission.findMany({
    where: { eventId, source: "CatchMechVolunteer", facilitatorVolunteerId: { not: null } },
    select: { facilitatorVolunteerId: true },
    distinct: ["facilitatorVolunteerId"],
  })
  const volunteerResponded = new Set(volunteerSubmissions.map((submission) => submission.facilitatorVolunteerId))
  // A facilitator who already submitted a volunteer response keeps their row —
  // a response given is history, and hiding it would make the ratio go backwards.
  const expectedVolunteers = event.volunteers.filter(
    (volunteer) => !staffingVolunteerIds.has(volunteer.id) || volunteerResponded.has(volunteer.id)
  )
  const volunteerResponse = {
    responded: expectedVolunteers.filter((volunteer) => volunteerResponded.has(volunteer.id)).length,
    expected: expectedVolunteers.length,
  }

  // Everyone who attended but was never seated at a table. Catch Mech's entire
  // cohort is breakout membership, so these people are invisible to every count
  // above — a household registration (which deliberately skips placement), an
  // event with auto-assign off, or a placement that hit capacity and failed.
  // `seatedWhere`, not `where`: this asks whether the person is sitting anywhere
  // at all, so it spans the event's own tables AND the whole of the day's —
  // including tables endorsed to the OTHER ministry. Someone at a partner
  // ministry's table is seated; the narrower `where` would call them unseated.
  //
  // It is the same clause as the Breakouts page's "N unassigned" off a collab
  // day, and deliberately a wider one on one — the two figures answer different
  // questions there. The Breakouts page counts who is missing from THIS EVENT's
  // set, because its assign-all button fills exactly that set. This one counts
  // who Catch Mech cannot reach at all, and a person at the day's table is
  // reachable through it.
  const unseatedCount = await db.eventRegistrant.count({
    where: { eventId, ...unassignedCandidateWhere(scope.seatedWhere) },
  })

  return { groupRows, stats, weeklyBuckets, response, volunteerResponse, unseatedCount, scope }
}

/** Whole-number percentage, guarding a zero denominator. */
function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0
}

const TONE = {
  green: { text: "text-green-600", fill: "bg-green-500" },
  amber: { text: "text-amber-600", fill: "bg-amber-500" },
  red: { text: "text-red-600", fill: "bg-red-500" },
  sky: { text: "text-sky-600", fill: "bg-sky-500" },
  violet: { text: "text-violet-600", fill: "bg-violet-500" },
  teal: { text: "text-teal-600", fill: "bg-teal-500" },
} as const

type Tone = keyof typeof TONE

const EYEBROW = "text-[11px] font-semibold tracking-[0.15em] uppercase text-muted-foreground"

/**
 * The matchable pipeline as one part-to-whole bar rather than four separate tiles:
 * Confirmed + Pending + Rejected sum to "To Match", so a segmented bar states that
 * relationship directly.
 *
 * "In DGroup" joins them in the legend but never in the bar — it is measured
 * against the full cohort, not the matchable pool. Each cell therefore prints its
 * own denominator (`% of 128` vs `% of 154`), which is what keeps the four
 * readable side by side without implying they add up.
 */
function PlacementPanel({ eventId, stats }: { eventId: string; stats: CatchMechStats }) {
  const segments = [
    {
      key: "confirmed",
      label: "Confirmed",
      value: stats.totalConfirmed,
      tone: "green" as Tone,
      href: `/event/${eventId}/catch-mech/confirmed`,
    },
    {
      key: "pending",
      label: "Pending",
      value: stats.totalPending,
      tone: "amber" as Tone,
      href: `/event/${eventId}/catch-mech/pending`,
    },
    {
      key: "rejected",
      label: "Rejected",
      value: stats.totalRejected,
      tone: "red" as Tone,
      href: `/event/${eventId}/catch-mech/rejected`,
    },
  ]

  const legend = [
    ...segments.map((s) => ({ ...s, of: stats.matchable })),
    {
      key: "in-small-group",
      label: "In DGroup",
      value: stats.totalInSmallGroup,
      tone: "sky" as Tone,
      href: `/event/${eventId}/catch-mech/in-small-group`,
      of: stats.totalCohort,
    },
  ]

  const resolved = stats.matchable - stats.totalPending
  const filled = segments.filter((s) => s.value > 0)

  return (
    <section className="overflow-hidden rounded-xl border">
      <div className="p-5 pb-4 sm:p-6 sm:pb-5">
        <p className={EYEBROW}>To Match</p>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-4xl font-semibold tracking-tight">{stats.matchable}</span>
          <span className="text-sm text-muted-foreground">
            of {stats.totalCohort} tracked · {pct(resolved, stats.matchable)}% resolved
          </span>
        </div>
      </div>

      <div className="px-5 pb-5 sm:px-6">
        <div className="flex h-2.5 gap-0.5">
          {filled.length > 0 ? (
            filled.map((s) => (
              <div
                key={s.key}
                className={`min-w-1 rounded-full ${TONE[s.tone].fill}`}
                style={{ flexGrow: s.value }}
              />
            ))
          ) : (
            <div className="flex-1 rounded-full bg-muted" />
          )}
        </div>
      </div>

      {/* -ml-px tucks each cell's left border under the panel's own, so the 2-up
          and 4-up layouts both read as an even grid with no doubled lines. */}
      <div className="-ml-px grid grid-cols-2 lg:grid-cols-4">
        {legend.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className="group flex items-start justify-between gap-2 border-t border-l px-5 py-4 transition-colors hover:bg-muted/50"
          >
            <span className="flex min-w-0 flex-col gap-1.5">
              <span className={`flex items-center gap-2 ${EYEBROW}`}>
                <span className={`size-2 shrink-0 rounded-full ${TONE[item.tone].fill}`} />
                {item.label}
              </span>
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className={`text-2xl font-semibold tracking-tight ${TONE[item.tone].text}`}>
                  {item.value}
                </span>
                <span className="text-xs text-muted-foreground">
                  {pct(item.value, item.of)}% of {item.of}
                </span>
              </span>
            </span>
            <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground/70" />
          </Link>
        ))}
      </div>
    </section>
  )
}

/** A responded/expected ratio — a meter, not a bare count. */
function ResponseCard({
  label,
  icon,
  responded,
  expected,
  unit,
  tone,
  href,
  caveat,
}: {
  label: string
  icon: React.ReactNode
  responded: number
  expected: number
  unit: string
  tone: Tone
  /** Why this ratio is not the whole story — e.g. tables nobody can answer for. */
  caveat?: string | null
  href: string
}) {
  const share = expected > 0 ? Math.min(1, responded / expected) : 0

  return (
    <Link
      href={href}
      className="group flex flex-col gap-3 rounded-xl border p-5 transition-all hover:border-foreground/20 hover:bg-muted/40 hover:shadow-sm sm:p-6"
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`flex items-center gap-2 ${EYEBROW}`}>
          <span className="text-muted-foreground/50">{icon}</span>
          {label}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground/70" />
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className={`text-3xl font-semibold tracking-tight ${TONE[tone].text}`}>
          {responded}
        </span>
        <span className="text-sm text-muted-foreground">
          of {expected} {unit}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${TONE[tone].fill}`}
            style={{ width: `${share * 100}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {pct(responded, expected)}%
        </span>
      </div>

      {caveat && (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-500">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {caveat}
        </p>
      )}
    </Link>
  )
}

/**
 * People who attended but sit at no table. They are outside every stat on this
 * page by construction, so the count links to Breakouts — the screen where you
 * can actually seat them.
 */
function UnseatedCard({ eventId, count }: { eventId: string; count: number }) {
  return (
    <Link
      href={`/event/${eventId}/breakouts`}
      className="group flex items-center justify-between gap-4 rounded-xl border border-dashed p-5 transition-all hover:border-foreground/20 hover:bg-muted/40 sm:p-6"
    >
      <span className="flex min-w-0 flex-col gap-1.5">
        <span className={`flex items-center gap-2 ${EYEBROW}`}>
          <span className="text-muted-foreground/50">
            <UserX className="size-4" />
          </span>
          Not at a table
        </span>
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-2xl font-semibold tracking-tight">{count}</span>
          <span className="text-sm text-muted-foreground">
            {count === 1 ? "registrant is" : "registrants are"} outside the counts above —
            Catch Mech only tracks people seated in a breakout group
          </span>
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground/70" />
    </Link>
  )
}

export default async function CatchMechAdminPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await getCatchMechData(id)
  if (!data) notFound()

  const { groupRows, stats, weeklyBuckets, response, volunteerResponse, unseatedCount, scope } =
    data

  // A table with neither facilitator nor co-faci contributes nothing to the
  // expected denominator, so the response card would read 100% while its members
  // stay Pending with nobody able to answer for them. Say so on the card itself.
  const unstaffedCaveat = stats.unstaffedGroupCount > 0
    ? `${stats.unstaffedGroupCount} ${stats.unstaffedGroupCount === 1 ? "table has" : "tables have"} no facilitator — ${stats.unstaffedPeopleCount} ${stats.unstaffedPeopleCount === 1 ? "person" : "people"} nobody can confirm`
    : null

  const session = await auth()
  const canViewMember = canRead(session, "Members")

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <PageHeader
        title="Catch Mech"
        description={
          scope.viaCluster
            ? `Track DGroup confirmations from this event's own breakout groups and its tables at ${scope.clusterName ?? "the collab"}`
            : "Track DGroup confirmations from breakout groups"
        }
      />

      {/* Confirmed/Rejected/Pending are measured against the matchable pool — the
          people catch mech is actually trying to place — so the three sum to 100%
          and share one segmented bar. In DGroup is measured against the full cohort
          instead: it's the share who were never candidates, so it sits outside the
          bar. Form-response rates are a separate concern and get their own row. */}
      <PlacementPanel eventId={id} stats={stats} />

      <div className="grid gap-3 sm:grid-cols-2">
        <ResponseCard
          label="Facilitator Responses"
          icon={<ClipboardCheck className="size-4" />}
          responded={response.responded}
          expected={response.expected}
          unit="facilitators"
          tone="violet"
          href={`/event/${id}/catch-mech/submissions`}
          caveat={unstaffedCaveat}
        />
        <ResponseCard
          label="Volunteer Follow-up"
          icon={<Users className="size-4" />}
          responded={volunteerResponse.responded}
          expected={volunteerResponse.expected}
          unit="volunteers"
          tone="teal"
          href={`/event/${id}/catch-mech/volunteers`}
        />
      </div>

      {unseatedCount > 0 && <UnseatedCard eventId={id} count={unseatedCount} />}

      <WeeklyConfirmationsChart
        buckets={weeklyBuckets}
        totalConfirmed={stats.totalConfirmed}
      />

      {/* Per-group table */}
      <section className="space-y-3">
        <h3 className="type-label text-muted-foreground">Breakout Groups</h3>
        <CatchMechTable groupRows={groupRows} canViewMember={canViewMember} eventId={id} />
      </section>
    </div>
  )
}
