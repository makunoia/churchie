import type { EventType } from "@/app/generated/prisma/client"

/**
 * What undoing a person's arrival has to write, per member event.
 *
 * The mirror of {@link import("./checkin-toggle").planClusterCheckinToggle}, and
 * built the same way for the same reason: the read side already decides which
 * session a cluster day stands for, and the write must replay that decision
 * rather than re-derive it and drift. Both take `resolveClusterCheckinTargets`'
 * own output as their input.
 *
 * A check-in lives in one of two shapes — `attendedAt` on a OneTime row, an
 * `OccurrenceAttendee` for a session event — so the day's remover has to dispatch
 * on the event the way `recordCheckinAttendance` does going the other way. A
 * remover that knew only one shape would silently no-op on the other, which on a
 * monitoring board reads as the button being broken.
 *
 * Pure, so the rules below are testable without a database.
 */

/** The row a check-in was recorded against — a registration, or a shift. */
export type ClusterCheckinSubject = {
  kind: "registrant" | "volunteer"
  id: string
}

export type ClusterCheckinRemovalOp =
  /** OneTime: clear `attendedAt` on the registrant or volunteer row. */
  | {
      kind: "attendedAt"
      eventId: string
      eventName: string
      subject: ClusterCheckinSubject
    }
  /** Session event: delete this day's `OccurrenceAttendee`. */
  | {
      kind: "occurrence"
      eventId: string
      eventName: string
      occurrenceId: string
      subject: ClusterCheckinSubject
    }
  /** Nothing to write, and why. */
  | {
      kind: "skip"
      eventId: string
      eventName: string
      reason: ClusterCheckinRemovalSkipCause
    }

export type ClusterCheckinRemovalSkipCause =
  /** They never arrived on this event — there is no record to undo. */
  | "notIn"
  /**
   * A session event whose day names no session. The board still reads them as
   * checked in (a dateless cluster reads *every* session's attendance), but the
   * day cannot say which sitting that was, and clearing the lot would erase a
   * history nobody asked about. Sent to the session's own screen instead.
   */
  | "noSession"

export type ClusterCheckinRemovalTarget = {
  shortcut: { eventId: string; eventName: string; eventType: EventType }
  occurrenceId: string | null
}

/** One of the person's rows, as the day's roll-up returns it. */
export type ClusterCheckinRemovalRow = {
  id: string
  eventId: string
  kind: "Registrant" | "Volunteer"
  checkedIn: boolean
}

export function planClusterCheckinRemoval(
  targets: ClusterCheckinRemovalTarget[],
  rows: ClusterCheckinRemovalRow[]
): ClusterCheckinRemovalOp[] {
  const ops: ClusterCheckinRemovalOp[] = []

  for (const { shortcut, occurrenceId } of targets) {
    const base = { eventId: shortcut.eventId, eventName: shortcut.eventName }
    // A person can hold two rows on one event — a duplicate sign-up, or a
    // volunteer who also registered — and the board collapses them into one
    // cell. Undoing that cell has to undo every row behind it, or the cell comes
    // back checked in on the next read.
    const onEvent = rows.filter((r) => r.eventId === shortcut.eventId)
    if (onEvent.length === 0) continue

    const arrived = onEvent.filter((r) => r.checkedIn)
    if (arrived.length === 0) {
      ops.push({ kind: "skip", ...base, reason: "notIn" })
      continue
    }

    if (shortcut.eventType !== "OneTime" && !occurrenceId) {
      ops.push({ kind: "skip", ...base, reason: "noSession" })
      continue
    }

    for (const row of arrived) {
      const subject: ClusterCheckinSubject = {
        kind: row.kind === "Volunteer" ? "volunteer" : "registrant",
        id: row.id,
      }
      ops.push(
        shortcut.eventType === "OneTime"
          ? { kind: "attendedAt", ...base, subject }
          : { kind: "occurrence", ...base, occurrenceId: occurrenceId!, subject }
      )
    }
  }

  return ops
}

/** The events an admin is about to clear — what the confirm dialog names. */
export function clusterCheckinRemovalEvents(
  ops: ClusterCheckinRemovalOp[]
): { eventId: string; eventName: string }[] {
  const seen = new Map<string, string>()
  for (const op of ops) {
    if (op.kind === "skip") continue
    seen.set(op.eventId, op.eventName)
  }
  return [...seen].map(([eventId, eventName]) => ({ eventId, eventName }))
}

/** Admin-facing reason an event was passed over, for the action's toast. */
export function clusterCheckinRemovalSkipHint(
  reason: ClusterCheckinRemovalSkipCause
): string {
  return reason === "notIn"
    ? "had no arrival to undo"
    : "has no session for this day — undo it on the session's own screen"
}
