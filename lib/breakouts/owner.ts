import type { Prisma } from "@/app/generated/prisma/client"

/**
 * Who owns a breakout group (CCF-148).
 *
 * A breakout group belongs to exactly one of two things:
 *
 *  - an **event**, for a standing table that persists across that event's
 *    occurrences — every group that existed before Collab clusters;
 *  - a **cluster**, for a table set up for one Collab day. A collab's tables
 *    belong to the day rather than to either ministry's event, which is what
 *    lets the day's seating be arranged from scratch without rewriting either
 *    ministry's standing rosters.
 *
 * Spelled as a Prisma where-fragment because that is how it is used: nearly
 * every breakout query scoped on a bare `eventId`, and each of those becomes
 * `...owner` instead. The two shapes are structurally exclusive, so a caller
 * cannot accidentally pass both.
 *
 * Pure and free of `server-only` on purpose — the scope resolver
 * (`lib/events/pool-scope.ts`) is DB-aware and imports from here, and the client
 * components that pass an owner down to a server action need the type.
 */
export type BreakoutOwner = { eventId: string } | { clusterId: string }

export function eventOwner(eventId: string): BreakoutOwner {
  return { eventId }
}

export function clusterOwner(clusterId: string): BreakoutOwner {
  return { clusterId }
}

/**
 * What a breakout UI needs to know about where it is standing: who owns the
 * tables it is editing, and which workspace to build links against.
 *
 * The two used to be one thing — an `eventId` prop that scoped the server
 * actions *and* built `/event/<id>/…` hrefs. They separate under CCF-148: the
 * same table components render inside the event workspace and inside a cluster's,
 * so the route base is no longer derivable from the owner's id alone.
 */
export type BreakoutSurface = {
  owner: BreakoutOwner
  /** Workspace route base — `/event/<id>` or `/cluster/<id>`. No trailing slash. */
  basePath: string
}

export function eventSurface(eventId: string): BreakoutSurface {
  return { owner: { eventId }, basePath: `/event/${eventId}` }
}

export function clusterSurface(clusterId: string): BreakoutSurface {
  return { owner: { clusterId }, basePath: `/cluster/${clusterId}` }
}

/**
 * The surface for an owner already in hand — what a caller that resolved a
 * `PoolScope` wants, rather than re-deciding which of the two constructors to
 * call and getting the route base wrong for a cluster-owned table.
 */
export function surfaceFor(owner: BreakoutOwner): BreakoutSurface {
  return isClusterOwner(owner)
    ? clusterSurface(owner.clusterId)
    : eventSurface(owner.eventId)
}

export function isClusterOwner(
  owner: BreakoutOwner
): owner is { clusterId: string } {
  return "clusterId" in owner
}

/**
 * Match a group belonging to ANY of several owners.
 *
 * Most queries take one owner, because most surfaces address one set of tables.
 * Two do not, and both sit inside a Collab day: an event's Catch Mech follows up
 * on its own standing tables *and* on the day's tables it staffs, and a session
 * of a member event may need a stand-in for either. Spelled here rather than
 * inline at those call sites so "a group in one of these sets" has one shape.
 *
 * A single owner collapses to that owner rather than to a one-armed `OR`, so the
 * common case produces exactly the `where` it always did.
 */
export function anyOwner(
  owners: readonly BreakoutOwner[]
): Prisma.BreakoutGroupWhereInput {
  if (owners.length === 1) return { ...owners[0] }
  return { OR: owners.map((o) => ({ ...o })) }
}

/**
 * Which of the two sets a surface is filling.
 *
 * On a Collab day an event's own standing tables and the day's cluster-owned ones
 * are both in play, and the *surface* decides which — an event's own registration
 * form and kiosk fill the event's set, the day's shared form and kiosk fill the
 * day's. The event id alone cannot answer it, because both answers are valid for
 * the same event.
 *
 * Deliberately a two-value literal rather than a {@link BreakoutOwner}. These
 * choices are made on public, unauthenticated routes and travel from a client
 * component to a server action, so an owner would be a caller-supplied *id* —
 * forgeable into another day's tables. A caller can only name one of the two sets
 * that `resolvePoolScope` already derived server-side for their own event, and a
 * person registered on that event is entitled to both, so nothing is escalated.
 *
 * `"cluster"` degrades to the event's set wherever no cluster set exists — a
 * Parallel day, or no cluster at all — rather than erroring.
 */
export type BreakoutSet = "event" | "cluster"

/** The owning event id, or null when a cluster owns the group. */
export function ownerEventId(owner: BreakoutOwner): string | null {
  return isClusterOwner(owner) ? null : owner.eventId
}

/** The owning cluster id, or null when an event owns the group. */
export function ownerClusterId(owner: BreakoutOwner): string | null {
  return isClusterOwner(owner) ? owner.clusterId : null
}

/**
 * The XOR the schema keeps nullable on both sides — mirrors
 * `isValidFormConfigOwner` in `lib/validations/event-cluster.ts`, which does
 * exactly this for `EventFormConfig`. Both set, or neither, is a programming
 * error rather than user input.
 */
export function isValidBreakoutOwner(
  eventId: string | null | undefined,
  clusterId: string | null | undefined
): boolean {
  return Boolean(eventId) !== Boolean(clusterId)
}

/** Turn a persisted row's two nullable columns back into an owner. */
export function ownerOf(row: {
  eventId: string | null
  clusterId: string | null
}): BreakoutOwner | null {
  if (!isValidBreakoutOwner(row.eventId, row.clusterId)) return null
  return row.clusterId ? { clusterId: row.clusterId } : { eventId: row.eventId! }
}

/**
 * Select fragment for both owner names, so the call sites that only want a
 * display label don't each invent their own include.
 */
export const BREAKOUT_OWNER_NAME_SELECT = {
  event: { select: { name: true } },
  cluster: { select: { name: true } },
} as const satisfies Prisma.BreakoutGroupSelect

/**
 * The occasion a breakout group belongs to, for display: the event's name, or
 * the name of the collab day that owns it.
 *
 * Shared rather than inlined because four unrelated surfaces read this label —
 * the guest detail page, the leader confirmation flow, the DGroup request
 * description and the small-groups import — and a group with no event used to be
 * impossible, so each of them dereferenced `event.name` directly.
 */
export function breakoutOccasionName(group: {
  event?: { name: string } | null
  cluster?: { name: string } | null
}): string | null {
  return group.event?.name ?? group.cluster?.name ?? null
}
