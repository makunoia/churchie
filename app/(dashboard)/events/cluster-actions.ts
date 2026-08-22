"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { db } from "@/lib/db"
import { ProfileCollisionError } from "@/lib/events/profile-merge"
import { verifyIdentityGrant } from "@/lib/security/identity-grant"
import { auth } from "@/lib/auth"
import { canAccessEvent, canWrite } from "@/lib/permissions"
import { isWithinRegistrationWindow } from "@/lib/events/registration-window"
import { clusterDayRegistrationDisposition } from "@/lib/clusters/day-registration"
import {
  fileClusterVolunteerSignUp,
  type ClusterVolunteerFilingFailure,
} from "@/lib/clusters/volunteer-signup"
import { clusterEventMinistryLabel } from "@/lib/clusters/ministry-label"
import { getClusterFormConfig } from "@/lib/forms/context-config-server"
import {
  askedFieldsFor,
  missingRequiredFields,
  requiredFieldsMessage,
  resolveBreakoutSelection,
  sanitizeRegistrantPayload,
} from "@/lib/forms/registration-payload"
import { isEventStaffViewer } from "@/lib/events/staff-viewer"
import {
  assignBreakoutForRegistrant,
  completeEventRegistration,
  findEventVolunteerRecord,
  findExistingEventRegistrationRow,
  resolveAnonymousGuest,
  resolveConfirmedGuest,
  resolveConfirmedMember,
  type TouchedFields,
  stampClusterProvenance,
  stampVolunteerClusterProvenance,
  type AssignedBreakout,
  type PersonRef,
  type ResolvedProfile,
} from "@/lib/events/registration-core"
import {
  buildNameMatcher,
  findEventRegistrantsForLookup,
  findEventVolunteersForLookup,
  clearCheckinAttendance,
  matchesContactQuery,
  recordCheckinAttendance,
  registrantContact,
  registrantIdentityKey,
  registrantName,
} from "@/lib/events/checkin-lookup"
import { contactHintFrom } from "@/lib/contact-hint"
import {
  getAccessibleClusterEvents,
  getClusterDayRows,
  getClusterEvents,
  resolveClusterCheckinTargets,
} from "@/lib/clusters/aggregate"
import {
  planClusterCheckinToggle,
  type ClusterCheckinSkipCause,
} from "@/lib/clusters/checkin-toggle"
import {
  planClusterCheckinRemoval,
  type ClusterCheckinRemovalSkipCause,
} from "@/lib/clusters/checkin-removal"
import { setFormOpen } from "@/app/(dashboard)/forms/actions"
import { setOccurrenceCheckinOpen } from "@/app/(dashboard)/events/actions"
import {
  buildClusterCheckinPeople,
  skipReasonFor,
  type ClusterCheckinPerson,
  type ClusterCheckinSkipReason,
  type ClusterCheckinSubjectRow,
  type ClusterCheckinTarget,
} from "@/lib/clusters/checkin-person"
import { registrantSchema } from "@/lib/validations/event-registrant"
import {
  eventClusterSchema,
  eventClusterSettingsSchema,
  isSameUtcDay,
  resolveClusterEventSelection,
  validateClusterEventLink,
  type EventClusterInput,
  type EventClusterSettingsInput,
} from "@/lib/validations/event-cluster"
import { ClusterKind, type Gender } from "@/app/generated/prisma/client"
import { requireClusterWrite } from "@/lib/events/require-event-write"
import { personKeyFor } from "@/lib/clusters/roster"
import { MINISTRY_REQUIRED_ERROR } from "@/lib/clusters/copy"

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string }

async function requireWrite(): Promise<{ error: string } | null> {
  const session = await auth()
  if (!session?.user) return { error: "Not authenticated." }
  if (!canWrite(session, "Events")) return { error: "Unauthorized." }
  return null
}

/**
 * Every authenticated surface that shows a cluster's state, plus — when the caller
 * knows the token — the public forms whose open/closed state it decides.
 *
 * The Forms pages and the kiosk used to be left out, which was survivable while
 * the switches only described themselves. `setClusterCheckinOpen` now writes
 * member-event state that both of those screens read back, so a stale render there
 * would show a staffer the opposite of what they just did.
 */
function revalidateClusterPaths(clusterId: string, publicToken?: string) {
  revalidatePath("/events/clusters")
  revalidatePath(`/cluster/${clusterId}`)
  revalidatePath(`/cluster/${clusterId}/registrants`)
  revalidatePath(`/cluster/${clusterId}/checkin`)
  revalidatePath(`/cluster/${clusterId}/settings`)
  revalidatePath(`/cluster/${clusterId}/volunteers`)
  revalidatePath(`/cluster/${clusterId}/forms`)
  revalidatePath(`/cluster/${clusterId}/forms/check-in`)
  if (publicToken) {
    revalidatePath(`/register/c/${publicToken}`)
    revalidatePath(`/register/c/${publicToken}/walk-in`)
    revalidatePath(`/register/c/${publicToken}/check-in`)
  }
}

/**
 * Why this day can't be a collab, in words an admin can act on.
 *
 * A collab form asks "which ministry are you part of?", and that question only has
 * an answer if every member event names exactly one ministry and no two events
 * name the same one. A church-wide event (`allMinistries`) has no single answer
 * either — it deliberately means "every ministry, including ones created later".
 *
 * Returns an empty array when the day qualifies. Shared because two actions need
 * the same rule: switching a day to Collab, and adding an event to one that
 * already is.
 */
async function collabMinistryProblems(
  clusterId: string,
  extraEventId?: string
): Promise<string[]> {
  const links = await db.eventClusterEvent.findMany({
    where: { clusterId },
    orderBy: { order: "asc" },
    select: { eventId: true },
  })
  const eventIds = [...new Set([...links.map((l) => l.eventId), ...(extraEventId ? [extraEventId] : [])])]
  if (eventIds.length === 0) return ["Add at least one event to the day first."]

  const events = await db.event.findMany({
    where: { id: { in: eventIds } },
    select: {
      id: true,
      name: true,
      allMinistries: true,
      ministries: { select: { ministry: { select: { id: true, name: true } } } },
    },
  })

  const problems: string[] = []
  const ministryOwners = new Map<string, { name: string; events: string[] }>()

  for (const event of events) {
    if (event.allMinistries) {
      problems.push(`${event.name} is a church-wide event, so it has no single ministry.`)
      continue
    }
    if (event.ministries.length === 0) {
      problems.push(`${event.name} has no ministry set.`)
      continue
    }
    if (event.ministries.length > 1) {
      problems.push(`${event.name} has ${event.ministries.length} ministries — a collab event needs exactly one.`)
      continue
    }
    const { id, name } = event.ministries[0].ministry
    const entry = ministryOwners.get(id) ?? { name, events: [] }
    entry.events.push(event.name)
    ministryOwners.set(id, entry)
  }

  for (const { name, events: sharing } of ministryOwners.values()) {
    if (sharing.length > 1) {
      problems.push(`${sharing.join(" and ")} are both under ${name} — registrants couldn't tell them apart.`)
    }
  }

  return problems
}

// ─── Cluster CRUD (Workstream A) ─────────────────────────────────────────────

export async function createEventCluster(
  raw: EventClusterInput
): Promise<ActionResult<{ id: string }>> {
  const authError = await requireWrite()
  if (authError) return { success: false, error: authError.error }

  const parsed = eventClusterSchema.safeParse(raw)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }
  }

  try {
    const cluster = await db.eventCluster.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description,
        date: parsed.data.date,
      },
      select: { id: true },
    })
    revalidatePath("/events/clusters")
    return { success: true, data: { id: cluster.id } }
  } catch {
    return { success: false, error: "Failed to create the event cluster." }
  }
}

export async function updateEventCluster(
  clusterId: string,
  raw: EventClusterSettingsInput
): Promise<ActionResult> {
  const authError = await requireWrite()
  if (authError) return { success: false, error: authError.error }

  const parsed = eventClusterSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }
  }

  try {
    const cluster = await db.eventCluster.findUnique({
      where: { id: clusterId },
      select: { publicToken: true },
    })
    if (!cluster) return { success: false, error: "Event cluster not found." }

    // Moving the day must not leave a picked session behind on the old date.
    // Only links that name a session are checked: links made before session
    // selection existed carry no such claim, so they never block an edit.
    if (parsed.data.date) {
      const newDate = parsed.data.date
      const linked = await db.eventClusterEvent.findMany({
        where: { clusterId, occurrenceId: { not: null } },
        select: {
          event: { select: { name: true } },
          occurrence: { select: { date: true } },
        },
      })
      const stranded = linked.filter(
        (l) => l.occurrence && !isSameUtcDay(l.occurrence.date, newDate)
      )
      if (stranded.length > 0) {
        const names = stranded.map((l) => l.event.name).join(", ")
        return {
          success: false,
          error: `${names} ${stranded.length === 1 ? "is" : "are"} pinned to a session on another date. Change the session first, then move the day.`,
        }
      }
    }

    // A collab form's one question is "which ministry are you part of?", so the
    // day has to be able to answer it before it can become a collab. Checked here
    // rather than only in the UI: the switch is a plain enum column, and a day
    // that slipped into Collab misconfigured would put an unanswerable question in
    // front of every registrant.
    if (parsed.data.kind === ClusterKind.Collab) {
      const problems = await collabMinistryProblems(clusterId)
      if (problems.length > 0) {
        return {
          success: false,
          error: `This day can't be a collab yet. ${problems.join(" ")}`,
        }
      }
    }

    // Drop undefined so an omitted field doesn't overwrite a stored value.
    const data = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined)
    )
    await db.eventCluster.update({ where: { id: clusterId }, data })
    revalidateClusterPaths(clusterId, cluster.publicToken)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to update the event cluster." }
  }
}

export async function deleteEventCluster(clusterId: string): Promise<ActionResult> {
  const authError = await requireWrite()
  if (authError) return { success: false, error: authError.error }

  try {
    await db.eventCluster.delete({ where: { id: clusterId } })
    revalidatePath("/events/clusters")
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to delete the event cluster." }
  }
}

export async function addEventToCluster(
  clusterId: string,
  eventId: string,
  /** Which session this day stands for — required for Recurring events. */
  occurrenceId?: string | null
): Promise<ActionResult> {
  const authError = await requireWrite()
  if (authError) return { success: false, error: authError.error }

  try {
    const [cluster, event, occurrence] = await Promise.all([
      db.eventCluster.findUnique({
        where: { id: clusterId },
        select: { id: true, date: true, kind: true },
      }),
      db.event.findUnique({
        where: { id: eventId },
        select: {
          id: true,
          name: true,
          type: true,
          startDate: true,
          modules: { select: { type: true } },
          clusterMembership: { select: { clusterId: true } },
        },
      }),
      occurrenceId
        ? db.eventOccurrence.findUnique({
            where: { id: occurrenceId },
            select: { id: true, eventId: true, date: true },
          })
        : null,
    ])
    if (!cluster) return { success: false, error: "Event cluster not found." }
    if (!event) return { success: false, error: "Event not found." }
    if (occurrenceId && !occurrence) {
      return { success: false, error: "Session not found." }
    }

    // Paid events are out of scope for clusters (no payment step on the shared
    // form) — they keep using their own per-event registration form.
    if (event.modules.some((m) => m.type === "Priced")) {
      return {
        success: false,
        error: `${event.name} is a paid event. Paid events can't join a cluster — they keep their own registration form.`,
      }
    }
    if (event.clusterMembership) {
      return {
        success: false,
        error:
          event.clusterMembership.clusterId === clusterId
            ? `${event.name} is already in this cluster.`
            : `${event.name} already belongs to another cluster. An event can only be in one.`,
      }
    }

    const linkCheck = validateClusterEventLink({
      eventId: event.id,
      eventName: event.name,
      eventType: event.type,
      eventStartDate: event.startDate,
      clusterDate: cluster.date,
      session: occurrence,
    })
    if (!linkCheck.ok) return { success: false, error: linkCheck.error }

    // On a collab, a new event has to keep the ministry question answerable —
    // adding one with no ministry, or one under a ministry already represented,
    // would break the form for everyone. Checked with the candidate included.
    if (cluster.kind === ClusterKind.Collab) {
      const problems = await collabMinistryProblems(clusterId, event.id)
      if (problems.length > 0) {
        return {
          success: false,
          error: `${event.name} can't join this collab day. ${problems.join(" ")}`,
        }
      }
    }

    const last = await db.eventClusterEvent.findFirst({
      where: { clusterId },
      orderBy: { order: "desc" },
      select: { order: true },
    })
    await db.eventClusterEvent.create({
      data: {
        clusterId,
        eventId,
        order: (last?.order ?? -1) + 1,
        occurrenceId: occurrence?.id ?? null,
      },
    })
    revalidateClusterPaths(clusterId)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to add the event to the cluster." }
  }
}

/**
 * Re-point a linked Recurring event at a different session. The dashboard,
 * roster, check-in board, and export all scope to the link's session, so
 * changing it here changes what every one of those screens shows.
 */
export async function setClusterEventSession(
  clusterId: string,
  eventId: string,
  occurrenceId: string
): Promise<ActionResult> {
  const authError = await requireWrite()
  if (authError) return { success: false, error: authError.error }

  try {
    const [cluster, link, occurrence] = await Promise.all([
      db.eventCluster.findUnique({
        where: { id: clusterId },
        select: { id: true, date: true },
      }),
      db.eventClusterEvent.findUnique({
        where: { clusterId_eventId: { clusterId, eventId } },
        select: {
          event: { select: { id: true, name: true, type: true, startDate: true } },
        },
      }),
      db.eventOccurrence.findUnique({
        where: { id: occurrenceId },
        select: { id: true, eventId: true, date: true },
      }),
    ])
    if (!cluster) return { success: false, error: "Event cluster not found." }
    if (!link) return { success: false, error: "That event isn't in this cluster." }
    if (!occurrence) return { success: false, error: "Session not found." }

    const linkCheck = validateClusterEventLink({
      eventId: link.event.id,
      eventName: link.event.name,
      eventType: link.event.type,
      eventStartDate: link.event.startDate,
      clusterDate: cluster.date,
      session: occurrence,
    })
    if (!linkCheck.ok) return { success: false, error: linkCheck.error }

    await db.eventClusterEvent.update({
      where: { clusterId_eventId: { clusterId, eventId } },
      data: { occurrenceId },
    })
    revalidateClusterPaths(clusterId)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to change the session." }
  }
}

export async function removeEventFromCluster(
  clusterId: string,
  eventId: string
): Promise<ActionResult> {
  const authError = await requireWrite()
  if (authError) return { success: false, error: authError.error }

  try {
    // Registrants keep their event linkage — removing an event from a cluster
    // never cascades into registrations.
    await db.eventClusterEvent.delete({
      where: { clusterId_eventId: { clusterId, eventId } },
    })
    revalidateClusterPaths(clusterId)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to remove the event from the cluster." }
  }
}

// ─── Shared-form fan-out (Workstream C) ──────────────────────────────────────

export type ClusterEventRegistrationResult = {
  eventId: string
  eventName: string
  status:
    | "registered" // new registration created
    | "already" // was already registered (walk-in reuses & still checks in)
    | "closed" // that event's own registration window has passed
    | "volunteer" // serving as a volunteer at that event
    | "failed" // unexpected per-event failure
  registrantId?: string
  breakoutGroup?: AssignedBreakout
  /** Walk-in mode only: the person was checked in on this event. */
  checkedIn?: boolean
}

/**
 * Register one person for several events of a cluster in a single submission.
 *
 * The person is resolved exactly once (the central CCF-132 refactor) — the same
 * `memberId`/`guestId` is reused for every selected event, so the fan-out can
 * never create duplicate Guests or repeat member promotion. Per-event outcomes
 * are collected individually: one event being closed or already-registered must
 * not sink the others (partial success).
 *
 * Walk-in mode (the door link): exempt from the cluster window, reuses existing
 * registrations, and checks the person in immediately — on a OneTime event via
 * `attendedAt`, and on a Recurring event via the session its cluster link names.
 * A Recurring event whose link has no session is registered without check-in:
 * there is no way to know which occurrence the person is standing in front of,
 * which is exactly the ambiguity session selection removes.
 */
export async function registerForCluster(
  publicToken: string,
  raw: z.input<typeof registrantSchema>,
  confirmedMemberId: string | null,
  confirmedGuestId: string | null | undefined,
  skipDeduplication: boolean | undefined,
  selectedEventIds: string[],
  walkIn?: boolean,
  /** Review-screen edits (CCF-147) — these overwrite the stored profile. */
  touchedFields?: TouchedFields,
  /** Proof of record ownership; without it `touchedFields` is ignored. */
  grant?: string | null,
  /**
   * The breakout table the person picked, on a Collab day whose shared form
   * offers the step. Honoured only there — a Parallel day's tables belong to its
   * member events individually, so it has no picker to honour.
   */
  selectedBreakoutGroupId?: string | null
): Promise<ActionResult<{ results: ClusterEventRegistrationResult[] }>> {
  const parsed = registrantSchema.safeParse(raw)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }
  }

  try {
    const cluster = await db.eventCluster.findUnique({
      where: { publicToken },
      select: {
        id: true,
        kind: true,
        isOpen: true,
        registrationStart: true,
        registrationEnd: true,
        events: {
          orderBy: { order: "asc" },
          select: {
            occurrenceId: true,
            event: {
              select: {
                id: true,
                name: true,
                type: true,
                registrationStart: true,
                registrationEnd: true,
              },
            },
          },
        },
      },
    })
    if (!cluster) return { success: false, error: "Event day not found." }

    // Cluster-level open/close governs the shared form. Walk-ins are exempt:
    // they're staff-supervised at the door (same rule as per-event walk-ins).
    if (!walkIn) {
      if (
        !cluster.isOpen ||
        !isWithinRegistrationWindow(cluster.registrationStart, cluster.registrationEnd)
      ) {
        return { success: false, error: "Registration for this event day is closed." }
      }
    }

    const clusterEvents = cluster.events.map((ce) => ce.event)
    /** The session each event's cluster link names — the walk-in check-in target. */
    const linkedSessionByEvent = new Map(
      cluster.events.map((ce) => [ce.event.id, ce.occurrenceId])
    )
    /**
     * Which events this submission registers for.
     *
     * A Collab day asks which *ministry* the person is part of, and that answer
     * names exactly one event. An empty selection is normally an error — except on
     * an amend, where the ministry step isn't shown at all because the person
     * already has a registration to amend. That case is resolved below, once the
     * person is known.
     */
    const isCollab = cluster.kind === ClusterKind.Collab
    const clusterEventIds = clusterEvents.map((e) => e.id)
    const mayResolveFromExisting = isCollab && selectedEventIds.length === 0

    let targetEventIds: string[]
    if (mayResolveFromExisting) {
      targetEventIds = []
    } else {
      const selection = resolveClusterEventSelection(
        cluster.kind,
        selectedEventIds,
        clusterEventIds
      )
      if (!selection.ok) return { success: false, error: selection.error }
      targetEventIds = selection.eventIds
    }

    // Enforce the cluster's shared form config server-side — same crafted-POST
    // defense as the per-event form, but against the CLUSTER's config: profile
    // writes happen once here, before any per-event call.
    const formConfig = await getClusterFormConfig(cluster.id, walkIn ? "WalkIn" : "Register")
    Object.assign(parsed.data, sanitizeRegistrantPayload(formConfig, parsed.data))
    // Checked after sanitizing, so a value sent for a disabled field can't
    // satisfy a stale required flag on that same field.
    const missing = missingRequiredFields(
      formConfig,
      parsed.data,
      askedFieldsFor(walkIn ? "WalkIn" : "Register", parsed.data)
    )
    if (missing.length > 0) {
      return { success: false, error: requiredFieldsMessage(missing) }
    }

    // A submitted pick counts only where the picker was offered — the same
    // crafted-POST defense the per-event action applies, against the CLUSTER's
    // config. Auto-assign is unaffected: it runs off a null selection.
    const breakoutPick = isCollab
      ? resolveBreakoutSelection(formConfig, selectedBreakoutGroupId)
      : null

    /**
     * Whether to leave someone unseated for the day's kiosk to ask (CCF-148).
     *
     * A member event with `autoAssignBreakout` on placed every registrant at
     * submit, and the kiosk skips anyone already seated — so a Collab day whose
     * Check-in form asked about tables never got to ask anybody, and switching the
     * section on looked like it did nothing. Auto-assign has always *replaced* a
     * picker rather than sat beside it; this is that same rule, now that the
     * picker can be one surface further along.
     *
     * Only automatic placement waits. A table chosen on this submission is a
     * decision already taken and still lands, which is also why the kiosk goes on
     * skipping people who arrive seated — it re-asks nobody who chose.
     *
     * Never at the **door**: a walk-in is checked in on the spot and never reaches
     * the kiosk, so deferring there would strand them unseated with nobody left to
     * ask. The door has its own picker for exactly this reason.
     */
    const deferBreakoutToCheckin =
      isCollab &&
      !walkIn &&
      (await getClusterFormConfig(cluster.id, "CheckIn")).sectionBreakout

    // Going over a group's member limit is a staff decision taken at the door
    // (CCF-141), and `walkIn` alone can't authorise it: the cluster walk-in route
    // is public, so that flag is self-asserted by the request. Same pairing as
    // `createRegistrant`.
    const allowOverCapacity = !!walkIn && (await isEventStaffViewer())

    // ── Resolve the person ONCE ─────────────────────────────────────────────
    // Overwriting a stored profile field takes proof that the caller owns the
    // record — see `grantedTouchedFields` in ./actions.ts. The grant is scoped to
    // the record rather than an event precisely so it survives this fan-out.
    let person: PersonRef
    let profile: ResolvedProfile
    let touched: TouchedFields = null
    if (confirmedMemberId) {
      touched = verifyIdentityGrant(grant, { recordId: confirmedMemberId, recordType: "member" })
        ? touchedFields
        : null
      const stored = await resolveConfirmedMember(confirmedMemberId, parsed.data, touched)
      person = { memberId: confirmedMemberId }
      profile = {
        gender: (parsed.data.gender ?? stored.gender) as Gender | null,
        birthYear: parsed.data.birthYear ?? stored.birthYear,
        lifeStageId: parsed.data.lifeStageId ?? stored.lifeStageId,
      }
    } else if (confirmedGuestId) {
      touched = verifyIdentityGrant(grant, { recordId: confirmedGuestId, recordType: "guest" })
        ? touchedFields
        : null
      const stored = await resolveConfirmedGuest(confirmedGuestId, parsed.data, touched)
      person = { guestId: confirmedGuestId }
      profile = {
        gender: (parsed.data.gender ?? stored.gender) as Gender | null,
        birthYear: parsed.data.birthYear ?? stored.birthYear,
        lifeStageId: parsed.data.lifeStageId ?? stored.lifeStageId,
      }
    } else {
      const { guestId, ...stored } = await resolveAnonymousGuest(parsed.data, skipDeduplication)
      person = { guestId, nickname: parsed.data.nickname ?? null }
      profile = {
        gender: (parsed.data.gender ?? stored.gender) as Gender | null,
        birthYear: parsed.data.birthYear ?? stored.birthYear,
        lifeStageId: parsed.data.lifeStageId ?? stored.lifeStageId,
      }
    }

    // An amend on a collab arrives with no ministry pick, because the step isn't
    // shown — the person already has a registration and re-asking which ministry
    // they belong to would be a question about a decision already made. Resolve the
    // target from that registration instead. Only reachable when the person was
    // resolved from a record we hold, which is the same proof the amend flow itself
    // requires (see `verifyIdentityGrant`).
    if (mayResolveFromExisting) {
      const held = await db.eventRegistrant.findMany({
        where: {
          eventId: { in: clusterEventIds },
          ...("memberId" in person
            ? { memberId: person.memberId }
            : { guestId: person.guestId }),
        },
        select: { eventId: true, registrationClusterId: true },
      })
      // The day's own registrations first. Scanning every member event is how an
      // amend finds the registration to re-open, but a row inherited from a
      // ministry's series is not this day's — and preferring it would amend a
      // months-old sign-up on the wrong half of a collab. Cluster display order
      // breaks the remaining tie, the same tie-break
      // `validateClusterEventSelection` applies: someone registered to both halves
      // is unusual but not impossible, and picking arbitrarily would amend a
      // different registration each time.
      const onThisDay = held.filter((e) => e.registrationClusterId === cluster.id)
      const preferred = onThisDay.length > 0 ? onThisDay : held
      const resolved = clusterEventIds.filter((id) =>
        preferred.some((e) => e.eventId === id)
      )
      if (resolved.length === 0) {
        return { success: false, error: MINISTRY_REQUIRED_ERROR }
      }
      targetEventIds = resolved.slice(0, 1)
    }

    // ── Fan out per selected event (partial success) ────────────────────────
    const results: ClusterEventRegistrationResult[] = []
    const eventsById = new Map(clusterEvents.map((e) => [e.id, e]))
    for (const eventId of targetEventIds) {
      const event = eventsById.get(eventId)!
      try {
        // Per-event windows still apply inside the fan-out (walk-ins exempt).
        if (
          !walkIn &&
          !isWithinRegistrationWindow(event.registrationStart, event.registrationEnd)
        ) {
          results.push({ eventId, eventName: event.name, status: "closed" })
          continue
        }

        const serving =
          "memberId" in person
            ? await findEventVolunteerRecord(eventId, person.memberId)
            : null
        if (serving) {
          // Serving instead of attending — no registrant row to create, and there
          // must not be one. But they DID just come through this day's form, and
          // that is the only evidence `volunteerIsOnClusterDay` accepts for a
          // ministry regular whose sign-up predates the day. Stamping it here is
          // the difference between the day's screens listing them and dropping
          // them entirely, while the form told them they were "already included".
          // Same reasoning, same place in the flow, as the `already` branch below.
          await stampVolunteerClusterProvenance(serving.id, cluster.id)
          results.push({ eventId, eventName: event.name, status: "volunteer" })
          continue
        }

        const existing = await findExistingEventRegistrationRow(eventId, person)
        /**
         * What that row means for THIS day — see `clusterDayRegistrationDisposition`.
         *
         * A Collab day owns its own registrant list and its own tables, so a row
         * made for the underlying series is not a registration for the day: it is
         * reused (never duplicated) and the day's work runs on top of it. A
         * Parallel day is unchanged — there, the member event's registration is
         * precisely what the person asked for.
         */
        const disposition = clusterDayRegistrationDisposition(isCollab, existing, cluster.id)

        if (existing && disposition === "already" && !walkIn) {
          // Already registered, so there is nothing to create — but they DID just
          // sign up for this day, and the day roll-up reads that from the
          // provenance column. Stamping it here is the whole difference between
          // the roster placing them on the day and drawing "—": the stamp used to
          // live only past this `continue`, on the reuse branch of
          // `completeEventRegistration`, so an existing registration could never
          // acquire one — and registering again, the obvious thing for an admin
          // to try, ran straight back into the same short-circuit.
          //
          // Only the stamp is repeated. Breakout assignment and the DGroup seeker
          // request stay on the far side: those happened when the person first
          // registered, and re-running them would double-file the same person.
          await stampClusterProvenance(existing.id, cluster.id)
          // An explicit breakout pick is the one other thing that repeats here,
          // and for the mirror-image reason. The rest of this branch's work is
          // skipped because it *already happened* — but a table chosen on this
          // submission is a decision taken just now, and it reaches this branch
          // by the supported route: amending re-opens a registration the day
          // already holds. Dropping it would show the person a step, take their
          // answer and keep the old table. `assignBreakoutForRegistrant` moves
          // rather than double-seats, so repeating it is safe; automatic
          // placement stays on the far side, where nobody chose anything.
          const rePicked = breakoutPick
            ? await assignBreakoutForRegistrant(
                existing.id,
                eventId,
                breakoutPick,
                profile,
                allowOverCapacity
              )
            : null
          results.push({
            eventId,
            eventName: event.name,
            status: "already",
            registrantId: existing.id,
            breakoutGroup: rePicked ?? undefined,
          })
          continue
        }

        // Where a walk-in's attendance lands. OneTime events have no sessions, so
        // it's `attendedAt` (occurrenceId null). A Recurring event checks in on
        // the session its cluster link names — the whole point of naming one. An
        // unlinked Recurring event (or a legacy MultiDay link) still can't say
        // WHICH occurrence the person is at, so it registers without check-in.
        const linkedSession = linkedSessionByEvent.get(event.id) ?? null
        const walkInForEvent = !walkIn
          ? null
          : event.type === "OneTime"
            ? { occurrenceId: null }
            : event.type === "Recurring" && linkedSession
              ? { occurrenceId: linkedSession }
              : null

        const completed = await completeEventRegistration({
          eventId,
          person,
          data: parsed.data,
          // Null on a Parallel day, where the shared form has no picker — and
          // auto-assign still runs there exactly as it did.
          breakoutPick,
          allowOverCapacity,
          profile,
          clusterId: cluster.id,
          walkIn: walkInForEvent,
          existingRegistrantId: existing?.id ?? null,
          touchedFields: touched,
          skipAutoAssign: deferBreakoutToCheckin,
        })
        results.push({
          eventId,
          eventName: event.name,
          // A reused row on a Collab day IS this submission's registration — the
          // day's first one for this person — so it reports as registered. Only
          // the walk-in door, which reuses a registration by design rather than
          // as a fresh sign-up, still says "already".
          status: walkIn && existing ? "already" : "registered",
          registrantId: completed.id,
          breakoutGroup: completed.breakoutGroup,
          checkedIn: walkInForEvent !== null,
        })
        revalidatePath(`/event/${eventId}/registrants`)
      } catch {
        results.push({ eventId, eventName: event.name, status: "failed" })
      }
    }

    revalidateClusterPaths(cluster.id)
    return { success: true, data: { results } }
  } catch (error) {
    // Person resolution happens once, before the fan-out, so a contact collision
    // sinks the whole submission rather than producing per-event partials — and
    // has to reach the person as itself, not as "please try again".
    if (error instanceof ProfileCollisionError) {
      return { success: false, error: error.message }
    }
    return { success: false, error: "Failed to register. Please try again." }
  }
}

// ─── Breakout carry-over (CCF-148) ───────────────────────────────────────────

/**
 * Copy a member event's breakout tables onto the cluster.
 *
 * A Collab cluster owns its own tables and starts with none, because the usual
 * thing a collab wants is a clean sheet — the distribution is reset and the
 * groups are set up for that session. Carry-over is the escape hatch for the
 * other case: same tables, same facilitators, and optionally the same people.
 *
 * **Copies, never links.** The cluster gets independent rows. Editing the day's
 * table must not rewrite the ministry's standing one, which is the entire reason
 * the tables are cluster-owned in the first place.
 *
 * The facilitator FKs copy across unchanged, and that is sound rather than lucky:
 * volunteers pool as a union under a Collab, so a volunteer of the source event
 * is already eligible to run any of the day's tables.
 */
export async function carryOverBreakoutGroups(
  clusterId: string,
  fromEventId: string,
  opts: { includeMembers: boolean }
): Promise<
  ActionResult<{ created: number; membersCopied: number; membersSkipped: number }>
> {
  const denied = await requireClusterWrite(clusterId)
  if (denied) return { success: false, error: denied.error }

  try {
    const cluster = await db.eventCluster.findUnique({
      where: { id: clusterId },
      select: { kind: true, events: { select: { eventId: true } } },
    })
    if (!cluster) return { success: false, error: "Event day not found." }
    if (cluster.kind !== ClusterKind.Collab) {
      return {
        success: false,
        error: "Only a collab event day has its own breakout groups.",
      }
    }
    if (!cluster.events.some((e) => e.eventId === fromEventId)) {
      return { success: false, error: "That event isn't part of this event day." }
    }

    const sources = await db.breakoutGroup.findMany({
      where: { eventId: fromEventId },
      orderBy: { createdAt: "asc" },
      select: {
        name: true,
        facilitatorId: true,
        coFacilitatorId: true,
        genderFocus: true,
        language: true,
        ageRangeMin: true,
        ageRangeMax: true,
        meetingFormat: true,
        locationCity: true,
        memberLimit: true,
        isEnabled: true,
        linkedSmallGroupId: true,
        lifeStages: { select: { id: true } },
        schedules: { select: { dayOfWeek: true, timeStart: true, timeEnd: true } },
        members: {
          select: {
            registrant: { select: { id: true, memberId: true, guestId: true } },
          },
        },
      },
    })
    if (sources.length === 0) {
      return { success: false, error: "That event has no breakout groups to carry over." }
    }

    // Names are only unique within a set, and a second carry-over from the other
    // ministry can legitimately bring another "Table 1". Suffix rather than
    // reject — refusing the whole batch over a name clash would be the wrong
    // trade for a bulk action.
    const existingNames = new Set(
      (
        await db.breakoutGroup.findMany({
          where: { clusterId },
          select: { name: true },
        })
      ).map((g) => g.name.toLowerCase())
    )
    function uniqueName(base: string): string {
      if (!existingNames.has(base.toLowerCase())) {
        existingNames.add(base.toLowerCase())
        return base
      }
      for (let n = 2; ; n++) {
        const candidate = `${base} (${n})`
        if (!existingNames.has(candidate.toLowerCase())) {
          existingNames.add(candidate.toLowerCase())
          return candidate
        }
      }
    }

    // One seat per person across the cluster's tables. Resolved by person rather
    // than by registrant row because the same person holds a registration on
    // every member event of a Collab — see `personKeyFor`.
    const seated = new Set(
      (
        await db.breakoutGroupMember.findMany({
          where: { breakoutGroup: { clusterId } },
          select: { registrant: { select: { id: true, memberId: true, guestId: true } } },
        })
      ).map((m) => personKeyFor(m.registrant))
    )

    let created = 0
    let membersCopied = 0
    let membersSkipped = 0

    for (const src of sources) {
      const group = await db.breakoutGroup.create({
        data: {
          clusterId,
          name: uniqueName(src.name),
          facilitatorId: src.facilitatorId,
          coFacilitatorId: src.coFacilitatorId,
          genderFocus: src.genderFocus,
          language: src.language,
          ageRangeMin: src.ageRangeMin,
          ageRangeMax: src.ageRangeMax,
          meetingFormat: src.meetingFormat,
          locationCity: src.locationCity,
          memberLimit: src.memberLimit,
          isEnabled: src.isEnabled,
          linkedSmallGroupId: src.linkedSmallGroupId,
          lifeStages: { connect: src.lifeStages.map((l) => ({ id: l.id })) },
          schedules: {
            create: src.schedules.map((sc) => ({
              dayOfWeek: sc.dayOfWeek,
              timeStart: sc.timeStart,
              timeEnd: sc.timeEnd,
            })),
          },
        },
        select: { id: true },
      })
      created++

      if (!opts.includeMembers) continue

      // The source memberships already point at a member event's registrants, so
      // they are reusable as they are — no id mapping needed. Capacity is still
      // honoured: the group was just created empty, so its seat count is exactly
      // what we have placed into it here.
      const room = src.memberLimit ?? src.members.length
      let placed = 0
      for (const m of src.members) {
        const key = personKeyFor(m.registrant)
        if (seated.has(key) || placed >= room) {
          membersSkipped++
          continue
        }
        await db.breakoutGroupMember.create({
          data: { breakoutGroupId: group.id, registrantId: m.registrant.id },
        })
        seated.add(key)
        placed++
        membersCopied++
      }
    }

    revalidatePath(`/cluster/${clusterId}/breakouts`)
    revalidateClusterPaths(clusterId)
    return { success: true, data: { created, membersCopied, membersSkipped } }
  } catch {
    return { success: false, error: "Failed to carry over breakout groups" }
  }
}

// ─── Opening the day's check-in ──────────────────────────────────────────────

export type ClusterEventCheckinResult = {
  eventId: string
  eventName: string
  status: "opened" | "closed" | "created" | "skipped" | "failed"
  reason?: ClusterCheckinSkipCause
}

/**
 * Open (or close) check-in for the whole day — the kiosk *and* every member event.
 *
 * `EventCluster.checkInIsOpen` only ever governed the day's own kiosk door. What
 * decides whether a person standing at that kiosk can actually be checked in to an
 * event is the event's own control: a `FormConfig("EventCheckIn")` row for OneTime,
 * an `EventOccurrence.isOpen` for a session event. So opening a day meant flipping
 * this switch and then walking into each member event to flip its own — and until
 * every one was open the kiosk found the person and silently passed their events
 * over (`skipReasonFor` → `formClosed` / `sessionClosed` / `noSession`), which on a
 * Collab day it can't even name.
 *
 * This is the one switch. It reuses the per-event actions rather than writing the
 * columns itself, so opening a session from here is indistinguishable from opening
 * it on the event's own Sessions page — the walk-in door moves the same way, and
 * there is no second code path to drift.
 *
 * A session event with no session for the day gets one created at the cluster's
 * date and pinned to the link, which is the `noSession` case the day's Shortcuts
 * could previously only send a staffer away to fix by hand.
 *
 * The cluster's own switch is all-or-nothing and goes first: the day's door must
 * flip even if a member event then fails. Past that it is a fan-out in the shape
 * `registerForCluster` established — per-item `try/catch`, a typed status per
 * event, and `success: true` once the loop has run, because the caller decides
 * what a partial result means.
 */
export async function setClusterCheckinOpen(
  clusterId: string,
  isOpen: boolean
): Promise<ActionResult<{ results: ClusterEventCheckinResult[] }>> {
  const authError = await requireClusterWrite(clusterId)
  if (authError) return { success: false, error: authError.error }

  try {
    const cluster = await db.eventCluster.findUnique({
      where: { id: clusterId },
      select: { id: true, publicToken: true, date: true },
    })
    if (!cluster) return { success: false, error: "Event cluster not found." }

    await db.eventCluster.update({
      where: { id: clusterId },
      data: { checkInIsOpen: isOpen },
    })

    const events = await getClusterEvents(clusterId)
    const targets = await resolveClusterCheckinTargets(events, cluster.date)
    const ops = planClusterCheckinToggle(targets, isOpen, cluster.date)

    const results: ClusterEventCheckinResult[] = []
    const done = isOpen ? "opened" : "closed"

    for (const op of ops) {
      const base = { eventId: op.eventId, eventName: op.eventName }
      try {
        switch (op.kind) {
          case "skip":
            results.push({ ...base, status: "skipped", reason: op.reason })
            break

          case "formConfig": {
            const result = await setFormOpen("EventCheckIn", op.eventId, isOpen)
            results.push({ ...base, status: result.success ? done : "failed" })
            break
          }

          case "occurrence": {
            const result = await setOccurrenceCheckinOpen(op.occurrenceId, isOpen)
            results.push({ ...base, status: result.success ? done : "failed" })
            break
          }

          case "createSession": {
            // Upsert rather than create: `@@unique([eventId, date])` makes a
            // concurrent open idempotent instead of a crash.
            const occurrence = await db.eventOccurrence.upsert({
              where: { eventId_date: { eventId: op.eventId, date: op.date } },
              create: { eventId: op.eventId, date: op.date },
              update: {},
              select: { id: true },
            })
            const result = await setOccurrenceCheckinOpen(occurrence.id, true)
            if (!result.success) {
              results.push({ ...base, status: "failed" })
              break
            }
            // Pin the link to the session we just made, so tomorrow's read
            // resolves it by name instead of falling back to the date window.
            // Safe by construction: it is dated to the cluster's own day, which
            // is exactly what `validateClusterEventLink` requires.
            await db.eventClusterEvent.update({
              where: { clusterId_eventId: { clusterId, eventId: op.eventId } },
              data: { occurrenceId: occurrence.id },
            })
            results.push({ ...base, status: "created" })
            break
          }
        }
      } catch {
        results.push({ ...base, status: "failed" })
      }
    }

    for (const r of results) {
      revalidatePath(`/event/${r.eventId}/sessions`)
      revalidatePath(`/event/${r.eventId}/forms/EventCheckIn`)
    }
    revalidateClusterPaths(clusterId, cluster.publicToken)

    return { success: true, data: { results } }
  } catch {
    return { success: false, error: "Failed to update check-in for the day." }
  }
}

export type ClusterCheckinRemovalOutcome = {
  /** The events an arrival was actually undone on. */
  removed: { eventId: string; eventName: string }[]
  skipped: {
    eventId: string
    eventName: string
    reason: ClusterCheckinRemovalSkipCause
  }[]
}

/**
 * Undo a person's arrival across the day — the admin board's answer to the
 * session screen's "Remove from session".
 *
 * The inverse of `checkInToCluster`, and it takes the same shape of argument for
 * the same reason: a **person key**, never a registrant or volunteer id. Every
 * row is re-resolved from the cluster's own events, so a forged or stale key
 * simply finds nobody, and a Staff user with partial event access can only clear
 * the events they can already see (`getAccessibleClusterEvents`, the board's own
 * read).
 *
 * Person-level rather than per-event because that is the grain of both the board
 * and the kiosk that created the record: one row is one person, and one tap
 * checked them into every event of the day that would take it. On a **Parallel**
 * day that can mean several arrivals behind one click, which is why the outcome
 * names each one back — the confirm dialog says what it is about to clear, and
 * the toast says what it did.
 *
 * Attendance only. The registration or volunteer row itself is untouched: the
 * person is still expected on the day, they are simply no longer marked as
 * having arrived.
 */
export async function removeClusterCheckin(
  clusterId: string,
  personKey: string
): Promise<ActionResult<ClusterCheckinRemovalOutcome>> {
  const authError = await requireClusterWrite(clusterId)
  if (authError) return { success: false, error: authError.error }

  if (!personKey.trim()) return { success: false, error: "No one selected." }

  try {
    const session = await auth()
    const cluster = await db.eventCluster.findUnique({
      where: { id: clusterId },
      select: { id: true, publicToken: true, date: true, kind: true },
    })
    if (!cluster) return { success: false, error: "Event cluster not found." }

    // The same slice of the day the board monitors — a MultiDay event, or a
    // Recurring one whose link names no session, tracks its arrivals on its own
    // sessions page and is not this screen's to undo.
    const events = (await getAccessibleClusterEvents(session, clusterId)).filter(
      (e) => e.type === "OneTime" || (e.type === "Recurring" && e.linkedOccurrenceId)
    )
    if (events.length === 0) {
      return { success: false, error: "This day has no events to undo." }
    }

    const rows = await getClusterDayRows(events, {
      clusterId: cluster.id,
      date: cluster.date,
      kind: cluster.kind,
    })
    // `onClusterDay` matches the board exactly: a standing series row with no
    // evidence for today is not on this screen, so it is not this screen's to
    // clear either.
    const mine = rows.filter((r) => r.onClusterDay && personKeyFor(r) === personKey)
    if (mine.length === 0) {
      return { success: false, error: "We couldn't find that person on this day." }
    }

    const targets = await resolveClusterCheckinTargets(events, cluster.date)
    const ops = planClusterCheckinRemoval(targets, mine)

    const removed: ClusterCheckinRemovalOutcome["removed"] = []
    const skipped: ClusterCheckinRemovalOutcome["skipped"] = []

    for (const op of ops) {
      const base = { eventId: op.eventId, eventName: op.eventName }
      if (op.kind === "skip") {
        skipped.push({ ...base, reason: op.reason })
        continue
      }
      await clearCheckinAttendance(
        op.subject,
        op.kind === "occurrence" ? op.occurrenceId : null
      )
      if (!removed.some((r) => r.eventId === op.eventId)) removed.push(base)
      revalidatePath(`/event/${op.eventId}/checkin`)
      revalidatePath(`/event/${op.eventId}/dashboard`)
      if (op.kind === "occurrence") {
        revalidatePath(`/event/${op.eventId}/sessions`)
        revalidatePath(`/event/${op.eventId}/sessions/${op.occurrenceId}`)
      }
    }

    revalidateClusterPaths(clusterId, cluster.publicToken)
    return { success: true, data: { removed, skipped } }
  } catch {
    return { success: false, error: "Failed to undo the check-in." }
  }
}

// ─── Cluster check-in kiosk ──────────────────────────────────────────────────
//
// The day's check-in door. Where the per-event kiosk finds one subject on one
// event, this finds one *person* across every event of the day and records their
// attendance on all of them in a single tap.
//
// Public, like every other check-in action — the kiosk runs with no session. The
// safety comes from re-deriving everything server-side from the token: the caller
// supplies a person key and nothing else, so an id belonging to an event outside
// this cluster resolves to nothing. (`markCheckinAttendance` takes a bare subject
// id and is unscoped; that pattern is deliberately not repeated here.)

export type ClusterCheckinLookupResult =
  | { matchType: "one"; person: ClusterCheckinPerson }
  | { matchType: "ambiguous"; candidates: ClusterCheckinPerson[] }

type ClusterCheckinContext = {
  cluster: { id: string; name: string; checkInIsOpen: boolean }
  targets: ClusterCheckinTarget[]
  occurrenceByEvent: Map<string, string | null>
  eventIds: string[]
}

async function loadClusterCheckinContext(
  token: string
): Promise<ClusterCheckinContext | null> {
  const cluster = await db.eventCluster.findUnique({
    where: { publicToken: token },
    select: { id: true, name: true, date: true, checkInIsOpen: true },
  })
  if (!cluster) return null

  // No session here, so the whole day is in scope — permission filtering is for
  // the authenticated workspace, not for the person standing at the door.
  const events = await getClusterEvents(cluster.id)
  const resolved = await resolveClusterCheckinTargets(events, cluster.date)

  return {
    cluster: {
      id: cluster.id,
      name: cluster.name,
      checkInIsOpen: cluster.checkInIsOpen,
    },
    targets: resolved.map(({ shortcut, occurrenceId }) => ({
      eventId: shortcut.eventId,
      eventName: shortcut.eventName,
      status: shortcut.status,
      occurrenceId,
    })),
    occurrenceByEvent: new Map(
      resolved.map(({ shortcut, occurrenceId }) => [shortcut.eventId, occurrenceId])
    ),
    eventIds: events.map((e) => e.id),
  }
}

/**
 * Which of the matched subjects already have attendance for the day, keyed
 * `<kind>:<id>@<eventId>`. One batched read rather than the per-candidate
 * lookups the single-event path does — a cluster multiplies those by the number
 * of events *and* the number of candidates.
 */
async function loadClusterAttendance(
  ctx: ClusterCheckinContext,
  registrants: { id: string; eventId: string; attendedAt: Date | null }[],
  volunteers: { id: string; eventId: string | null; attendedAt: Date | null }[]
): Promise<Set<string>> {
  const checkedIn = new Set<string>()

  // OneTime events have no occurrence; presence is the flat `attendedAt` stamp.
  for (const r of registrants) {
    if (ctx.occurrenceByEvent.get(r.eventId) == null && r.attendedAt !== null) {
      checkedIn.add(`registrant:${r.id}@${r.eventId}`)
    }
  }
  for (const v of volunteers) {
    if (v.eventId && ctx.occurrenceByEvent.get(v.eventId) == null && v.attendedAt !== null) {
      checkedIn.add(`volunteer:${v.id}@${v.eventId}`)
    }
  }

  const occurrenceIds = ctx.targets
    .map((t) => t.occurrenceId)
    .filter((id): id is string => id !== null)
  if (occurrenceIds.length === 0) return checkedIn

  const eventByOccurrence = new Map(
    ctx.targets
      .filter((t) => t.occurrenceId !== null)
      .map((t) => [t.occurrenceId as string, t.eventId])
  )
  const rows = await db.occurrenceAttendee.findMany({
    where: {
      occurrenceId: { in: occurrenceIds },
      OR: [
        { registrantId: { in: registrants.map((r) => r.id) } },
        { volunteerId: { in: volunteers.map((v) => v.id) } },
      ],
    },
    select: { occurrenceId: true, registrantId: true, volunteerId: true },
  })
  for (const row of rows) {
    const eventId = eventByOccurrence.get(row.occurrenceId)
    if (!eventId) continue
    if (row.registrantId) checkedIn.add(`registrant:${row.registrantId}@${eventId}`)
    if (row.volunteerId) checkedIn.add(`volunteer:${row.volunteerId}@${eventId}`)
  }
  return checkedIn
}

/** Matched rows → the pure builder's input shape. */
async function buildPeopleFromMatches(
  ctx: ClusterCheckinContext,
  matchedRegistrants: Awaited<ReturnType<typeof findEventRegistrantsForLookup>>,
  matchedVolunteers: Awaited<ReturnType<typeof findEventVolunteersForLookup>>
): Promise<ClusterCheckinPerson[]> {
  const checkedIn = await loadClusterAttendance(ctx, matchedRegistrants, matchedVolunteers)

  const rows: ClusterCheckinSubjectRow[] = []

  for (const r of matchedRegistrants) {
    const { firstName, lastName } = registrantName(r)
    const contact = registrantContact(r)
    rows.push({
      key: registrantIdentityKey(r),
      eventId: r.eventId,
      subject: { kind: "registrant", id: r.id },
      alreadyCheckedIn: checkedIn.has(`registrant:${r.id}@${r.eventId}`),
      firstName,
      lastName,
      // The per-event nickname wins; otherwise fall back to the one on the profile.
      nickname: r.nickname ?? r.member?.nickname ?? r.guest?.nickname ?? null,
      contactHint: contactHintFrom(contact.phone, contact.email),
      isMember: r.memberId !== null,
    })
  }

  for (const v of matchedVolunteers) {
    if (!v.eventId) continue
    rows.push({
      key: `member:${v.memberId}`,
      eventId: v.eventId,
      subject: { kind: "volunteer", id: v.id },
      alreadyCheckedIn: checkedIn.has(`volunteer:${v.id}@${v.eventId}`),
      firstName: v.member.firstName,
      lastName: v.member.lastName,
      nickname: v.member.nickname,
      contactHint: contactHintFrom(v.member.phone, v.member.email),
      isMember: true,
    })
  }

  return buildClusterCheckinPeople(ctx.targets, rows)
}

/** Exact mobile/email match across the whole day. */
export async function lookupClusterCheckin(
  token: string,
  query: string
): Promise<ActionResult<ClusterCheckinLookupResult | null>> {
  const q = query.trim()
  if (!q) return { success: true, data: null }

  try {
    const ctx = await loadClusterCheckinContext(token)
    if (!ctx) return { success: false, error: "Event day not found." }
    if (!ctx.cluster.checkInIsOpen) {
      return { success: false, error: "Check-in is closed." }
    }
    if (ctx.eventIds.length === 0) return { success: true, data: null }

    const [allRegistrants, allVolunteers] = await Promise.all([
      findEventRegistrantsForLookup(ctx.eventIds),
      findEventVolunteersForLookup(ctx.eventIds),
    ])
    const people = await buildPeopleFromMatches(
      ctx,
      allRegistrants.filter((r) => matchesContactQuery(registrantContact(r), q)),
      allVolunteers.filter((v) =>
        matchesContactQuery({ email: v.member.email, phone: v.member.phone }, q)
      )
    )

    if (people.length === 0) return { success: true, data: null }
    if (people.length > 1) {
      return { success: true, data: { matchType: "ambiguous", candidates: people } }
    }
    return { success: true, data: { matchType: "one", person: people[0] } }
  } catch {
    return { success: false, error: "Lookup failed. Please try again." }
  }
}

/** Name search across the whole day, for the kiosk's type-ahead. */
export async function searchClusterCheckinByName(
  token: string,
  query: string
): Promise<ActionResult<ClusterCheckinPerson[]>> {
  const nameContains = buildNameMatcher(query)
  if (!nameContains) return { success: true, data: [] }

  try {
    const ctx = await loadClusterCheckinContext(token)
    if (!ctx) return { success: false, error: "Event day not found." }
    if (!ctx.cluster.checkInIsOpen) {
      return { success: false, error: "Check-in is closed." }
    }
    if (ctx.eventIds.length === 0) return { success: true, data: [] }

    const [allRegistrants, allVolunteers] = await Promise.all([
      findEventRegistrantsForLookup(ctx.eventIds),
      findEventVolunteersForLookup(ctx.eventIds),
    ])
    const people = await buildPeopleFromMatches(
      ctx,
      allRegistrants.filter((r) => {
        const { firstName, lastName } = registrantName(r)
        return nameContains(firstName, lastName, [
          r.nickname,
          r.member?.nickname ?? null,
          r.guest?.nickname ?? null,
        ])
      }),
      allVolunteers.filter((v) =>
        nameContains(v.member.firstName, v.member.lastName, [v.member.nickname])
      )
    )

    return { success: true, data: people.slice(0, 15) }
  } catch {
    return { success: false, error: "Search failed. Please try again." }
  }
}

export type ClusterCheckinOutcome = {
  person: ClusterCheckinPerson
  recorded: { eventId: string; eventName: string }[]
  skipped: {
    eventId: string
    eventName: string
    reason: ClusterCheckinSkipReason
  }[]
  /**
   * The registration a Collab day's breakout step would seat, or null.
   *
   * Resolved here rather than by the board because it needs the day's session map
   * (`ctx.occurrenceByEvent`), which no client has. Null for someone the day only
   * knows as a **volunteer** — they are serving, not attending, and a volunteer
   * holds no `EventRegistrant` row to seat. That falls out of the cell precedence
   * `buildClusterCheckinPeople` already applies rather than needing a rule here.
   *
   * A registrant belongs to exactly one member event — their ministry's — so there
   * is never more than one to choose between.
   */
  breakoutSubject: {
    registrantId: string
    eventId: string
    occurrenceId: string | null
  } | null
}

/**
 * Record the person's attendance across every event of the day that will take it.
 *
 * Takes a person key, never a registrant or volunteer id: the rows are re-resolved
 * from the cluster's own events, so a forged or stale key simply finds nobody.
 * Every write is idempotent, so a double tap changes nothing.
 */
export async function checkInToCluster(
  token: string,
  personKey: string
): Promise<ActionResult<ClusterCheckinOutcome>> {
  if (!personKey.trim()) return { success: false, error: "No one selected." }

  try {
    const ctx = await loadClusterCheckinContext(token)
    if (!ctx) return { success: false, error: "Event day not found." }
    if (!ctx.cluster.checkInIsOpen) {
      return { success: false, error: "Check-in is closed." }
    }
    if (ctx.eventIds.length === 0) {
      return { success: false, error: "This day has no events yet." }
    }

    const [allRegistrants, allVolunteers] = await Promise.all([
      findEventRegistrantsForLookup(ctx.eventIds),
      findEventVolunteersForLookup(ctx.eventIds),
    ])
    const people = await buildPeopleFromMatches(
      ctx,
      allRegistrants.filter((r) => registrantIdentityKey(r) === personKey),
      allVolunteers.filter((v) => `member:${v.memberId}` === personKey)
    )
    const person = people[0]
    if (!person) return { success: false, error: "We couldn't find that person." }

    const recorded: ClusterCheckinOutcome["recorded"] = []
    const skipped: ClusterCheckinOutcome["skipped"] = []

    for (const cell of person.events) {
      const reason = skipReasonFor(cell)
      if (reason !== null) {
        skipped.push({ eventId: cell.eventId, eventName: cell.eventName, reason })
        continue
      }
      await recordCheckinAttendance(
        cell.subject as { kind: "registrant" | "volunteer"; id: string },
        ctx.occurrenceByEvent.get(cell.eventId) ?? null
      )
      recorded.push({ eventId: cell.eventId, eventName: cell.eventName })
      revalidatePath(`/event/${cell.eventId}/checkin`)
    }

    revalidateClusterPaths(ctx.cluster.id)

    // Only over cells whose attendance now stands: a registration on an event the
    // day skipped isn't present, so seating them at the day's table would place
    // someone the room has no record of.
    //
    // "Now stands" rather than "was written by this tap". A cell skipped as
    // `already` is attendance too — the person is in the room, they simply got
    // there a moment earlier, whether by a double tap or by a staffer working the
    // admin board. Reading only `recorded` meant the step had exactly one chance
    // to appear and no retry: anyone already checked in went straight to the
    // welcome screen, which is also what made "undo the arrival, then check in
    // again" the only way to see it. Every other skip reason is a real absence
    // and stays out. `pickCheckinBreakout` re-checks the attendance itself, so
    // this widening cannot seat anyone the room hasn't recorded.
    const seatable = person.events.find(
      (cell) =>
        cell.subject?.kind === "registrant" &&
        (recorded.some((r) => r.eventId === cell.eventId) ||
          skipReasonFor(cell) === "already")
    )

    // Re-read so the caller's screen shows what is now true, not what was true
    // before the writes.
    return {
      success: true,
      data: {
        person: {
          ...person,
          events: person.events.map((cell) =>
            recorded.some((r) => r.eventId === cell.eventId)
              ? { ...cell, alreadyCheckedIn: true }
              : cell
          ),
        },
        recorded,
        skipped,
        breakoutSubject: seatable?.subject
          ? {
              registrantId: seatable.subject.id,
              eventId: seatable.eventId,
              occurrenceId: ctx.occurrenceByEvent.get(seatable.eventId) ?? null,
            }
          : null,
      },
    }
  } catch {
    return { success: false, error: "Failed to check in. Please try again." }
  }
}


// ─── Volunteer sign-up for the day ───────────────────────────────────────────

export type ClusterVolunteerSignUpInput = {
  memberId: string
  /** The event behind the ministry the volunteer picked — see `resolveClusterEventSelection`. */
  eventId: string
  committeeId: string
  preferredRoleId: string
  notes: string
}

/**
 * Sign someone up to serve on a Collab day.
 *
 * The mirror of `registerForCluster`, and it exists for the same reason. A
 * collab's member events are long-running ministry events, so their volunteer
 * rosters are full of people who signed up months ago for something else —
 * and the per-event form refuses a second sign-up outright ("You're already
 * registered as a volunteer for this event"), so a ministry regular had no way
 * to say they were serving *this day* and the day had no way to know. The
 * cluster workspace could only show the union of both standing rosters, which
 * answers "who has ever volunteered here", never "who is serving today".
 *
 * So the day stamps its own provenance:
 *
 *  - **No row yet** — create one, owned by the ministry's event (that is what a
 *    person volunteers under), stamped with this day.
 *  - **A row from the series** — reuse it, exactly as a registration is reused.
 *    The stamp goes on and the preferences just given replace what was there,
 *    because the committee and role the person picked are their answer for this
 *    day. `status` is deliberately left alone: an admin already confirmed them
 *    once, and silently demoting that to Pending loses a decision no one asked
 *    to revisit.
 *  - **Already stamped for this day** — nothing to do, and saying so is the
 *    honest outcome.
 *
 * Collab-only, like the cluster's Volunteers screen itself: a Parallel day's
 * events each keep their own serving team, and there is no shared roster for a
 * shared form to feed.
 */
/** The public form's wording for each refusal — it is talking to the volunteer. */
const SIGN_UP_REFUSALS: Record<ClusterVolunteerFilingFailure, string> = {
  role: "Please select a committee and role",
  member: "We couldn't find your member record.",
  already: "You've already signed up to serve on this event day.",
}

export async function submitClusterVolunteerSignUp(
  publicToken: string,
  input: ClusterVolunteerSignUpInput
): Promise<ActionResult<{ id: string; eventName: string; reused: boolean }>> {
  const { memberId, eventId, committeeId, preferredRoleId } = input
  if (!memberId) return { success: false, error: "Invalid sign-up context" }
  if (!committeeId || !preferredRoleId) {
    return { success: false, error: "Please select a committee and role" }
  }

  try {
    const cluster = await db.eventCluster.findUnique({
      where: { publicToken },
      select: {
        id: true,
        kind: true,
        volunteerIsOpen: true,
        events: {
          orderBy: { order: "asc" },
          select: { event: { select: { id: true, name: true } } },
        },
      },
    })
    if (!cluster) return { success: false, error: "Event day not found." }
    if (cluster.kind !== ClusterKind.Collab) {
      return { success: false, error: "This event day has no shared volunteer form." }
    }
    if (!cluster.volunteerIsOpen) {
      return { success: false, error: "Volunteer sign-up for this event day is closed." }
    }

    const clusterEventIds = cluster.events.map((ce) => ce.event.id)
    const selection = resolveClusterEventSelection(cluster.kind, [eventId], clusterEventIds)
    if (!selection.ok) return { success: false, error: selection.error }
    const targetEventId = selection.eventIds[0]
    const eventName =
      cluster.events.find((ce) => ce.event.id === targetEventId)?.event.name ?? ""

    const filed = await fileClusterVolunteerSignUp({
      clusterId: cluster.id,
      eventId: targetEventId,
      memberId,
      committeeId,
      preferredRoleId,
      notes: input.notes.trim() || null,
    })
    if (!filed.ok) {
      return { success: false, error: SIGN_UP_REFUSALS[filed.reason] }
    }

    revalidatePath(`/event/${targetEventId}/volunteers`)
    revalidateClusterPaths(cluster.id)
    return {
      success: true,
      data: { id: filed.id, eventName, reused: filed.reused },
    }
  } catch {
    return {
      success: false,
      error: "Failed to submit your application. Please try again.",
    }
  }
}

/**
 * Add someone to a Collab day's serving team from the day's own Volunteers
 * screen — the admin counterpart of the shared volunteer form.
 *
 * It exists because the day's roster is now `signUpClusterId`-scoped, and until
 * this action the *only* way to write that stamp was the public form. A staffer
 * filling a gap on the morning of had to open the ministry's event workspace,
 * add the volunteer there, and then watch them not appear on the day — the row
 * lands on the standing roster unstamped, which is exactly the state
 * `volunteerIsOnClusterDay` refuses. Sending an admin to the public form instead
 * would mean knowing the person's mobile number and reopening a form the day may
 * have deliberately closed.
 *
 * The ministry answer is `eventId` here rather than a ministry id, the same
 * indirection the public form uses: nothing downstream knows ministries exist,
 * and the admin picks a *label* that happens to be one.
 *
 * `volunteerIsOpen` is deliberately not consulted. That switch is the public
 * door; a closed door has never stopped an admin adding a registrant by hand,
 * and staffing gaps get filled after sign-ups close, not before.
 */
export async function createClusterVolunteer(
  clusterId: string,
  input: {
    eventId: string
    memberId: string
    committeeId: string
    preferredRoleId: string
    notes: string
  }
): Promise<ActionResult<{ id: string; eventName: string; reused: boolean }>> {
  const authError = await requireClusterWrite(clusterId)
  if (authError) return { success: false, error: authError.error }

  const { memberId, eventId, committeeId, preferredRoleId } = input
  if (!memberId) return { success: false, error: "Please choose a member." }
  if (!committeeId || !preferredRoleId) {
    return { success: false, error: "Please select a committee and role." }
  }

  try {
    const cluster = await db.eventCluster.findUnique({
      where: { id: clusterId },
      select: {
        id: true,
        kind: true,
        events: {
          orderBy: { order: "asc" },
          select: {
            event: {
              select: {
                id: true,
                name: true,
                allMinistries: true,
                ministries: { select: { ministry: { select: { name: true } } } },
              },
            },
          },
        },
      },
    })
    if (!cluster) return { success: false, error: "Event day not found." }
    if (cluster.kind !== ClusterKind.Collab) {
      return { success: false, error: "This event day has no shared serving team." }
    }

    // Same resolver the public form uses, so an event id that isn't on this day
    // is refused identically whether it came from a form post or a stale tab.
    const clusterEventIds = cluster.events.map((ce) => ce.event.id)
    const selection = resolveClusterEventSelection(cluster.kind, [eventId], clusterEventIds)
    if (!selection.ok) return { success: false, error: selection.error }
    const targetEventId = selection.eventIds[0]

    // A staff user scoped to one ministry's event must not file someone onto the
    // partner's team — `requireClusterWrite` only established they may see the
    // day at all.
    const session = await auth()
    if (!canAccessEvent(session, targetEventId)) {
      return { success: false, error: "Unauthorized." }
    }

    const target = cluster.events.find((ce) => ce.event.id === targetEventId)!.event
    const eventName = clusterEventMinistryLabel(target)

    const filed = await fileClusterVolunteerSignUp({
      clusterId: cluster.id,
      eventId: targetEventId,
      memberId,
      committeeId,
      preferredRoleId,
      notes: input.notes.trim() || null,
    })
    if (!filed.ok) {
      return { success: false, error: ADMIN_ADD_REFUSALS[filed.reason] }
    }

    revalidatePath(`/event/${targetEventId}/volunteers`)
    revalidateClusterPaths(cluster.id)
    return {
      success: true,
      data: { id: filed.id, eventName, reused: filed.reused },
    }
  } catch {
    return { success: false, error: "Failed to add volunteer." }
  }
}

/**
 * Take someone off a Collab day's serving team without touching their standing
 * roster entry — clear the stamp, keep the row.
 *
 * The undo for `createClusterVolunteer`, and the reason it can't be "delete the
 * volunteer": on a Collab the day's list and the ministry's roster are the same
 * rows seen through `signUpClusterId`, so deleting a mis-added regular would
 * erase a sign-up that predates the day, along with their confirmed status and
 * their `leaderApprovalToken`. Until this existed the only correction available
 * was exactly that destructive one, taken in the event workspace.
 *
 * Committee, role and status are left as they are. They may well have been
 * answered for this day, but they are also what the ministry's roster shows, and
 * guessing which of the two a value belonged to would be inventing history.
 * Removing someone from a date is not a statement about how they serve.
 */
export async function removeClusterVolunteerFromDay(
  clusterId: string,
  volunteerId: string
): Promise<ActionResult<void>> {
  const authError = await requireClusterWrite(clusterId)
  if (authError) return { success: false, error: authError.error }

  try {
    // Scoped to the stamp, so a volunteer id from another day — or from a
    // ministry's roster that was never on this one — matches nothing rather than
    // being silently cleared.
    const volunteer = await db.volunteer.findFirst({
      where: { id: volunteerId, signUpClusterId: clusterId },
      select: { id: true, eventId: true },
    })
    if (!volunteer) {
      return { success: false, error: "They're not on this day's serving team." }
    }

    const session = await auth()
    if (!canAccessEvent(session, volunteer.eventId)) {
      return { success: false, error: "Unauthorized." }
    }

    await db.volunteer.update({
      where: { id: volunteer.id },
      data: { signUpClusterId: null },
    })

    revalidatePath(`/event/${volunteer.eventId}/volunteers`)
    revalidateClusterPaths(clusterId)
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to remove volunteer from this day." }
  }
}

/** The admin screen's wording — it is talking *about* the volunteer, not to them. */
const ADMIN_ADD_REFUSALS: Record<ClusterVolunteerFilingFailure, string> = {
  role: "Please select a committee and role.",
  member: "That member no longer exists.",
  already: "They're already on this day's serving team.",
}
