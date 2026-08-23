import "server-only"

import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { suggestBreakoutGroup } from "@/lib/breakout-suggestion"
import { fetchBreakoutCandidates } from "@/lib/breakout-suggestion-server"
import { breakoutOccupancy } from "@/lib/breakouts/occupancy"
import { isClusterOwner, type BreakoutSet } from "@/lib/breakouts/owner"
import { resolveSurfaceBreakoutOwner } from "@/lib/events/pool-scope"
import { tryCreateSmallGroupRequestFromBreakout } from "@/lib/create-small-group-request"
import { recordMemberGroupClaim } from "@/lib/small-groups/member-claim"
import { createSeekerRequestFromRegistration } from "@/lib/small-groups/seeker-requests"
import { buildStoredScheduleSlot } from "@/lib/matching/candidate-schedule"
import {
  ProfileCollisionError,
  shouldWriteProfileField,
  touchedFieldSet,
} from "@/lib/events/profile-merge"
import type { RegistrantData } from "@/lib/validations/event-registrant"
import type { Gender, MeetingFormat } from "@/app/generated/prisma/client"

/**
 * Registration core (CCF-132) — the person-resolution and per-event completion
 * steps of public registration, extracted out of `createRegistrant` so the
 * cluster shared form can resolve a person ONCE and then fan out one
 * `EventRegistrant` per selected event. `createRegistrant` composes these same
 * pieces in the same order it always ran them; single-event behavior is
 * unchanged.
 */

export type AssignedBreakout =
  | {
      id: string
      name: string
      meetingFormat: MeetingFormat | null
      locationCity: string | null
      schedule: { dayOfWeek: number; timeStart: string | null; timeEnd: string | null } | null
    }
  | null

export type PersonRef = { memberId: string } | { guestId: string; nickname?: string | null }

export type ResolvedProfile = {
  gender: Gender | null
  birthYear: number | null
  /**
   * Carried so automatic placement applies the same life-stage rule the picker
   * does. Without it the two disagreed about which tables suit a person: the
   * selection screen hid a table run for another life stage, and auto-assign —
   * which runs on the very same form when the picker is switched off — would
   * happily place them in it.
   */
  lifeStageId: string | null
}

async function fetchAssignedBreakoutDetails(groupId: string): Promise<AssignedBreakout> {
  const group = await db.breakoutGroup.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      name: true,
      meetingFormat: true,
      locationCity: true,
      schedules: {
        select: { dayOfWeek: true, timeStart: true, timeEnd: true },
        orderBy: { dayOfWeek: "asc" },
        take: 1,
      },
    },
  })
  if (!group) return null
  return {
    id: group.id,
    name: group.name,
    meetingFormat: group.meetingFormat,
    locationCity: group.locationCity,
    schedule: group.schedules[0] ?? null,
  }
}

/**
 * Assign a registrant to a breakout group based on:
 *  - explicit pick (selectedBreakoutGroupId) — wins if provided & valid; capacity
 *    blocks it unless `allowOverCapacity` is set, which the caller grants only to
 *    a signed-in staff member at the door. Their picker deliberately offers full
 *    groups, so dropping the pick here would silently contradict the UI. Every
 *    anonymous submission — including one to the public walk-in route — stays
 *    capacity-gated.
 *  - else autoAssignBreakout on the event — runs the same Gender/LifeStage/Age/
 *    Capacity matcher the selection screen ranks with, over the door's
 *    staffed-only pool when `atDoor` says this is a walk-in, and over every
 *    enabled group otherwise. Sharing the matcher is the point: auto-assign
 *    replaces the picker on a given form rather than sitting beside it, so the
 *    two disagreeing about which table suits someone would be a bug nobody sees.
 *  - else nothing
 * Best-effort: failures are swallowed and return null.
 *
 * Nothing is assigned unless the event has the Breakout module enabled (CCF-128).
 * The gate belongs here, at the write, not only at the surfaces that offer it:
 * `autoAssignBreakout` is a flat column that survives the module being switched
 * off, so without this an event could keep placing registrants into groups its
 * admin can no longer see.
 */
export async function assignBreakoutForRegistrant(
  registrantId: string,
  eventId: string,
  selectedBreakoutGroupId: string | null,
  /**
   * `lifeStageId` is optional so a caller that genuinely has no profile — a bare
   * test fixture, a path that never asked — can still pass one. Absent reads as
   * unknown, which never rules a group out.
   */
  profile: { gender: Gender | null; birthYear: number | null; lifeStageId?: string | null },
  allowOverCapacity = false,
  /**
   * Set when this placement is happening at the door, carrying the session the
   * walk-in is being checked into (null for OneTime). It makes automatic
   * placement obey the door's facilitator gate — see the auto-assign branch.
   *
   * Unlike `allowOverCapacity` this may be derived straight from the caller's
   * self-asserted `walkIn` flag, because it only ever makes placement *stricter*.
   * A forged claim narrows the candidate pool; it can't widen it.
   */
  atDoor: { occurrenceId: string | null } | null = null,
  /**
   * Leave someone unseated rather than placing them automatically, because a
   * later surface is going to ask them.
   *
   * Only ever suppresses the automatic branch — an explicit pick is a decision
   * already taken and is honoured regardless. The rule it serves is the one
   * `autoAssignBreakout` has always encoded: auto-assign *replaces* a picker
   * rather than sitting beside it. That held while the picker and the placement
   * lived on the same form, and stopped holding once a Collab day's kiosk could
   * ask about the day's tables (CCF-148): the shared form placed the person at
   * submit, so the kiosk found them seated and skipped its own step, and turning
   * the section on looked like it did nothing.
   *
   * Deliberately a caller's decision rather than a read this function makes for
   * itself. Which surface asks next is a property of the day being registered
   * for, not of the event row in front of us — and only the caller knows whether
   * there *is* a next surface: the walk-in door checks people in on the spot, so
   * nobody deferred there would ever be asked again.
   */
  skipAutoAssign = false,
  /**
   * Which set of tables this surface is filling — the event's own by default, the
   * day's when a cluster's shared form or kiosk is the one asking. See
   * `BreakoutSet`: an event on a Collab has two valid sets and only the surface
   * knows which one it means.
   */
  breakoutSet: BreakoutSet = "event"
): Promise<AssignedBreakout> {
  try {
    const event = await db.event.findUnique({
      where: { id: eventId },
      select: {
        autoAssignBreakout: true,
        modules: { where: { type: "Breakout" }, select: { id: true }, take: 1 },
      },
    })
    if (!event || event.modules.length === 0) return null

    // Which tables are in play. Both sets exist on a Collab day and the surface
    // picks; everywhere else `resolveSurfaceBreakoutOwner` returns the event's own
    // whatever is asked for.
    const owner = await resolveSurfaceBreakoutOwner(eventId, breakoutSet)

    // A registrant may already be placed. The reuse paths — a walk-in for someone
    // who registered earlier, and amend — run this function against a row that has
    // been through it before, and the bare `create` at the end was wrong both ways:
    // re-assigning to the same group violates the composite PK and threw into the
    // catch below, so the person's confirmation claimed no breakout at all; landing
    // on a different one left them sitting in two groups at once.
    //
    // Scoped to the owner rather than to the event: a person's standing placement
    // in their ministry's own group is not the placement this is asking about.
    //
    // Matched by PERSON, not by this registrant row. A duplicate sign-up gives
    // someone two rows on one event, and a row-scoped lookup reads the second as
    // unplaced — seating the same human at a second table. The row that holds the
    // seat is carried along because moving it means deleting by its own composite
    // key, which is not necessarily this registrant's.
    const registrant = await db.eventRegistrant.findUnique({
      where: { id: registrantId },
      select: { memberId: true, guestId: true },
    })
    const personFilter = registrant?.memberId
      ? { memberId: registrant.memberId }
      : registrant?.guestId
        ? { guestId: registrant.guestId }
        : null
    const current = await db.breakoutGroupMember.findFirst({
      where: {
        breakoutGroup: owner,
        // Guard both-null before branching: an anonymous registrant has neither
        // FK, and `{ memberId: null }` would match every other anonymous row.
        ...(personFilter ? { registrant: personFilter } : { registrantId }),
      },
      select: { breakoutGroupId: true, registrantId: true },
    })

    // Auto-assign never overrides an existing placement: nobody asked to be moved,
    // and an admin may have placed them by hand since. Report where they already
    // are rather than re-running the matcher.
    if (current && !selectedBreakoutGroupId) {
      return fetchAssignedBreakoutDetails(current.breakoutGroupId)
    }

    let chosenGroupId: string | null = null

    if (selectedBreakoutGroupId) {
      const picked = await db.breakoutGroup.findUnique({
        where: { id: selectedBreakoutGroupId },
        select: {
          id: true,
          eventId: true,
          clusterId: true,
          isEnabled: true,
          memberLimit: true,
          _count: { select: { members: true } },
        },
      })
      const pickedIsFull =
        !!picked &&
        breakoutOccupancy({
          memberCount: picked._count.members,
          memberLimit: picked.memberLimit,
        }).isFull
      // `isEnabled` is re-checked here and not only where the picker was built:
      // this id arrives in a submitted payload, so a form rendered before the
      // group was switched off — or one edited by hand — must not land anyone in
      // it. Unlike capacity there is no `allowOverCapacity` counterpart; a
      // switched-off group is closed to every public route, and admins place
      // people from the group's own screen instead.
      //
      // "Belongs to the surface that offered it" is an owner comparison rather
      // than an event-id one — a collab form offers cluster-owned tables, whose
      // `eventId` is null.
      const pickedIsInPlay = isClusterOwner(owner)
        ? picked?.clusterId === owner.clusterId
        : picked?.eventId === owner.eventId
      if (
        picked &&
        pickedIsInPlay &&
        picked.isEnabled &&
        (allowOverCapacity || !pickedIsFull)
      ) {
        chosenGroupId = picked.id
      }
    } else if (event.autoAssignBreakout && !skipAutoAssign) {
      // Auto-assign stays capacity-gated regardless: nobody chose this group, so
      // there is no intent to honour.
      //
      // The same reasoning puts the door's facilitator gate here. The walk-in
      // picker only ever offers groups whose facilitator is in the room, but
      // auto-assign ignored that and placed people into unstaffed groups from
      // the very same form — so the rule held only where a human was choosing,
      // which is backwards. And because `autoAssignBreakout` also *suppresses*
      // the picker (`offerBreakoutPicker` on the walk-in page), an event with it
      // switched on had no gated path at all.
      const candidates = atDoor
        ? await fetchBreakoutCandidates(eventId, atDoor.occurrenceId, true, breakoutSet)
        : await fetchBreakoutCandidates(eventId, null, false, breakoutSet)
      const best = suggestBreakoutGroup(candidates, {
        gender: profile.gender,
        birthYear: profile.birthYear,
        lifeStageId: profile.lifeStageId ?? null,
      })
      if (best) chosenGroupId = best.id
    }

    // A pick that was refused (full, disabled, another day's) leaves nothing
    // chosen — but someone already placed is still placed, and saying "no group"
    // to a person sitting in one would be a lie the confirmation screen tells.
    if (!chosenGroupId) {
      return current ? fetchAssignedBreakoutDetails(current.breakoutGroupId) : null
    }

    // Picking the group they're already in is a no-op, not a second insert.
    if (current?.breakoutGroupId === chosenGroupId) {
      return fetchAssignedBreakoutDetails(chosenGroupId)
    }

    // Picking a different one is a *move*, and it has to be one statement.
    // Dropping the old membership first is what keeps one registrant in one
    // breakout group, but split across two calls a failed insert would leave
    // them in none — silently, since the catch below turns any throw into a
    // null the confirmation screen reads as "no breakout". That is a worse
    // outcome than the double-placement this guard was written to prevent.
    await db.$transaction(async (tx) => {
      if (current) {
        await tx.breakoutGroupMember.delete({
          where: {
            breakoutGroupId_registrantId: {
              breakoutGroupId: current.breakoutGroupId,
              // The seat's own row, which under a duplicate sign-up may be a
              // different registrant of the same person.
              registrantId: current.registrantId,
            },
          },
        })
      }
      await tx.breakoutGroupMember.create({
        data: { breakoutGroupId: chosenGroupId, registrantId },
      })
    })
    await tryCreateSmallGroupRequestFromBreakout(chosenGroupId, registrantId)
    revalidatePath(`/event/${eventId}/breakouts`)
    return fetchAssignedBreakoutDetails(chosenGroupId)
  } catch {
    return null
  }
}

// Walk-in mode: check the registrant in immediately after registration.
// Sessions (MultiDay/Recurring) record an OccurrenceAttendee; OneTime events
// set attendedAt — only when null, preserving the first check-in time.
//
// The session id arrives in a submitted payload from a *public* route, so it is
// re-scoped to the registrant's own event before anything is written. The page
// only ever renders the id `resolveWalkInSession` chose, so this changes nothing
// for real traffic; what it stops is a hand-edited POST recording attendance at
// another event's session, which would quietly inflate that event's numbers on
// every surface that counts occurrence attendance. Silent rather than an error:
// the registration itself succeeded, and there is no one at the door to act on
// a failure about an id they never saw.
export async function checkInWalkInRegistrant(registrantId: string, occurrenceId: string | null) {
  if (occurrenceId !== null) {
    const occurrence = await db.eventOccurrence.findFirst({
      where: { id: occurrenceId, event: { registrants: { some: { id: registrantId } } } },
      select: { id: true },
    })
    if (!occurrence) return

    await db.occurrenceAttendee.upsert({
      where: { occurrenceId_registrantId: { occurrenceId, registrantId } },
      create: { occurrenceId, registrantId },
      update: {},
    })
  } else {
    await db.eventRegistrant.updateMany({
      where: { id: registrantId, attendedAt: null },
      data: { attendedAt: new Date() },
    })
  }
}

/**
 * The member's volunteer record for this event, if they are serving at it.
 *
 * Returns the row rather than a yes/no because a caller that turns a
 * registration away has to be able to act on the record it turned it away for —
 * see `stampVolunteerClusterProvenance`.
 */
export async function findEventVolunteerRecord(
  eventId: string,
  memberId: string
): Promise<{ id: string } | null> {
  return db.volunteer.findFirst({
    where: { memberId, eventId },
    select: { id: true },
  })
}

/** True when the member is serving as a volunteer at this event (volunteers don't register as attendees). */
export async function findEventVolunteerConflict(
  eventId: string,
  memberId: string
): Promise<boolean> {
  return (await findEventVolunteerRecord(eventId, memberId)) !== null
}

/**
 * Existing registration for this person at this event, with the cluster day it
 * was made for.
 *
 * The provenance column is part of the answer rather than a second lookup
 * because "is this person registered?" and "is this person registered *for this
 * day*?" are different questions, and a cluster has to ask the second one. An
 * `EventRegistrant` is one row per person per event **series**, so a weekly
 * event's regular holds a row that predates any given day — see
 * `clusterDayRegistrationDisposition`.
 */
export async function findExistingEventRegistrationRow(
  eventId: string,
  person: PersonRef
): Promise<{ id: string; registrationClusterId: string | null } | null> {
  return db.eventRegistrant.findFirst({
    where:
      "memberId" in person
        ? { eventId, memberId: person.memberId }
        : { eventId, guestId: person.guestId },
    select: { id: true, registrationClusterId: true },
  })
}

/** Existing registration for this person at this event, if any. */
export async function findExistingEventRegistration(
  eventId: string,
  person: PersonRef
): Promise<string | null> {
  const existing = await findExistingEventRegistrationRow(eventId, person)
  return existing?.id ?? null
}

/**
 * Record that a registration belongs to a cluster's day.
 *
 * The day roll-up counts a session event's registration only on evidence — the
 * person checked in, or they signed up through this day's link — because a
 * `EventRegistrant` on a Recurring event covers the whole series, not one date.
 * This column is that second piece of evidence, so anything that puts a person
 * through a cluster's shared form has to leave it behind, including the paths
 * that reuse a registration the person already had.
 *
 * Fills a null rather than overwriting, so the day a registration was first made
 * for stands. `EventClusterEvent.eventId` is unique — an event belongs to at
 * most one cluster — so no second day ever competes for the column; the guard is
 * about not rewriting history. Conditional update rather than read-then-write.
 */
export async function stampClusterProvenance(
  registrantId: string,
  clusterId: string
): Promise<void> {
  await db.eventRegistrant.updateMany({
    where: { id: registrantId, registrationClusterId: null },
    data: { registrationClusterId: clusterId },
  })
}

/**
 * The same record for a volunteer, written when the day's shared form turns a
 * registration away because the person is serving.
 *
 * Somebody serving is one of the day's people, and the registration form already
 * tells them so ("You're serving as a volunteer — already included"). But a
 * `Volunteer` row is a standing fact about a ministry's event rather than a
 * registration for a date, so `volunteerIsOnClusterDay` puts one on the day only
 * on the day's own evidence — this stamp, a check-in, or a sign-up made on the
 * day itself. A ministry regular who joined the serving team weeks ago has none
 * of those, so without this write the shared form's reassurance was false: they
 * were dropped from the day's roster, registrants screen, check-in board and
 * export, and the admin had no way to see they had come through the form.
 *
 * This is the volunteer half of {@link stampClusterProvenance}, and it exists
 * for the same reason the registrant half runs on the `already` branch: the
 * short-circuit is about not creating a duplicate record, never about ignoring
 * what the person just told us.
 *
 * Fills a null rather than overwriting, matching the registrant rule. An event
 * belongs to at most one cluster (`EventClusterEvent.eventId` is unique), so no
 * second day competes for the column.
 */
export async function stampVolunteerClusterProvenance(
  volunteerId: string,
  clusterId: string
): Promise<void> {
  await db.volunteer.updateMany({
    where: { id: volunteerId, signUpClusterId: null },
    data: { signUpClusterId: clusterId },
  })
}

/**
 * Fields the person edited on the review screen, named the way the payload names
 * them (CCF-147). A named field overwrites what is stored; everything else keeps
 * the fill-if-empty rule — see `lib/events/profile-merge.ts`.
 *
 * This arrives from a public client, so a crafted POST could claim every field is
 * touched. What gates it is the identity grant (`lib/security/identity-grant.ts`):
 * the callers null this out unless the request carries proof that it owns the
 * record being written to. Claiming everything is touched is then equivalent to a
 * verified owner editing every field, which is a thing they are allowed to do.
 *
 * This comment used to credit the second factor on the confirm card directly, and
 * that was wrong — `confirmedMemberId` reached this code as an unverified string,
 * and the mid-form confirm path never asked for a second factor at all. The grant
 * is what makes the sentence above true rather than aspirational.
 */
export type TouchedFields = readonly string[] | null | undefined

/**
 * Refuse to hand a mobile or email to a second record.
 *
 * Scoped to the *same model* deliberately. A Member and an active Guest sharing
 * a number is an ordinary duplicate-person situation the lookup already resolves
 * by preferring the Member, and blocking on it would reject legitimate
 * registrations. Two Members — or two active Guests — sharing one is the case
 * that makes the ladder permanently ambiguous, and that is what this stops.
 */
async function assertNoContactCollision(opts: {
  model: "member" | "guest"
  selfId: string
  phone?: string | null
  email?: string | null
}): Promise<void> {
  const { model, selfId, phone, email } = opts
  if (phone) {
    const clash =
      model === "member"
        ? await db.member.findFirst({ where: { phone, id: { not: selfId } }, select: { id: true } })
        : await db.guest.findFirst({
            where: { phone, memberId: null, id: { not: selfId } },
            select: { id: true },
          })
    if (clash) {
      throw new ProfileCollisionError(
        "That mobile number already belongs to another profile. Please check it, or leave it as it was."
      )
    }
  }
  if (email) {
    const clash =
      model === "member"
        ? await db.member.findFirst({ where: { email, id: { not: selfId } }, select: { id: true } })
        : await db.guest.findFirst({
            where: { email, memberId: null, id: { not: selfId } },
            select: { id: true },
          })
    if (clash) {
      throw new ProfileCollisionError(
        "That email address already belongs to another profile. Please check it, or leave it as it was."
      )
    }
  }
}

/**
 * Confirmed member: fill in only profile fields that are currently null — unless
 * the person edited one on the review screen, which overwrites — then return the
 * stored gender/birth year (the form's answer wins over the stored one for
 * breakout matching, combined by the caller).
 */
export async function resolveConfirmedMember(
  memberId: string,
  data: RegistrantData,
  touchedFields?: TouchedFields
): Promise<ResolvedProfile> {
  const existing = await db.member.findUniqueOrThrow({
    where: { id: memberId },
    select: {
      nickname: true,
      email: true, phone: true, birthMonth: true, birthYear: true,
      lifeStageId: true, gender: true, language: true, meetingPreference: true, workCity: true,
      ageRangeBucketId: true,
      // A member's availability lives in a relation, not a scalar column —
      // needed to know whether the registration form's Schedule answer is
      // new information or would be overwriting what they already told us.
      schedulePreferences: { select: { id: true }, take: 1 },
    },
  })
  const touched = touchedFieldSet(touchedFields)
  const memberUpdates: Record<string, unknown> = {}
  /** `stored` is the column, `field` is the payload key `touchedFields` speaks in. */
  const put = (column: string, stored: unknown, field: string, incoming: unknown) => {
    if (shouldWriteProfileField(stored, incoming, touched, field)) memberUpdates[column] = incoming
  }

  // Only the anonymous-guest branch carries a nickname onto `EventRegistrant`, so
  // without this the answer was collected and dropped for anyone who confirmed as
  // an existing member. Fill-if-empty like every other field here: a nickname
  // already on file is the one they chose, and a one-off spelling typed at
  // registration shouldn't overwrite it.
  put("nickname", existing.nickname, "nickname", data.nickname)
  put("email", existing.email, "email", data.email)
  put("phone", existing.phone, "mobileNumber", data.mobileNumber)
  put("birthMonth", existing.birthMonth, "birthMonth", data.birthMonth)
  put("birthYear", existing.birthYear, "birthYear", data.birthYear)
  put("lifeStageId", existing.lifeStageId, "lifeStageId", data.lifeStageId)
  put("gender", existing.gender, "gender", data.gender)
  put("language", existing.language, "language", data.language)
  put("meetingPreference", existing.meetingPreference, "meetingPreference", data.meetingPreference)
  put("workCity", existing.workCity, "workCity", data.workCity)
  put("ageRangeBucketId", existing.ageRangeBucketId, "ageRangeBucketId", data.ageRangeBucketId)

  // Only a *changed* identifier can collide — leaving the value alone can't
  // introduce a duplicate that wasn't already there.
  await assertNoContactCollision({
    model: "member",
    selfId: memberId,
    phone: memberUpdates.phone as string | undefined,
    email: memberUpdates.email as string | undefined,
  })

  // Schedule is a `SchedulePreference` relation for members (guests keep it in
  // scalar columns). Without this the form's Schedule field was collected and
  // then thrown away for anyone who confirmed as a member.
  // Times are optional — a day-only answer ("Tuesdays, any time") is still a
  // real preference, so it is normalised into a whole-day slot rather than
  // dropped.
  const hasStoredSchedule = existing.schedulePreferences.length > 0
  const scheduleEdited = touched.has("scheduleDayOfWeek")
  if ((!hasStoredSchedule || scheduleEdited) && data.scheduleDayOfWeek != null) {
    const slot = buildStoredScheduleSlot(
      data.scheduleDayOfWeek,
      data.scheduleTimeStart,
      data.scheduleTimeEnd
    )
    if (slot) {
      memberUpdates.schedulePreferences = {
        // Editing availability *replaces* it rather than adding a second slot:
        // the form collects one window, so leaving the old one behind would have
        // the member claiming two conflicting availabilities with no way to tell
        // which they meant. Only reached when they actually edited the field.
        ...(hasStoredSchedule ? { deleteMany: {} } : {}),
        create: {
          dayOfWeek: slot.dayOfWeek,
          timeStart: slot.timeStart,
          timeEnd: slot.timeEnd,
        },
      }
    }
  }

  if (Object.keys(memberUpdates).length > 0) {
    await db.member.update({ where: { id: memberId }, data: memberUpdates })
  }

  // "I'm already part of a DGroup". The guest resolver below writes this to two
  // scratch columns; a member has neither, so the answer used to be collected
  // and silently dropped — for the one group of people most likely to already
  // have a leader. It now lands where the member portal puts the same answer: a
  // named leader becomes a *Pending* request (membership stays admin-owned), a
  // named satellite becomes `upwardSatellite`. Never throws; a registration must
  // not fail over follow-up bookkeeping.
  //
  // Not guarded by `touched`, unlike the fill-if-empty fields above: this is a
  // question the form asks outright, and `recordMemberGroupClaim` already
  // no-ops when the member is placed or has an open request.
  if (data.claimedSmallGroupId) {
    await recordMemberGroupClaim(
      memberId,
      { scope: "group", smallGroupId: data.claimedSmallGroupId },
      "event registration"
    )
  } else if (data.claimedSatellite) {
    await recordMemberGroupClaim(
      memberId,
      { scope: "satellite", satellite: data.claimedSatellite },
      "event registration"
    )
  }

  return {
    gender: existing.gender,
    birthYear: existing.birthYear,
    lifeStageId: existing.lifeStageId,
  }
}

/**
 * Confirmed guest: fill in only profile fields that are currently null — unless
 * the person edited one on the review screen; returns stored gender/birth year.
 */
export async function resolveConfirmedGuest(
  guestId: string,
  data: RegistrantData,
  touchedFields?: TouchedFields
): Promise<ResolvedProfile> {
  const existing = await db.guest.findUniqueOrThrow({
    where: { id: guestId },
    select: {
      nickname: true,
      email: true, phone: true, birthMonth: true, birthYear: true,
      lifeStageId: true, gender: true, language: true, meetingPreference: true, workCity: true,
      ageRangeBucketId: true,
      scheduleDayOfWeek: true, scheduleTimeStart: true, scheduleTimeEnd: true,
      claimedSmallGroupId: true, claimedSatellite: true,
    },
  })
  const touched = touchedFieldSet(touchedFields)
  const guestUpdates: Record<string, unknown> = {}
  const put = (column: string, stored: unknown, field: string, incoming: unknown) => {
    if (shouldWriteProfileField(stored, incoming, touched, field)) guestUpdates[column] = incoming
  }

  // Same fill-if-empty rule as the member path — see `resolveConfirmedMember`.
  put("nickname", existing.nickname, "nickname", data.nickname)
  put("email", existing.email, "email", data.email)
  put("phone", existing.phone, "mobileNumber", data.mobileNumber)
  put("birthMonth", existing.birthMonth, "birthMonth", data.birthMonth)
  put("birthYear", existing.birthYear, "birthYear", data.birthYear)
  put("lifeStageId", existing.lifeStageId, "lifeStageId", data.lifeStageId)
  put("gender", existing.gender, "gender", data.gender)
  put("language", existing.language, "language", data.language)
  put("meetingPreference", existing.meetingPreference, "meetingPreference", data.meetingPreference)
  put("workCity", existing.workCity, "workCity", data.workCity)
  put("ageRangeBucketId", existing.ageRangeBucketId, "ageRangeBucketId", data.ageRangeBucketId)
  put("scheduleDayOfWeek", existing.scheduleDayOfWeek, "scheduleDayOfWeek", data.scheduleDayOfWeek)
  if (touched.has("scheduleDayOfWeek") && "scheduleDayOfWeek" in guestUpdates) {
    // The window belongs to the day, so an edited day carries its times with it —
    // including empty ones. This is the one place a submission may clear a stored
    // value: leaving yesterday's 19:00–21:00 attached to a newly-chosen Saturday
    // would describe a slot the person never picked, which is worse than losing
    // it. The member path does the same thing by replacing the relation row.
    guestUpdates.scheduleTimeStart = data.scheduleTimeStart ?? null
    guestUpdates.scheduleTimeEnd = data.scheduleTimeEnd ?? null
  } else {
    put("scheduleTimeStart", existing.scheduleTimeStart, "scheduleTimeStart", data.scheduleTimeStart)
    put("scheduleTimeEnd", existing.scheduleTimeEnd, "scheduleTimeEnd", data.scheduleTimeEnd)
  }
  // Either side counts as "already answered" — filling one while the other is
  // set would leave the guest claiming two different DGroups. An edit on the
  // review screen is allowed past that guard, and clears its opposite so the
  // pair can never both be set.
  const claimsNoGroup = !existing.claimedSmallGroupId && !existing.claimedSatellite
  const claimEdited = touched.has("claimedSmallGroupId") || touched.has("claimedSatellite")
  if ((claimsNoGroup || claimEdited) && data.claimedSmallGroupId) {
    guestUpdates.claimedSmallGroupId = data.claimedSmallGroupId
    guestUpdates.claimedSatellite = null
  }
  if ((claimsNoGroup || claimEdited) && data.claimedSatellite) {
    guestUpdates.claimedSatellite = data.claimedSatellite
    guestUpdates.claimedSmallGroupId = null
  }

  await assertNoContactCollision({
    model: "guest",
    selfId: guestId,
    phone: guestUpdates.phone as string | undefined,
    email: guestUpdates.email as string | undefined,
  })

  if (Object.keys(guestUpdates).length > 0) {
    await db.guest.update({ where: { id: guestId }, data: guestUpdates })
  }
  return {
    gender: existing.gender,
    birthYear: existing.birthYear,
    lifeStageId: existing.lifeStageId,
  }
}

/**
 * Anonymous registrant: dedup against existing guests (phone → email →
 * last name + birthday), updating the matched guest's matching profile, or
 * create a fresh Guest. Skips the dedup ladder entirely when the person
 * explicitly said "That's not me" to a guest match.
 *
 * The nickname is written to the `Guest` as well as to `EventRegistrant`. It used
 * to live only on the registrant row, so a guest who gave a nickname still showed
 * a blank one in the Guests module and couldn't be found by it at their next
 * event — the per-event value is an override, not the only place it belongs.
 *
 * Returns the matched guest's stored profile alongside the id, symmetric with
 * `resolveConfirmedMember` / `resolveConfirmedGuest` — the caller combines it
 * form-first the same way. Without it the dedup ladder's whole point was thrown
 * away for matching: landing on a guest who has a gender on file and then
 * placing them as though we had never met is what sent a known man to the
 * ungendered tables, and it happened whether or not the form asked.
 */
export async function resolveAnonymousGuest(
  data: RegistrantData,
  skipDeduplication?: boolean
): Promise<{ guestId: string } & ResolvedProfile> {
  const matchingProfile = {
    lifeStageId: data.lifeStageId ?? null,
    gender: data.gender ?? null,
    language: data.language?.length ? data.language : undefined,
    meetingPreference: data.meetingPreference ?? null,
    workCity: data.workCity ?? null,
    ageRangeBucketId: data.ageRangeBucketId ?? null,
    scheduleDayOfWeek: data.scheduleDayOfWeek ?? null,
    scheduleTimeStart: data.scheduleTimeStart ?? null,
    scheduleTimeEnd: data.scheduleTimeEnd ?? null,
    claimedSmallGroupId: data.claimedSmallGroupId ?? null,
    claimedSatellite: data.claimedSatellite ?? null,
  }

  // Nickname rides along so the update below can fill it only when empty; the
  // three matching fields ride along because a matched guest's stored profile is
  // half of what this function returns.
  const guestSelect = {
    id: true,
    nickname: true,
    gender: true,
    birthYear: true,
    lifeStageId: true,
  } as const
  let existingGuest: {
    id: string
    nickname: string | null
    gender: Gender | null
    birthYear: number | null
    lifeStageId: string | null
  } | null = null
  if (!skipDeduplication) {
    if (data.mobileNumber) {
      existingGuest = await db.guest.findFirst({
        where: { phone: data.mobileNumber },
        select: guestSelect,
      })
    }
    if (!existingGuest && data.email) {
      existingGuest = await db.guest.findFirst({
        where: { email: data.email },
        select: guestSelect,
      })
    }
    if (
      !existingGuest &&
      data.lastName &&
      data.birthMonth != null &&
      data.birthYear != null
    ) {
      existingGuest = await db.guest.findFirst({
        where: {
          lastName: { equals: data.lastName.trim(), mode: "insensitive" },
          birthMonth: data.birthMonth,
          birthYear: data.birthYear,
        },
        select: guestSelect,
      })
    }
  }

  if (existingGuest) {
    // Update matching profile with any newly provided data
    await db.guest.update({
      where: { id: existingGuest.id },
      data: {
        // Fill-if-empty rather than overwrite-if-provided like its neighbours
        // here: a nickname already on file is what this person is known as (an
        // admin may well have curated it), so a spelling typed at a registration
        // desk must not replace it. Same rule as the confirmed-member/guest
        // resolvers, which keeps one nickname rule across every write path.
        ...(!existingGuest.nickname && data.nickname && { nickname: data.nickname }),
        ...(data.birthMonth != null && { birthMonth: data.birthMonth }),
        ...(data.birthYear != null && { birthYear: data.birthYear }),
        ...(matchingProfile.lifeStageId !== null && { lifeStageId: matchingProfile.lifeStageId }),
        ...(matchingProfile.gender !== null && { gender: matchingProfile.gender }),
        ...(matchingProfile.language !== undefined && { language: matchingProfile.language }),
        ...(matchingProfile.meetingPreference !== null && { meetingPreference: matchingProfile.meetingPreference }),
        ...(matchingProfile.workCity !== null && { workCity: matchingProfile.workCity }),
        ...(matchingProfile.ageRangeBucketId !== null && { ageRangeBucketId: matchingProfile.ageRangeBucketId }),
        ...(matchingProfile.scheduleDayOfWeek !== null && {
          scheduleDayOfWeek: matchingProfile.scheduleDayOfWeek,
          scheduleTimeStart: matchingProfile.scheduleTimeStart,
          scheduleTimeEnd: matchingProfile.scheduleTimeEnd,
        }),
        ...(matchingProfile.claimedSmallGroupId !== null && {
          claimedSmallGroupId: matchingProfile.claimedSmallGroupId,
          claimedSatellite: null,
        }),
        ...(matchingProfile.claimedSatellite !== null && {
          claimedSatellite: matchingProfile.claimedSatellite,
          claimedSmallGroupId: null,
        }),
      },
    })
    // The stored values, not the merged ones — the caller applies the same
    // form-answer-wins rule it applies to the two confirmed branches.
    return {
      guestId: existingGuest.id,
      gender: existingGuest.gender,
      birthYear: existingGuest.birthYear,
      lifeStageId: existingGuest.lifeStageId,
    }
  }

  const newGuest = await db.guest.create({
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      // The answer also lands on `EventRegistrant.nickname` as the per-event
      // value, which the read paths prefer. Storing it here too is what makes the
      // person findable by nickname outside this one event — in the Guests module,
      // and at check-in for every later event they attend.
      nickname: data.nickname ?? null,
      email: data.email ?? null,
      phone: data.mobileNumber,
      birthMonth: data.birthMonth ?? null,
      birthYear: data.birthYear ?? null,
      language: matchingProfile.language ?? [],
      lifeStageId: matchingProfile.lifeStageId,
      gender: matchingProfile.gender,
      meetingPreference: matchingProfile.meetingPreference,
      workCity: matchingProfile.workCity,
      ageRangeBucketId: matchingProfile.ageRangeBucketId,
      scheduleDayOfWeek: matchingProfile.scheduleDayOfWeek,
      scheduleTimeStart: matchingProfile.scheduleTimeStart,
      scheduleTimeEnd: matchingProfile.scheduleTimeEnd,
      claimedSmallGroupId: matchingProfile.claimedSmallGroupId,
      claimedSatellite: matchingProfile.claimedSatellite,
    },
    select: { id: true },
  })
  // Nothing was on file, so the profile is exactly what was just written.
  return {
    guestId: newGuest.id,
    gender: matchingProfile.gender,
    birthYear: data.birthYear ?? null,
    lifeStageId: matchingProfile.lifeStageId,
  }
}

/**
 * The three answers that live on `EventRegistrant` rather than on the person.
 *
 * The create branch writes them inline; this is the reuse branch's missing
 * counterpart. Without it every answer to Dietary or Payment Reference was
 * collected and then dropped for anyone who already had a registration —
 * `existingRegistrantId` adopted the row and never touched these columns, so a
 * walk-in for someone who registered earlier silently discarded what they typed.
 *
 * Same fill-if-empty-unless-touched rule as the profile writers, through the same
 * `shouldWriteProfileField`, so a returning answer can't clobber a stored one and
 * there is no second merge rule to drift from the first. The column names and the
 * payload keys coincide for all three, so one string serves as both.
 */
async function mergeRegistrantAnswers(
  registrantId: string,
  data: RegistrantData,
  touchedFields?: TouchedFields
): Promise<void> {
  const existing = await db.eventRegistrant.findUnique({
    where: { id: registrantId },
    select: { dietaryPreference: true, dietaryOther: true, paymentReference: true },
  })
  if (!existing) return

  const touched = touchedFieldSet(touchedFields)
  const updates: Record<string, unknown> = {}
  const put = (field: "dietaryPreference" | "dietaryOther" | "paymentReference", incoming: unknown) => {
    if (shouldWriteProfileField(existing[field], incoming, touched, field)) updates[field] = incoming
  }

  put("dietaryPreference", data.dietaryPreference ?? null)
  put("dietaryOther", data.dietaryOther)
  put("paymentReference", data.paymentReference)

  if (Object.keys(updates).length > 0) {
    await db.eventRegistrant.update({ where: { id: registrantId }, data: updates })
  }
}

/**
 * Final per-event step: create the `EventRegistrant` row (or reuse the existing
 * one — walk-in semantics), run breakout assignment, and perform walk-in /
 * open-recurring-session check-in.
 */
export async function completeEventRegistration(opts: {
  eventId: string
  person: PersonRef
  data: RegistrantData
  /** Explicit breakout pick already resolved against the caller's form config; null = auto-assign path. */
  breakoutPick: string | null
  /** Combined form-first profile (form answer wins over the stored one) for breakout matching. */
  profile: ResolvedProfile
  /** Provenance when the registration came in through a cluster's shared form. */
  clusterId?: string | null
  walkIn?: { occurrenceId: string | null } | null
  /**
   * Whether an explicit breakout pick may exceed the group's member limit.
   *
   * Decided by the caller from the *session*, not from `walkIn`. The walk-in
   * route is public, so "this is a walk-in" is a claim the request makes about
   * itself and cannot buy a capacity override on its own.
   */
  allowOverCapacity?: boolean
  /** Existing registration to reuse instead of creating (walk-in / cluster reuse semantics). */
  existingRegistrantId?: string | null
  /**
   * Fields the person edited, in payload vocabulary — the same set the profile
   * resolvers take. Only consulted on the reuse path, where there is a stored
   * answer an edit could be overwriting; a freshly created row has nothing to
   * protect.
   */
  touchedFields?: TouchedFields
  /**
   * Register without placing the person automatically, because the surface they
   * meet next is going to ask them — see `assignBreakoutForRegistrant`. An
   * explicit `breakoutPick` still lands.
   */
  skipAutoAssign?: boolean
  /**
   * Which set of tables the surface that collected this registration fills. A
   * cluster's shared form passes `"cluster"`; every per-event form leaves it.
   */
  breakoutSet?: BreakoutSet
}): Promise<{ id: string; breakoutGroup: AssignedBreakout }> {
  const { eventId, person, data, breakoutPick, profile, clusterId, walkIn, allowOverCapacity, existingRegistrantId, touchedFields, skipAutoAssign, breakoutSet } = opts

  let registrantId: string
  if (existingRegistrantId) {
    registrantId = existingRegistrantId
    // Provenance on the reuse path. Someone already registered who comes back
    // through the cluster's shared link still arrived through that link, and the
    // day roll-up counts people by this column — without the stamp, every
    // returning walk-in was invisible to it.
    if (clusterId) await stampClusterProvenance(registrantId, clusterId)
    await mergeRegistrantAnswers(registrantId, data, touchedFields)
  } else {
    const registrant = await db.eventRegistrant.create({
      data: {
        eventId,
        ...("memberId" in person
          ? { memberId: person.memberId }
          : { guestId: person.guestId, ...(person.nickname !== undefined ? { nickname: person.nickname } : {}) }),
        dietaryPreference: data.dietaryPreference ?? null,
        dietaryOther: data.dietaryOther,
        paymentReference: data.paymentReference,
        registrationClusterId: clusterId ?? null,
      },
      select: { id: true },
    })
    registrantId = registrant.id
  }

  const breakoutGroup = await assignBreakoutForRegistrant(
    registrantId,
    eventId,
    breakoutPick,
    profile,
    !!allowOverCapacity,
    // `walkIn` is enough here where it is not enough for `allowOverCapacity`:
    // this narrows automatic placement to staffed groups, so the worst a forged
    // flag buys is a stricter pool.
    walkIn ?? null,
    !!skipAutoAssign,
    breakoutSet ?? "event"
  )

  // Someone who asked to join a DGroup becomes a request an admin can actually
  // see (CCF-101). Raised here rather than in each caller so every entry point —
  // single event, cluster fan-out, household — gets it for free.
  if (data.wantsSmallGroup) {
    await createSeekerRequestFromRegistration(person, eventId)
  }

  // Only walk-ins mark attendance. Registering is a statement of intent, not
  // presence: a pre-registration on a Recurring event used to silently record an
  // OccurrenceAttendee whenever any session happened to be left open (`isOpen`
  // is a manual toggle that nothing auto-closes, so stale-open sessions caught
  // registrations days later). That inflated every check-in figure that reads
  // occurrence attendance — per-event dashboards and the cluster day roll-up.
  // Attendance now comes only from the check-in kiosk or an explicit walk-in.
  if (walkIn) {
    await checkInWalkInRegistrant(registrantId, walkIn.occurrenceId)
  }

  return { id: registrantId, breakoutGroup }
}
