import { buildTurnout, type EventTurnout } from "@/lib/events/turnout"
import type { ClusterGender } from "@/lib/clusters/roster"

/**
 * Pure view logic for the cluster **admin** check-in board — the counters, the
 * filters and the ordering behind `/cluster/[id]/checkin`.
 *
 * Split out for the same reason `lib/session-attendees.ts` is: the board is the
 * cluster's answer to the session detail screen, and the two now render the same
 * way — stat tiles over a filtered list, cards below `xl` and a `DataTable`
 * above it. Keeping the arithmetic here (no React, no Prisma) is what lets both
 * halves of that split read one set of figures, and lets the figures be tested
 * without a database.
 *
 * Nothing here writes. The board monitors; attendance is recorded on the kiosk.
 */

/** One of the day's events, as it stands for one person. */
export type ClusterCheckinPersonEvent = {
  eventId: string
  eventName: string
  /** The `EventRegistrant` id, or the `Volunteer` id when `kind` is Volunteer. */
  registrantId: string
  kind: "Registrant" | "Volunteer"
  checkedIn: boolean
}

export type ClusterCheckinPerson = {
  key: string
  name: string
  phone: string | null
  isMember: boolean
  /** Serving on the day rather than attending it — see the roster's person type. */
  isVolunteer: boolean
  gender: ClusterGender
  events: ClusterCheckinPersonEvent[]
  /**
   * Their earliest arrival, already formatted on the server. A string rather
   * than a `Date` because the board renders Manila time off UTC-stored
   * timestamps, and formatting on the client would let the two sides of
   * hydration disagree about the hour.
   */
  checkedInAtFormatted: string | null
}

/**
 * Where a person stands on the day as a whole.
 *
 * Three states, not two, because a **Parallel** day's registrant may hold
 * several of its events and arrive for some of them — "Partly in" is the honest
 * answer there, and collapsing it into either neighbour tells the staffer at the
 * door something untrue. A **Collab** registrant holds exactly one event, so the
 * middle state simply never occurs and the board never shows it.
 */
export type ClusterCheckinStatus = "CheckedIn" | "Partial" | "NotIn"

export function clusterCheckinStatusFor(
  person: Pick<ClusterCheckinPerson, "events">
): ClusterCheckinStatus {
  const arrived = person.events.filter((e) => e.checkedIn).length
  if (arrived === 0) return "NotIn"
  return arrived === person.events.length ? "CheckedIn" : "Partial"
}

/** Arrived on at least one of the day's events — the board's headline count. */
export function isClusterCheckinArrived(
  person: Pick<ClusterCheckinPerson, "events">
): boolean {
  return clusterCheckinStatusFor(person) !== "NotIn"
}

export type ClusterCheckinStats = {
  /** People the day is waiting on, arrived or not. */
  expected: number
  checkedInCount: number
  notInCount: number
  attendeesCheckedIn: number
  attendeesExpected: number
  volunteersCheckedIn: number
  volunteersExpected: number
  /** Gender split of the people **in the room**, not of the whole day. */
  menCount: number
  womenCount: number
  /** Arrivals against the day's expected people. */
  turnout: EventTurnout
}

/**
 * The board's five figures, derived from the same rows the list renders.
 *
 * Unlike the session screen's, this turnout counts volunteers in **both** halves
 * of the ratio: a cluster day's denominator is its people rather than its
 * registrations, and someone serving is one of them (`getClusterDayRows` unions
 * the two). That is why the caption says "expected" and never "registered" —
 * `formatTurnoutRatio` names the wrong denominator here, so the board formats
 * its own with {@link formatClusterCheckinRatio}.
 */
export function buildClusterCheckinStats(
  people: ClusterCheckinPerson[]
): ClusterCheckinStats {
  const arrived = people.filter(isClusterCheckinArrived)
  const attendees = people.filter((p) => !p.isVolunteer)
  const volunteers = people.filter((p) => p.isVolunteer)

  return {
    expected: people.length,
    checkedInCount: arrived.length,
    notInCount: people.length - arrived.length,
    attendeesCheckedIn: attendees.filter(isClusterCheckinArrived).length,
    attendeesExpected: attendees.length,
    volunteersCheckedIn: volunteers.filter(isClusterCheckinArrived).length,
    volunteersExpected: volunteers.length,
    menCount: arrived.filter((p) => p.gender === "Male").length,
    womenCount: arrived.filter((p) => p.gender === "Female").length,
    turnout: buildTurnout(people.length, arrived.length),
  }
}

/** "18 of 42 expected" — the ratio the percentage above it divides. */
export function formatClusterCheckinRatio(stats: ClusterCheckinStats): string {
  return `${stats.checkedInCount.toLocaleString()} of ${stats.expected.toLocaleString()} expected`
}

export type ClusterCheckinTypeFilter = "all" | "member" | "guest" | "volunteer"
export type ClusterCheckinStatusFilter = "all" | "in" | "out"

export type ClusterCheckinFilters = {
  type: ClusterCheckinTypeFilter
  status: ClusterCheckinStatusFilter
  /** One of the day's events, or "all". Only a Parallel day offers this. */
  eventId: string
  search: string
}

/**
 * Type is a partition, not an overlap: every volunteer is a member, so
 * "Members" means members who are not serving. Same reading the registrants
 * screen's Attendee/Volunteer filter uses, for the same reason — offering them
 * as peers would count a volunteer twice.
 */
export function filterClusterCheckinPeople<T extends ClusterCheckinPerson>(
  people: T[],
  filters: ClusterCheckinFilters
): T[] {
  const query = filters.search.trim().toLowerCase()
  return people.filter((person) => {
    if (filters.type === "member" && (!person.isMember || person.isVolunteer)) return false
    if (filters.type === "guest" && (person.isMember || person.isVolunteer)) return false
    if (filters.type === "volunteer" && !person.isVolunteer) return false

    const arrived = isClusterCheckinArrived(person)
    if (filters.status === "in" && !arrived) return false
    if (filters.status === "out" && arrived) return false

    if (
      filters.eventId !== "all" &&
      !person.events.some((e) => e.eventId === filters.eventId)
    ) {
      return false
    }

    if (query) {
      const matchesName = person.name.toLowerCase().includes(query)
      const matchesPhone = (person.phone ?? "").toLowerCase().includes(query)
      if (!matchesName && !matchesPhone) return false
    }
    return true
  })
}

export type ClusterCheckinSortDirection = "asc" | "desc"

/**
 * Who the day is still waiting on, first.
 *
 * The board exists to answer "who isn't here yet", so ascending puts the
 * un-arrived at the top rather than sorting the status label alphabetically —
 * a list whose whole point scrolls off the bottom is a list nobody reads.
 * Descending flips it for the other question ("who has come in"), and name is
 * the tiebreak either way so the order never reshuffles between renders.
 */
const STATUS_RANK: Record<ClusterCheckinStatus, number> = {
  NotIn: 0,
  Partial: 1,
  CheckedIn: 2,
}

export function sortClusterCheckinPeople<T extends ClusterCheckinPerson>(
  people: T[],
  direction: ClusterCheckinSortDirection
): T[] {
  const sign = direction === "asc" ? 1 : -1
  return [...people].sort((left, right) => {
    const byStatus =
      STATUS_RANK[clusterCheckinStatusFor(left)] -
      STATUS_RANK[clusterCheckinStatusFor(right)]
    if (byStatus !== 0) return byStatus * sign
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  })
}

/**
 * A person's record links to where that record is edited, and the two live in
 * different places: a registration on the event's registrants screen, a sign-up
 * to serve on its volunteers screen. Sending a volunteer to
 * `/registrants/<volunteer id>` would 404 on an id that table has never held.
 */
export function clusterCheckinPersonHref(e: ClusterCheckinPersonEvent): string {
  return e.kind === "Volunteer"
    ? `/event/${e.eventId}/volunteers/${e.registrantId}`
    : `/event/${e.eventId}/registrants/${e.registrantId}`
}
