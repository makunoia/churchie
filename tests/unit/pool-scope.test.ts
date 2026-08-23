import { describe, expect, it } from "vitest"

import {
  breakoutOwnerFor,
  clusterBreakoutOwnerFor,
  isPooled,
  poolEventIdsFor,
  poolScopeFor,
  type ClusterLink,
} from "@/lib/events/pool-scope"
import {
  breakoutOccasionName,
  isValidBreakoutOwner,
  ownerOf,
} from "@/lib/breakouts/owner"

/**
 * The pure half of CCF-148's pool scope.
 *
 * The load-bearing assertion in here is the negative one: a Parallel cluster must
 * resolve to *exactly* what no cluster at all resolves to. Every widened query in
 * the app relies on that equivalence to be a no-op outside a collab, so if these
 * two ever diverge, the blast radius is every event in the system rather than just
 * clusters.
 */

const YOUTH = "evt-youth"
const SINGLES = "evt-singles"

function link(kind: "Parallel" | "Collab"): ClusterLink {
  return {
    clusterId: "clu-1",
    clusterName: "Youth × Singles Night",
    kind,
    memberEventIds: [YOUTH, SINGLES],
  }
}

describe("poolEventIdsFor", () => {
  it("is the event alone when there is no cluster", () => {
    expect(poolEventIdsFor(YOUTH, null)).toEqual([YOUTH])
  })

  it("is the event alone for a Parallel day — identical to no cluster", () => {
    expect(poolEventIdsFor(YOUTH, link("Parallel"))).toEqual(poolEventIdsFor(YOUTH, null))
  })

  it("is every member event for a Collab day", () => {
    expect(poolEventIdsFor(YOUTH, link("Collab"))).toEqual([YOUTH, SINGLES])
  })

  it("still includes the asked-about event if a malformed link omits it", () => {
    const broken: ClusterLink = { ...link("Collab"), memberEventIds: [SINGLES] }
    expect(poolEventIdsFor(YOUTH, broken)).toContain(YOUTH)
  })

  it("handles a collab with a single member event", () => {
    const solo: ClusterLink = { ...link("Collab"), memberEventIds: [YOUTH] }
    expect(poolEventIdsFor(YOUTH, solo)).toEqual([YOUTH])
  })
})

describe("breakoutOwnerFor", () => {
  it("always hands back the event — an event keeps its own pool", () => {
    expect(breakoutOwnerFor(YOUTH, null)).toEqual({ eventId: YOUTH })
    expect(breakoutOwnerFor(YOUTH, link("Parallel"))).toEqual({ eventId: YOUTH })
    // The reversal: a Collab used to substitute the cluster here, which took the
    // event's tables — and its whole Catch Mech history — off every event screen.
    expect(breakoutOwnerFor(YOUTH, link("Collab"))).toEqual({ eventId: YOUTH })
  })
})

describe("clusterBreakoutOwnerFor", () => {
  it("names the day's own set only on a Collab", () => {
    expect(clusterBreakoutOwnerFor(null)).toBeNull()
    expect(clusterBreakoutOwnerFor(link("Parallel"))).toBeNull()
    expect(clusterBreakoutOwnerFor(link("Collab"))).toEqual({ clusterId: "clu-1" })
  })
})

describe("isPooled", () => {
  it("is true only for Collab", () => {
    expect(isPooled(null)).toBe(false)
    expect(isPooled(link("Parallel"))).toBe(false)
    expect(isPooled(link("Collab"))).toBe(true)
  })
})

describe("poolScopeFor", () => {
  it("degenerates to the single event outside a collab", () => {
    const scope = poolScopeFor(YOUTH, link("Parallel"))
    expect(scope.volunteerEventIds).toEqual([YOUTH])
    expect(scope.candidateEventIds).toEqual([YOUTH])
    expect(scope.breakoutOwner).toEqual({ eventId: YOUTH })
    expect(scope.clusterBreakoutOwner).toBeNull()
    expect(scope.kind).toBe("Parallel")
  })

  it("carries both table sets on a collab, neither replacing the other", () => {
    const scope = poolScopeFor(YOUTH, link("Collab"))
    // The event keeps its own standing tables…
    expect(scope.breakoutOwner).toEqual({ eventId: YOUTH })
    // …and the day's fresh set is named beside them rather than in place of them.
    expect(scope.clusterBreakoutOwner).toEqual({ clusterId: "clu-1" })
    // Volunteers still pool as one roster; that half is unchanged.
    expect(scope.candidateEventIds).toEqual([YOUTH, SINGLES])
    expect(scope.volunteerEventIds).toEqual([YOUTH, SINGLES])
    expect(scope.clusterName).toBe("Youth × Singles Night")
  })
})

describe("isValidBreakoutOwner", () => {
  it("accepts exactly one side", () => {
    expect(isValidBreakoutOwner("e1", null)).toBe(true)
    expect(isValidBreakoutOwner(null, "c1")).toBe(true)
  })

  it("rejects both and neither", () => {
    expect(isValidBreakoutOwner("e1", "c1")).toBe(false)
    expect(isValidBreakoutOwner(null, null)).toBe(false)
    expect(isValidBreakoutOwner(undefined, undefined)).toBe(false)
  })
})

describe("ownerOf", () => {
  it("reads a persisted row back into an owner", () => {
    expect(ownerOf({ eventId: "e1", clusterId: null })).toEqual({ eventId: "e1" })
    expect(ownerOf({ eventId: null, clusterId: "c1" })).toEqual({ clusterId: "c1" })
  })

  it("is null when the XOR is violated", () => {
    expect(ownerOf({ eventId: "e1", clusterId: "c1" })).toBeNull()
    expect(ownerOf({ eventId: null, clusterId: null })).toBeNull()
  })
})

describe("breakoutOccasionName", () => {
  it("prefers the event, falls back to the cluster", () => {
    expect(breakoutOccasionName({ event: { name: "Youth Night" }, cluster: null }))
      .toBe("Youth Night")
    expect(breakoutOccasionName({ event: null, cluster: { name: "Collab Day" } }))
      .toBe("Collab Day")
  })

  it("is null rather than throwing when neither is loaded", () => {
    expect(breakoutOccasionName({})).toBeNull()
    expect(breakoutOccasionName({ event: null, cluster: null })).toBeNull()
  })
})
