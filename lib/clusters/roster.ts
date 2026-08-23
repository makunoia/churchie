import type { EventType } from "@/app/generated/prisma/client"

/**
 * Pure roster-matrix builder for the cluster dashboard (CCF-132) — person ×
 * events for the day. No DB access so the de-duplication logic is unit-testable.
 */

export type ClusterRosterEvent = {
  id: string
  name: string
  type: EventType
}

/**
 * What kind of record puts this person on the day.
 *
 * A volunteer is not an `EventRegistrant` and never becomes one — the two are
 * mutually exclusive by design (`findEventVolunteerConflict` refuses a
 * registration from someone serving the event, and `OccurrenceAttendee` keys
 * attendance to one or the other). But somebody serving IS one of the day's
 * people, and a day roster that counts only attendees under-reports who is
 * there. So the two are unioned at the read layer, each keeping its own record,
 * and the surfaces say which is which.
 */
export type ClusterParticipantKind = "Registrant" | "Volunteer"

export type ClusterRegistrantRow = {
  /** The `EventRegistrant` id, or the `Volunteer` id when `kind` is Volunteer. */
  id: string
  kind: ClusterParticipantKind
  eventId: string
  eventType: EventType
  memberId: string | null
  guestId: string | null
  firstName: string
  lastName: string
  phone: string | null
  isMember: boolean
  /**
   * Male/Female where the linked Member or Guest states one. Spelled as the
   * string union rather than Prisma's `Gender` so this module stays importable
   * from a client component — the same reason {@link ClusterKindName} exists.
   */
  gender: ClusterGender
  checkedIn: boolean
  /**
   * When they arrived, for the day's reading of attendance — `attendedAt` on a
   * OneTime event, the scoped `OccurrenceAttendee` otherwise. Null whenever
   * `checkedIn` is false, and also for legacy rows that recorded no time.
   */
  checkedInAt: Date | null
  /** The cluster link names an explicit session for this row's event. */
  hasLinkedSession: boolean
  /** The cluster whose shared link this registration came through, if any. */
  registrationClusterId: string | null
  registeredAt: Date
  /**
   * This registration belongs to the cluster's day — see {@link isOnClusterDay}.
   *
   * Carried rather than filtered on. A registration that misses the day is still
   * a registration, and a roster that silently drops it renders the person as
   * "not registered" — which is a lie an admin can neither see through nor undo,
   * because the add-registrant screen correctly refuses to create the row twice.
   * Counts read this flag; the roster shows the row either way.
   */
  onClusterDay: boolean
}

/**
 * The day a cluster stands for. `date: null` means the cluster has no date.
 *
 * `kind` is part of the scope because the two shapes of day answer "is this
 * registration ours?" differently — see {@link isOnClusterDay}. Spelled as the
 * string union rather than imported as Prisma's `ClusterKind` value so this
 * module stays importable from a client component.
 */
export type ClusterDayScope = {
  clusterId: string
  date: Date | null
  kind: ClusterKindName
}

/** Prisma's `ClusterKind`, as a type only — see {@link ClusterDayScope}. */
export type ClusterKindName = "Parallel" | "Collab"

/** Prisma's `Gender`, as a type only — see {@link ClusterRegistrantRow.gender}. */
export type ClusterGender = "Male" | "Female" | null

/**
 * Does this registration belong to the cluster's day?
 *
 * A cluster is one day. A OneTime event's registrations are inherently that
 * day's, so they all count. A Recurring or MultiDay event is different: its
 * `EventRegistrant` is one row per person per *series*, so counting them all
 * would put every person who ever registered for the weekly service on every
 * day the service appears — a figure that also grows retroactively as new
 * people register months later.
 *
 * For those events the day's population is the people we have evidence for:
 * they checked in (a session-scoped fact — the linked session when the cluster
 * names one, the day's occurrence otherwise), or they signed up for this
 * specific day through its shared link (`registrationClusterId`), which is a
 * statement of intent for that day whenever it was made.
 *
 * A cluster with no date has no day to scope to, so everything counts — unless
 * the link names a session explicitly, which is a scope of its own regardless
 * of the cluster having a date.
 *
 * The third piece of evidence is the registration's own timestamp. Only the
 * cluster's shared form ever stamps `registrationClusterId`, so someone who
 * signed up on the day itself through an individual event's link had no way to
 * carry the stamp — and if they hadn't reached the kiosk yet, nothing spoke for
 * them at all. When they signed up is a fact we already hold, and a sign-up made
 * on the day is as much a statement of intent for it as one made through the day
 * link. Unlike counting the whole series it cannot grow later: the timestamp is
 * fixed, so a day's figures never move on their own.
 */
export function isOnClusterDay(
  row: Pick<
    ClusterRegistrantRow,
    | "eventType"
    | "checkedIn"
    | "registrationClusterId"
    | "hasLinkedSession"
    | "registeredAt"
  >,
  scope: ClusterDayScope | null
): boolean {
  // A Collab day owns its registrant list outright, so nothing is inherited: the
  // only registrations that count are the ones this day produced. Every "of
  // course it's ours" shortcut below is therefore skipped — a OneTime member
  // event's pre-existing sign-ups and a dateless cluster's whole series are
  // exactly the inheritance a collab is meant not to have. See
  // `belongsOnClusterList` for what the surfaces do with the answer.
  if (scope?.kind === "Collab") return hasDayEvidence(row, scope)
  if (row.eventType === "OneTime") return true
  if (!scope) return true
  if (!scope.date && !row.hasLinkedSession) return true
  return hasDayEvidence(row, scope)
}

/**
 * The three facts that positively tie a record to the day: it was made through
 * the day's own link, it recorded attendance for the day, or it was created on
 * the day itself.
 *
 * Attendance is already day-scoped by the caller (the linked session, or the
 * day's occurrence), so being checked in IS evidence of this day rather than of
 * the series.
 */
function hasDayEvidence(
  row: Pick<
    ClusterRegistrantRow,
    "checkedIn" | "registrationClusterId" | "registeredAt"
  >,
  scope: ClusterDayScope
): boolean {
  if (row.registrationClusterId === scope.clusterId) return true
  if (row.checkedIn) return true
  return scope.date ? registeredOnClusterDay(row.registeredAt, scope.date) : false
}

/**
 * The same question for a volunteer — and it only ever has the strict answer.
 *
 * None of the shortcuts `isOnClusterDay` allows a registration make sense for a
 * sign-up to serve. A `Volunteer` row is not a registration for a date: it says
 * a person serves this ministry's event, which on a long-running event is a
 * standing fact from months ago. Inheriting those would put every volunteer
 * either ministry has ever had on every day the event appears in — the exact
 * failure the day's registrant list was just fixed for, and on a Parallel day
 * too, where nothing else is day-scoped this way.
 *
 * So a volunteer is on the day when they signed up through the day's own
 * volunteer form, checked in for it, or signed up on the day itself. A null
 * scope names no day at all, so nothing can be attributed to one.
 */
export function volunteerIsOnClusterDay(
  row: Pick<
    ClusterRegistrantRow,
    "checkedIn" | "registrationClusterId" | "registeredAt"
  >,
  scope: ClusterDayScope | null
): boolean {
  return scope ? hasDayEvidence(row, scope) : false
}

/**
 * Should this registration appear on the cluster's surfaces at all?
 *
 * A **Parallel** day keeps every row and flags it: the person ticked that event,
 * so its registration is the thing they asked about, and a row that misses the
 * day is still theirs. Withholding it made the roster claim someone was not
 * registered while the add-registrant screen — reading the same row — refused to
 * add them again, so the flag exists to say "on the series" out loud.
 *
 * A **Collab** day drops it. The day is not a wrapper around each ministry's
 * registration; it owns one, and an admin tracking sign-ups for the day cannot
 * do that through a list pre-filled with both ministries' standing rosters. The
 * trap that made dropping wrong on a Parallel day doesn't exist here: on a
 * Collab, `clusterDayRegistrationDisposition` returns `reuse`, so the shared form
 * and the door both take an inherited row onto the day rather than short-
 * circuiting on it. Someone missing from the list can always be added.
 */
export function belongsOnClusterList(
  row: { onClusterDay: boolean },
  scope: ClusterDayScope | null
): boolean {
  return scope?.kind !== "Collab" || row.onClusterDay
}

/** Manila runs UTC+8 all year — no DST to track. */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * UTC day bounds for a cluster date. Cluster dates are stored as a bare day
 * (rendered with `timeZone: "UTC"` on the dashboard), so the window has to be
 * computed in UTC to match — a local-time window would slide by 8 hours here.
 */
export function utcDayRange(date: Date): { gte: Date; lt: Date } {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  )
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  return { gte: start, lt: end }
}

/**
 * The same day read in Manila time — the window {@link registeredOnClusterDay}
 * tests a registration's timestamp against, as bounds a query can use.
 */
export function manilaDayRange(date: Date): { gte: Date; lt: Date } {
  const start =
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
    MANILA_OFFSET_MS
  return { gte: new Date(start), lt: new Date(start + DAY_MS) }
}

/**
 * Did this registration happen on the cluster's day, read in Manila time?
 *
 * A cluster's date is stored as UTC midnight standing for a bare day, while
 * `registeredAt` is a true instant. Comparing the two in raw UTC would put the
 * window eight hours early and miss anyone who registered between midnight and
 * 8am Manila on the day itself — the same seam that makes a session dated with
 * today's Manila date sit a UTC day ahead until 08:00.
 */
export function registeredOnClusterDay(registeredAt: Date, date: Date): boolean {
  const { gte, lt } = manilaDayRange(date)
  const at = registeredAt.getTime()
  return at >= gte.getTime() && at < lt.getTime()
}

export type ClusterRosterCell = {
  /** The `EventRegistrant` id, or the `Volunteer` id when `kind` is Volunteer. */
  registrantId: string
  kind: ClusterParticipantKind
  checkedIn: boolean
  /** When they arrived on this event — see {@link ClusterRegistrantRow.checkedInAt}. */
  checkedInAt: Date | null
  /** The registration counts toward the cluster's day. */
  onClusterDay: boolean
}

/**
 * How a person stands on one of the day's events. Three states, because
 * "registered for the series but not evidenced here" is its own answer — it is
 * neither presence nor absence, and rendering it as either one misinforms.
 */
export type ClusterStanding = "CheckedIn" | "OnDay" | "SeriesOnly"

export function standingFor(cell: ClusterRosterCell): ClusterStanding {
  if (cell.checkedIn) return "CheckedIn"
  return cell.onClusterDay ? "OnDay" : "SeriesOnly"
}

/** Rank for collapsing duplicate registrations: arriving beats intending. */
const STANDING_RANK: Record<ClusterStanding, number> = {
  CheckedIn: 2,
  OnDay: 1,
  SeriesOnly: 0,
}

/** Serving outranks attending; within a kind, the stronger standing wins. */
function cellRank(cell: ClusterRosterCell): number {
  return (cell.kind === "Volunteer" ? 10 : 0) + STANDING_RANK[standingFor(cell)]
}

export type ClusterRosterPerson = {
  /** Stable identity: member:<id> | guest:<id> | registrant:<id> (anonymous). */
  key: string
  firstName: string
  lastName: string
  phone: string | null
  isMember: boolean
  /**
   * First stated gender across the person's records. They are one person, so
   * the answer cannot differ between their rows — but a walk-in row carries no
   * profile, and taking the first non-null is what keeps that row from erasing
   * an answer the Member record already holds.
   */
  gender: ClusterGender
  /** They are serving on at least one of the day's events. */
  isVolunteer: boolean
  perEvent: Record<string, ClusterRosterCell | undefined>
}

/**
 * How a person is described on the day. Volunteer wins over Member because it
 * says more: every volunteer is a member, so "Volunteer" loses no information,
 * while "Member" would hide the one fact that changes what they are doing here.
 */
export type ClusterPersonType = "Volunteer" | "Member" | "Guest"

export function personTypeFor(person: {
  isVolunteer: boolean
  isMember: boolean
}): ClusterPersonType {
  if (person.isVolunteer) return "Volunteer"
  return person.isMember ? "Member" : "Guest"
}

export type ClusterRoster = {
  rows: ClusterRosterPerson[]
  events: ClusterRosterEvent[]
}

export function personKeyFor(row: {
  id: string
  memberId: string | null
  guestId: string | null
}): string {
  if (row.memberId) return `member:${row.memberId}`
  if (row.guestId) return `guest:${row.guestId}`
  return `registrant:${row.id}`
}

/**
 * Collapse per-event registrant rows into one row per person. The same person
 * (same member or guest) registered for several of the day's events becomes a
 * single roster row with one cell per event.
 */
export function buildClusterRoster(
  events: ClusterRosterEvent[],
  rows: ClusterRegistrantRow[]
): ClusterRoster {
  const byPerson = new Map<string, ClusterRosterPerson>()

  for (const row of rows) {
    const key = personKeyFor(row)
    let person = byPerson.get(key)
    if (!person) {
      person = {
        key,
        firstName: row.firstName,
        lastName: row.lastName,
        phone: row.phone,
        isMember: row.isMember,
        gender: null,
        isVolunteer: false,
        perEvent: {},
      }
      byPerson.set(key, person)
    }
    if (row.kind === "Volunteer") person.isVolunteer = true
    person.gender ??= row.gender
    const cell: ClusterRosterCell = {
      registrantId: row.id,
      kind: row.kind,
      checkedIn: row.checkedIn,
      checkedInAt: row.checkedInAt,
      onClusterDay: row.onClusterDay,
    }
    // A person can hold two records on the SAME event — a duplicate sign-up, or
    // a registration alongside a sign-up to serve. Keep the one that says the
    // most: serving first (it is the canonical presence record, the same
    // precedence the check-in kiosk applies in `buildClusterCheckinPeople`), then
    // the strongest standing — the rule the CSV export folds by, so the surfaces
    // can't disagree about where someone stood.
    const held = person.perEvent[row.eventId]
    if (!held || cellRank(cell) > cellRank(held)) {
      person.perEvent[row.eventId] = cell
    }
  }

  const rosterRows = [...byPerson.values()].sort((a, b) => {
    const lastCmp = a.lastName.localeCompare(b.lastName, undefined, { sensitivity: "base" })
    if (lastCmp !== 0) return lastCmp
    return a.firstName.localeCompare(b.firstName, undefined, { sensitivity: "base" })
  })

  return { rows: rosterRows, events }
}
