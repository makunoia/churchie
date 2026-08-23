import "server-only"

import { db } from "@/lib/db"

/**
 * Shared check-in lookup machinery.
 *
 * Extracted out of `app/(dashboard)/events/actions.ts` so the cluster check-in
 * kiosk can find a person across a whole day's events without forking the
 * matcher. The single-event actions compose these same pieces in the same order
 * they always ran them, passing `[eventId]`; single-event behaviour is unchanged.
 *
 * Every lookup mode (mobile/email, full name, last name + birthday) loads the
 * same registrant/volunteer rows and matches them identically — only the filter
 * differs. Keeping one implementation is the point: the cluster kiosk and the
 * per-event kiosk must never disagree about who a query finds.
 */

// A check-in subject is either an event registrant or an event volunteer — never
// both. Volunteers are looked up via their linked Member and recorded with the
// same attendance machinery (OccurrenceAttendee for sessions, attendedAt for
// OneTime).
export type CheckinSubjectKind = "registrant" | "volunteer"
export type CheckinSubject = { kind: CheckinSubjectKind; id: string }

// Members are looked up as registrants and as volunteers, and both paths need the
// same profile columns to decide whether to raise the DGroup prompt.
export const MEMBER_LOOKUP_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  nickname: true,
  email: true,
  phone: true,
  birthMonth: true,
  birthYear: true,
  smallGroupId: true,
  // A member who named another satellite has already answered "are you in a
  // DGroup?" — the member-side twin of the guest's `claimedSatellite`, and read
  // for the same reason: don't ask them again at the kiosk.
  upwardSatellite: true,
  lifeStageId: true,
  gender: true,
  language: true,
  meetingPreference: true,
  workCity: true,
  ageRangeBucketId: true,
  schedulePreferences: {
    select: { dayOfWeek: true, timeStart: true, timeEnd: true },
    orderBy: { createdAt: "asc" as const },
    take: 1,
  },
  groupRequests: { select: { status: true, resolvedAt: true } },
} as const

/**
 * Every registrant row a lookup may match, across one or more events.
 *
 * Reads whole rosters and matches in JS. That is deliberate: phone and email
 * matching has fallback chains across the registrant row, its Member and its
 * Guest, and pushing that into SQL would mean a second matcher that can drift
 * from this one. A cluster is a handful of events, so the extra rosters are an
 * accepted cost — narrow the `select` before forking the matcher.
 */
export function findEventRegistrantsForLookup(eventIds: string[]) {
  return db.eventRegistrant.findMany({
    where: { eventId: { in: eventIds } },
    select: {
      id: true,
      eventId: true,
      firstName: true,
      lastName: true,
      nickname: true,
      email: true,
      mobileNumber: true,
      attendedAt: true,
      guestId: true,
      memberId: true,
      member: {
        select: MEMBER_LOOKUP_SELECT,
      },
      guest: {
        select: {
          firstName: true,
          lastName: true,
          nickname: true,
          email: true,
          phone: true,
          birthMonth: true,
          birthYear: true,
          lifeStageId: true,
          gender: true,
          language: true,
          meetingPreference: true,
          workCity: true,
          scheduleDayOfWeek: true,
          scheduleTimeStart: true,
          scheduleTimeEnd: true,
          ageRangeBucketId: true,
          claimedSmallGroupId: true,
          claimedSatellite: true,
          groupRequests: { select: { status: true, resolvedAt: true } },
        },
      },
    },
  })
}

export type RegistrantLookupRow = Awaited<
  ReturnType<typeof findEventRegistrantsForLookup>
>[number]

/** Volunteer check-in subjects for the same set of events. */
export function findEventVolunteersForLookup(eventIds: string[]) {
  return db.volunteer.findMany({
    where: { eventId: { in: eventIds } },
    select: {
      id: true,
      eventId: true,
      attendedAt: true,
      memberId: true,
      member: { select: MEMBER_LOOKUP_SELECT },
    },
  })
}

export type VolunteerLookupRow = Awaited<
  ReturnType<typeof findEventVolunteersForLookup>
>[number]

export function normalizeNameInput(v: string): string {
  return v.trim().replace(/\s+/g, " ").toLowerCase()
}

/** The display name a registrant row resolves to, profile first. */
export function registrantName(r: RegistrantLookupRow): {
  firstName: string
  lastName: string
} {
  return {
    firstName: r.member?.firstName ?? r.guest?.firstName ?? r.firstName ?? "",
    lastName: r.member?.lastName ?? r.guest?.lastName ?? r.lastName ?? "",
  }
}

/** The contact details a registrant row is matched on, profile first. */
export function registrantContact(r: RegistrantLookupRow): {
  email: string | null
  phone: string | null
} {
  return {
    email: r.member?.email ?? r.guest?.email ?? r.email ?? null,
    phone: r.member?.phone ?? r.guest?.phone ?? r.mobileNumber ?? null,
  }
}

/**
 * Exact contact match, the only mode the kiosk's mobile/email box offers.
 * Whitespace-insensitive on the phone side so a canonical `+63 917 123 4567`
 * matches whatever spacing was typed.
 */
export function matchesContactQuery(
  contact: { email: string | null; phone: string | null },
  query: string
): boolean {
  const lq = query.trim().toLowerCase()
  const qNorm = query.trim().replace(/\s+/g, "")
  if (!lq) return false
  return (
    (contact.email ?? "").toLowerCase() === lq ||
    (contact.phone ?? "").replace(/\s+/g, "") === qNorm
  )
}

/**
 * Every word must appear somewhere in the name or in a nickname, so "kuya jun
 * santos" still finds "Junior Santos" nicknamed "Kuya Jun".
 */
export function buildNameMatcher(
  query: string
): ((first: string, last: string, nicknames: (string | null)[]) => boolean) | null {
  const q = normalizeNameInput(query)
  if (!q || q.length < 2) return null
  const words = q.split(/\s+/).filter(Boolean)
  return (first, last, nicknames) => {
    const full = normalizeNameInput(`${first} ${last}`)
    const nicks = nicknames
      .filter((n): n is string => !!n)
      .map((n) => normalizeNameInput(n))
    return words.every((w) => full.includes(w) || nicks.some((n) => n.includes(w)))
  }
}

/**
 * One person can own several rows for the same event — two registrations from a
 * duplicate sign-up, or a volunteer who also registered. Keying on the underlying
 * Member/Guest collapses those into a single check-in subject; rows with no linked
 * profile fall back to name + contact.
 */
export function registrantIdentityKey(r: RegistrantLookupRow): string {
  if (r.memberId) return `member:${r.memberId}`
  if (r.guestId) return `guest:${r.guestId}`
  const name = normalizeNameInput(`${r.firstName ?? ""} ${r.lastName ?? ""}`)
  const contact = (r.mobileNumber ?? r.email ?? "").toLowerCase().replace(/\s+/g, "")
  return `anon:${name}|${contact}`
}

/**
 * Record attendance for either subject kind.
 *
 * `occurrenceId` non-null upserts an `OccurrenceAttendee` (session events);
 * null stamps `attendedAt` (OneTime), fill-if-null so the first arrival time
 * survives a second tap. Both branches are idempotent — the twin of
 * `checkInWalkInRegistrant` in `registration-core.ts`, widened to volunteers.
 */
export async function recordCheckinAttendance(
  subject: CheckinSubject,
  occurrenceId: string | null
): Promise<void> {
  if (occurrenceId !== null) {
    if (subject.kind === "volunteer") {
      await db.occurrenceAttendee.upsert({
        where: { occurrenceId_volunteerId: { occurrenceId, volunteerId: subject.id } },
        create: { occurrenceId, volunteerId: subject.id },
        update: {},
      })
    } else {
      await db.occurrenceAttendee.upsert({
        where: { occurrenceId_registrantId: { occurrenceId, registrantId: subject.id } },
        create: { occurrenceId, registrantId: subject.id },
        update: {},
      })
    }
    return
  }

  if (subject.kind === "volunteer") {
    await db.volunteer.updateMany({
      where: { id: subject.id, attendedAt: null },
      data: { attendedAt: new Date() },
    })
  } else {
    await db.eventRegistrant.updateMany({
      where: { id: subject.id, attendedAt: null },
      data: { attendedAt: new Date() },
    })
  }
}

/**
 * Undo an attendance record — the exact inverse of `recordCheckinAttendance`,
 * and here rather than beside its caller so the two lanes stay described in one
 * place. A check-in lives in one of two shapes depending on the event, and a
 * remover that knew only one of them would silently no-op on the other.
 *
 * `deleteMany` / `updateMany` rather than their single-row twins: if a second
 * admin cleared the same arrival first, the desired end state already holds, and
 * reporting a failure would only leave a stale row on this one's screen.
 */
export async function clearCheckinAttendance(
  subject: CheckinSubject,
  occurrenceId: string | null
): Promise<void> {
  if (occurrenceId !== null) {
    await db.occurrenceAttendee.deleteMany({
      where:
        subject.kind === "volunteer"
          ? { occurrenceId, volunteerId: subject.id }
          : { occurrenceId, registrantId: subject.id },
    })
    return
  }

  if (subject.kind === "volunteer") {
    await db.volunteer.updateMany({
      where: { id: subject.id },
      data: { attendedAt: null },
    })
  } else {
    await db.eventRegistrant.updateMany({
      where: { id: subject.id },
      data: { attendedAt: null },
    })
  }
}
