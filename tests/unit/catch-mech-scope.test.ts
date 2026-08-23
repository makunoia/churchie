import { describe, expect, it } from "vitest"
import { ClusterKind } from "@/app/generated/prisma/client"
import { catchMechScopeFor } from "@/lib/catch-mech/scope"
import { staffVolunteerFor } from "@/lib/catch-mech/faci-session"
import type { PoolScope } from "@/lib/events/pool-scope"

/**
 * Catch Mech stays an event-level feature, and it needs BOTH kinds of table: the
 * event's own standing set — where its whole follow-up history lives — and the
 * cluster-owned tables it staffs on a Collab day. The bridge for the second is
 * the facilitator: `Volunteer.eventId` is required, so whoever runs a table
 * belongs to exactly one ministry event.
 *
 * The regression these tests pin: the Collab branch used to *replace* the event's
 * own tables with the day's, so joining a cluster silently emptied every Catch
 * Mech screen the event had.
 */
function poolScope(overrides: Partial<PoolScope> = {}): PoolScope {
  return {
    eventId: "event-a",
    clusterId: null,
    clusterName: null,
    kind: null,
    volunteerEventIds: ["event-a"],
    breakoutOwner: { eventId: "event-a" },
    clusterBreakoutOwner: null,
    candidateEventIds: ["event-a"],
    ...overrides,
  }
}

const COLLAB_ENDORSEMENT = {
  clusterId: "cluster-1",
  OR: [
    { facilitator: { eventId: "event-a" } },
    { coFacilitator: { eventId: "event-a" } },
    { subFacilitators: { some: { substitute: { eventId: "event-a" } } } },
  ],
}

describe("catchMechScopeFor", () => {
  it("scopes a plain event to its own tables", () => {
    const scope = catchMechScopeFor(poolScope())

    expect(scope.where).toEqual({ eventId: "event-a" })
    expect(scope.seatedWhere).toEqual({ eventId: "event-a" })
    expect(scope.viaCluster).toBe(false)
  })

  it("treats a Parallel cluster exactly like no cluster", () => {
    // A Parallel day is several independent events sharing a date; each still
    // runs its own tables.
    const scope = catchMechScopeFor(
      poolScope({
        kind: ClusterKind.Parallel,
        clusterId: "cluster-1",
        clusterName: "Sunday",
      })
    )

    expect(scope.where).toEqual({ eventId: "event-a" })
    expect(scope.seatedWhere).toEqual({ eventId: "event-a" })
    expect(scope.viaCluster).toBe(false)
  })

  it("keeps the event's own tables AND endorses the day's through its staff", () => {
    const scope = catchMechScopeFor(
      poolScope({
        kind: ClusterKind.Collab,
        clusterId: "cluster-1",
        clusterName: "Youth x Singles",
        volunteerEventIds: ["event-a", "event-b"],
        clusterBreakoutOwner: { clusterId: "cluster-1" },
        candidateEventIds: ["event-a", "event-b"],
      })
    )

    expect(scope.viaCluster).toBe(true)
    expect(scope.clusterName).toBe("Youth x Singles")
    expect(scope.where).toEqual({
      OR: [{ eventId: "event-a" }, COLLAB_ENDORSEMENT],
    })
  })

  it("REGRESSION: a Collab never drops the event's own tables from scope", () => {
    // The bug this replaces: `where` was `{ clusterId, OR: [...] }` with no
    // eventId term, so every Catch Mech read — which filters on
    // `breakoutGroupId IN <scope>` — lost the event's entire history the moment
    // it joined a collab. Nothing was deleted; it was unreachable.
    const scope = catchMechScopeFor(
      poolScope({
        kind: ClusterKind.Collab,
        clusterId: "cluster-1",
        clusterName: "Youth x Singles",
        clusterBreakoutOwner: { clusterId: "cluster-1" },
      })
    )

    expect(scope.where.OR).toContainEqual({ eventId: "event-a" })
  })

  it("counts a seat at ANY of the day's tables as seated", () => {
    // `seatedWhere` answers "who is sitting nowhere", so it spans the whole day —
    // including tables endorsed to the partner ministry. The narrower `where`
    // would report someone at their table as unseated.
    const scope = catchMechScopeFor(
      poolScope({
        kind: ClusterKind.Collab,
        clusterId: "cluster-1",
        clusterName: "Youth x Singles",
        clusterBreakoutOwner: { clusterId: "cluster-1" },
      })
    )

    expect(scope.seatedWhere).toEqual({
      OR: [{ eventId: "event-a" }, { clusterId: "cluster-1" }],
    })
  })
})

describe("staffVolunteerFor", () => {
  const lead = { id: "v-lead", memberId: "m1" }
  const co = { id: "v-co", memberId: "m2" }
  const sub = { id: "v-sub", memberId: "m3" }
  const group = { facilitator: lead, coFacilitator: co, subFacilitators: [{ substitute: sub }] }

  it("resolves each role to its own volunteer row", () => {
    expect(staffVolunteerFor(group, "m1")).toEqual(lead)
    expect(staffVolunteerFor(group, "m2")).toEqual(co)
    expect(staffVolunteerFor(group, "m3")).toEqual(sub)
  })

  it("returns null for someone who staffs nothing", () => {
    expect(staffVolunteerFor(group, "m9")).toBeNull()
  })

  it("prefers the lead role when one person holds two", () => {
    // The lead owns the table's linked DGroup in resolveCatchMechTargets, so
    // someone substituting on a table they also lead must act as the lead.
    const doubled = {
      facilitator: lead,
      coFacilitator: null,
      subFacilitators: [{ substitute: { id: "v-sub2", memberId: "m1" } }],
    }
    expect(staffVolunteerFor(doubled, "m1")).toEqual(lead)
  })

  it("does not match a table with no staff at all", () => {
    expect(
      staffVolunteerFor({ facilitator: null, coFacilitator: null, subFacilitators: [] }, "m1")
    ).toBeNull()
  })
})
