import type { Prisma } from "@/app/generated/prisma/client"
import { ClusterKind } from "@/app/generated/prisma/client"
import { anyOwner } from "@/lib/breakouts/owner"
import { resolvePoolScope, type PoolScope } from "@/lib/events/pool-scope"

/**
 * Which breakout tables an event's Catch Mech follows up on.
 *
 * Catch Mech is an EVENT-level feature and stays one — there is deliberately no
 * cluster-level Catch Mech. Two kinds of table can owe this event a follow-up,
 * and it needs **both**:
 *
 *  1. **Its own standing tables.** Every table the event has ever run, and every
 *     confirmation, decline and submission recorded against them. This is the
 *     event's history and belongs to the event permanently.
 *  2. **The day's tables it staffs.** Under a Collab the session's tables belong
 *     to the cluster, so an `eventId` filter alone would miss the very tables
 *     people sat at today.
 *
 * The bridge for (2) is the facilitator. `Volunteer.eventId` is required, so
 * whoever runs a table belongs to exactly one member event, and that is the
 * ministry the table's follow-up is endorsed to. A table staffed from two
 * ministries shows up on both — which needs no special handling, because
 * `resolveCatchMechTargets` already gives the linked DGroup only to the lead and
 * sends anyone else to their own groups, and `hidesPerson` already scopes
 * decisions per facilitator. Substitutes count too: they can submit for a table,
 * so their ministry's admin has to be able to see it.
 *
 * ## Why this is a union and not a switch
 *
 * The Collab branch used to *replace* (1) with (2) — `{ clusterId, OR: [...] }`
 * with no `eventId` term at all. Every Catch Mech read filters on
 * `breakoutGroupId IN <this scope>`, so the moment an event joined a Collab its
 * whole Catch Mech history fell outside the filter and every screen went blank:
 * the dashboard counts, the Pending/Confirmed/Rejected lists, the submissions
 * log. Nothing was deleted — it was unreachable, and the only way back was to
 * take the event out of the cluster. An event's follow-up record is not a
 * property of which day it is on.
 *
 * Outside a Collab both halves collapse to `{ eventId }` — exactly what every
 * Catch Mech query did before this module existed.
 */
export type CatchMechScope = {
  /**
   * Filter for the breakout tables whose follow-up belongs to this event.
   * Combine with `AND` rather than spreading — under a Collab this is itself an
   * `OR`, and two `OR` keys in one object silently overwrite each other.
   */
  where: Prisma.BreakoutGroupWhereInput
  /**
   * Every table someone here could be sitting at, endorsed to this event or not.
   * Wider than `where`: use it to ask "who is seated nowhere", where a person at
   * another ministry's table on the same day is seated, not unseated.
   */
  seatedWhere: Prisma.BreakoutGroupWhereInput
  /** True when the day's cluster-owned tables are part of the scope. */
  viaCluster: boolean
  clusterId: string | null
  clusterName: string | null
}

/**
 * Pure derivation — exported so the branch can be unit-tested without a database.
 */
export function catchMechScopeFor(scope: PoolScope): CatchMechScope {
  const own = scope.breakoutOwner
  const day = scope.clusterBreakoutOwner

  if (scope.kind !== ClusterKind.Collab || !scope.clusterId || !day) {
    return {
      where: anyOwner([own]),
      seatedWhere: anyOwner([own]),
      viaCluster: false,
      clusterId: scope.clusterId,
      clusterName: scope.clusterName,
    }
  }

  const eventId = scope.eventId
  return {
    where: {
      OR: [
        own,
        {
          ...day,
          OR: [
            { facilitator: { eventId } },
            { coFacilitator: { eventId } },
            { subFacilitators: { some: { substitute: { eventId } } } },
          ],
        },
      ],
    },
    seatedWhere: anyOwner([own, day]),
    viaCluster: true,
    clusterId: scope.clusterId,
    clusterName: scope.clusterName,
  }
}

export async function resolveCatchMechScope(eventId: string): Promise<CatchMechScope> {
  return catchMechScopeFor(await resolvePoolScope(eventId))
}
