"use server"

import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { resolvePoolScope, type PoolScope } from "@/lib/events/pool-scope"
import { requireBreakoutWrite } from "@/lib/events/require-event-write"
import { anyOwner, isClusterOwner, ownerOf, type BreakoutOwner } from "@/lib/breakouts/owner"
import { FacilitatorRole } from "@/app/generated/prisma/client"

type ActionResult = { success: true } | { success: false; error: string }

/**
 * Standing in for a table's facilitator at one sitting.
 *
 * `OccurrenceSubFacilitator` is keyed by `[occurrenceId, breakoutGroupId, role]`
 * and carries no event of its own, so the row could always name a cluster-owned
 * table. What could not was the screen that writes it: the session page listed
 * tables with a bare `eventId`, so on a Collab day it offered the member event's
 * standing tables and none of the day's own.
 *
 * The table in play is now **either** set — the event's own standing tables, which
 * it keeps whether or not it shares a day, or the day's cluster-owned ones. A
 * sitting can need a stand-in at either, and a scope naming only one leaves the
 * other unstaffable. Which set a table came from still decides who may write it:
 * permission is checked against the table's OWN owner, resolved from the row
 * rather than assumed from the session.
 *
 * These two actions also had **no guard of any kind**: no `auth()`, no
 * permission check, and no verification that the three caller-supplied ids
 * belonged together. A server action is a POST endpoint that carries its own
 * arguments, so anyone who could reach it could staff any table of any event
 * with any volunteer. Their sibling `attendee-actions.ts` says exactly this in
 * its own comment; this file simply never followed it.
 */

/** The occurrence, the day's table owner, and who may staff those tables. */
async function resolveSessionScope(occurrenceId: string) {
  const occurrence = await db.eventOccurrence.findUnique({
    where: { id: occurrenceId },
    select: { id: true, eventId: true },
  })
  if (!occurrence) return null
  const scope = await resolvePoolScope(occurrence.eventId)
  return { occurrence, scope }
}

/** The only two fields of a `PoolScope` the helpers below need. */
type SessionScope = Pick<PoolScope, "breakoutOwner" | "clusterBreakoutOwner">

/** Both sets of tables a sitting of this event may run. */
function tablesInPlay(scope: SessionScope) {
  return anyOwner(
    scope.clusterBreakoutOwner
      ? [scope.breakoutOwner, scope.clusterBreakoutOwner]
      : [scope.breakoutOwner]
  )
}

/**
 * Refuse a table that isn't in play, and report who owns the one that is.
 *
 * The scope comparison is the same one `pickedIsInPlay` makes on the public
 * pickers: a table from another event, or from another day, is not made eligible
 * by naming this occurrence alongside it. Returning the owner rather than a
 * boolean is what lets the caller check permission against the table actually
 * being written — a cluster-owned table is the day's to staff even though the
 * occurrence belongs to the member event.
 */
async function resolveTableOwner(
  breakoutGroupId: string,
  scope: SessionScope,
): Promise<BreakoutOwner | null> {
  const group = await db.breakoutGroup.findFirst({
    where: { id: breakoutGroupId, ...tablesInPlay(scope) },
    select: { eventId: true, clusterId: true },
  })
  return group ? ownerOf(group) : null
}

/**
 * The table in play plus its owner's write permission.
 *
 * The session belongs to this event, so the event's own write permission is the
 * floor for touching any of its sittings. A cluster-owned table adds the day's
 * permission on top, because that table is the day's.
 */
async function authorizeTable(
  breakoutGroupId: string,
  scope: SessionScope,
): Promise<{ owner: BreakoutOwner } | { error: string }> {
  const denied = await requireBreakoutWrite(scope.breakoutOwner)
  if (denied) return { error: denied.error }

  const owner = await resolveTableOwner(breakoutGroupId, scope)
  if (!owner) return { error: "That breakout group isn't part of this session." }

  if (isClusterOwner(owner)) {
    const clusterDenied = await requireBreakoutWrite(owner)
    if (clusterDenied) return { error: clusterDenied.error }
  }
  return { owner }
}

export async function assignSubFacilitator(
  occurrenceId: string,
  breakoutGroupId: string,
  role: FacilitatorRole,
  substituteId: string,
): Promise<ActionResult> {
  try {
    const resolved = await resolveSessionScope(occurrenceId)
    if (!resolved) return { success: false, error: "Occurrence not found." }
    const { occurrence, scope } = resolved

    const authorized = await authorizeTable(breakoutGroupId, scope)
    if ("error" in authorized) return { success: false, error: authorized.error }
    const tableOwner = authorized.owner

    // A substitute comes from the roster that staffs these tables — one event's
    // under an ordinary event, either ministry's under a Collab, since a
    // cluster-owned table can be staffed from either.
    const substitute = await db.volunteer.findFirst({
      where: { id: substituteId, eventId: { in: scope.volunteerEventIds } },
      select: { id: true },
    })
    if (!substitute) {
      return { success: false, error: "That volunteer isn't serving on this day." }
    }

    await db.occurrenceSubFacilitator.upsert({
      where: { occurrenceId_breakoutGroupId_role: { occurrenceId, breakoutGroupId, role } },
      create: { occurrenceId, breakoutGroupId, role, substituteId },
      update: { substituteId },
    })

    revalidateSessionSurfaces(occurrence.eventId, occurrenceId, tableOwner)
    return { success: true }
  } catch {
    return { success: false, error: "Failed to assign sub-facilitator." }
  }
}

/**
 * The event id is no longer a parameter: it was caller-supplied and used only to
 * build the revalidate path, which meant an argument nobody checked could aim a
 * cache invalidation at any event. It is derived from the occurrence instead.
 */
export async function removeSubFacilitator(
  occurrenceId: string,
  breakoutGroupId: string,
  role: FacilitatorRole,
): Promise<ActionResult> {
  try {
    const resolved = await resolveSessionScope(occurrenceId)
    if (!resolved) return { success: false, error: "Occurrence not found." }
    const { occurrence, scope } = resolved

    const authorized = await authorizeTable(breakoutGroupId, scope)
    if ("error" in authorized) return { success: false, error: authorized.error }
    const tableOwner = authorized.owner

    await db.occurrenceSubFacilitator.deleteMany({
      where: { occurrenceId, breakoutGroupId, role },
    })

    revalidateSessionSurfaces(occurrence.eventId, occurrenceId, tableOwner)
    return { success: true }
  } catch {
    return { success: false, error: "Failed to remove sub-facilitator." }
  }
}

/**
 * The session screen is where the change shows, but a cluster-owned table is
 * also listed on the day's own Breakouts page — and Catch Mech reads
 * `subFacilitators` to decide who may answer for a table.
 */
function revalidateSessionSurfaces(
  eventId: string,
  occurrenceId: string,
  owner: BreakoutOwner,
) {
  revalidatePath(`/event/${eventId}/sessions/${occurrenceId}`)
  revalidatePath(`/event/${eventId}/catch-mech`)
  if (isClusterOwner(owner)) revalidatePath(`/cluster/${owner.clusterId}/breakouts`)
  else revalidatePath(`/event/${eventId}/breakouts`)
}
