import { describe, it, expect, beforeEach, afterAll } from "vitest"
import type { Session } from "next-auth"
import { db } from "@/lib/db"
import { createRegistrant } from "@/app/(dashboard)/events/actions"
import {
  addEventToCluster,
  registerForCluster,
} from "@/app/(dashboard)/events/cluster-actions"
import { enableModule, setPricedModule } from "@/app/(dashboard)/events/module-actions"
import {
  isValidFormConfigOwner,
  validateClusterEventSelection,
} from "@/lib/validations/event-cluster"
import { buildClusterRoster, personKeyFor } from "@/lib/clusters/roster"
import { getClusterOverview } from "@/lib/clusters/aggregate"

/**
 * CCF-132 — Event Clusters: shared registration fan-out + aggregated workspace.
 *
 *  - unit:        form-config owner XOR, event-selection validation, roster matrix
 *  - integration: one submit → N registrants with the person resolved ONCE (no
 *                 duplicate Guests, no repeated member writes); partial success
 *                 (closed / already / volunteer per event); cluster-config
 *                 sanitize enforcement; walk-in OneTime-only check-in;
 *                 paid/second-cluster guards; access-scoped roll-up
 *  - regression:  single-event createRegistrant behavior unchanged (registrationClusterId
 *                 stays null; the pre-existing suites pin the rest)
 *  - e2e:         skipped here — the browser flow is exercised manually; unit +
 *                 integration cover the write path end to end.
 */

beforeEach(async () => {
  await db.$executeRaw`TRUNCATE
    "OccurrenceAttendee", "EventOccurrence", "BreakoutGroupMember", "BreakoutGroup",
    "Volunteer", "CommitteeRole", "VolunteerCommittee",
    "EventRegistrant", "EventFormConfig", "EventClusterEvent", "EventCluster",
    "Event", "Guest", "Member", "SchedulePreference"
    RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

const PHONE = "0917 123 4567"
const CANONICAL_PHONE = "+63 917 123 4567"

function payload(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Juan",
    lastName: "dela Cruz",
    mobileNumber: PHONE,
    ...overrides,
  }
}

async function seedEvent(
  name: string,
  overrides: Partial<Parameters<typeof db.event.create>[0]["data"]> = {}
) {
  return db.event.create({
    data: {
      name,
      type: "OneTime",
      startDate: new Date(),
      endDate: new Date(),
      ...overrides,
    },
    select: { id: true },
  })
}

async function seedCluster(eventIds: string[], overrides: Record<string, unknown> = {}) {
  return db.eventCluster.create({
    data: {
      name: "Super Sunday",
      isOpen: true,
      events: { create: eventIds.map((eventId, order) => ({ eventId, order })) },
      ...overrides,
    },
    select: { id: true, publicToken: true },
  })
}

// ─── Unit ────────────────────────────────────────────────────────────────────

describe("unit — EventFormConfig owner XOR", () => {
  it("accepts exactly one owner", () => {
    expect(isValidFormConfigOwner("evt", null)).toBe(true)
    expect(isValidFormConfigOwner(null, "cluster")).toBe(true)
  })

  it("rejects both or neither", () => {
    expect(isValidFormConfigOwner("evt", "cluster")).toBe(false)
    expect(isValidFormConfigOwner(null, null)).toBe(false)
    expect(isValidFormConfigOwner(undefined, "")).toBe(false)
  })
})

describe("unit — event selection validation", () => {
  const clusterEvents = ["a", "b", "c"]

  it("requires at least one event", () => {
    const result = validateClusterEventSelection([], clusterEvents)
    expect(result.ok).toBe(false)
  })

  it("rejects events outside the cluster", () => {
    const result = validateClusterEventSelection(["a", "zzz"], clusterEvents)
    expect(result.ok).toBe(false)
  })

  it("dedupes and preserves the cluster's display order", () => {
    const result = validateClusterEventSelection(["c", "a", "c"], clusterEvents)
    expect(result).toEqual({ ok: true, eventIds: ["a", "c"] })
  })
})

describe("unit — roster matrix builder", () => {
  const events = [
    { id: "e1", name: "Service", type: "OneTime" as const },
    { id: "e2", name: "Feast", type: "OneTime" as const },
  ]
  const base = {
    kind: "Registrant" as const,
    eventType: "OneTime" as const,
    phone: null,
    isMember: false,
    gender: null,
    checkedInAt: null,
    // `viaCluster: boolean` became `registrationClusterId: string | null` — the
    // roll-up needs to know *which* cluster's link someone came through, not
    // just that they came through one.
    hasLinkedSession: false,
    registrationClusterId: null,
    registeredAt: new Date(),
    onClusterDay: true,
  }

  it("collapses the same person across events into one row", () => {
    const roster = buildClusterRoster(events, [
      { ...base, id: "r1", eventId: "e1", memberId: null, guestId: "g1", firstName: "Ana", lastName: "Reyes", checkedIn: true },
      { ...base, id: "r2", eventId: "e2", memberId: null, guestId: "g1", firstName: "Ana", lastName: "Reyes", checkedIn: false },
    ])
    expect(roster.rows).toHaveLength(1)
    expect(roster.rows[0].perEvent.e1).toEqual({ kind: "Registrant" as const, registrantId: "r1", checkedIn: true, checkedInAt: null, onClusterDay: true })
    expect(roster.rows[0].perEvent.e2).toEqual({ kind: "Registrant" as const, registrantId: "r2", checkedIn: false, checkedInAt: null, onClusterDay: true })
  })

  it("keeps different people apart and sorts by name", () => {
    const roster = buildClusterRoster(events, [
      { ...base, id: "r1", eventId: "e1", memberId: "m1", guestId: null, firstName: "Zoe", lastName: "Santos", checkedIn: false, isMember: true },
      { ...base, id: "r2", eventId: "e1", memberId: null, guestId: null, firstName: "Ben", lastName: "Cruz", checkedIn: false },
    ])
    expect(roster.rows.map((r) => r.lastName)).toEqual(["Cruz", "Santos"])
    // An anonymous registrant (no member/guest link) keys off its own row id.
    expect(personKeyFor({ id: "r2", memberId: null, guestId: null })).toBe("registrant:r2")
  })
})

// ─── Integration: the fan-out ────────────────────────────────────────────────

describe("integration — one submit, N events, one person", () => {
  it("creates one registrant per selected event with a single shared Guest", async () => {
    const [a, b] = await Promise.all([seedEvent("Service"), seedEvent("Feast")])
    const cluster = await seedCluster([a.id, b.id])

    const result = await registerForCluster(
      cluster.publicToken,
      payload(),
      null,
      null,
      undefined,
      [a.id, b.id]
    )

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.results.map((r) => r.status)).toEqual(["registered", "registered"])

    // Person resolved ONCE: exactly one Guest, both registrants share it.
    const guests = await db.guest.findMany()
    expect(guests).toHaveLength(1)
    expect(guests[0].phone).toBe(CANONICAL_PHONE)

    const registrants = await db.eventRegistrant.findMany({ orderBy: { eventId: "asc" } })
    expect(registrants).toHaveLength(2)
    expect(new Set(registrants.map((r) => r.guestId))).toEqual(new Set([guests[0].id]))
    // Provenance recorded for analytics.
    expect(registrants.every((r) => r.registrationClusterId === cluster.id)).toBe(true)
  })

  it("selecting a subset only registers that subset", async () => {
    const [a, b] = await Promise.all([seedEvent("Service"), seedEvent("Feast")])
    const cluster = await seedCluster([a.id, b.id])

    const result = await registerForCluster(
      cluster.publicToken,
      payload(),
      null,
      null,
      undefined,
      [b.id]
    )
    expect(result.success).toBe(true)
    const registrants = await db.eventRegistrant.findMany()
    expect(registrants).toHaveLength(1)
    expect(registrants[0].eventId).toBe(b.id)
  })

  it("rejects an empty selection and events outside the cluster", async () => {
    const [a] = await Promise.all([seedEvent("Service")])
    const stranger = await seedEvent("Not in cluster")
    const cluster = await seedCluster([a.id])

    const empty = await registerForCluster(cluster.publicToken, payload(), null, null, undefined, [])
    expect(empty.success).toBe(false)

    const foreign = await registerForCluster(
      cluster.publicToken,
      payload(),
      null,
      null,
      undefined,
      [a.id, stranger.id]
    )
    expect(foreign.success).toBe(false)
    expect(await db.eventRegistrant.count()).toBe(0)
  })

  it("resolves a confirmed member once — fill-ins written a single time, no Guest created", async () => {
    const [a, b] = await Promise.all([seedEvent("Service"), seedEvent("Feast")])
    const cluster = await seedCluster([a.id, b.id])
    // The cluster form must allow the fields for them to survive sanitize.
    await db.eventFormConfig.create({
      data: { clusterId: cluster.id, context: "Register", fieldGender: true },
    })
    const member = await db.member.create({
      data: {
        firstName: "Mia",
        lastName: "Lopez",
        dateJoined: new Date(),
        email: null,
        language: [],
      },
      select: { id: true },
    })

    const result = await registerForCluster(
      cluster.publicToken,
      payload({ email: "mia@example.com", gender: "Female" }),
      member.id,
      null,
      undefined,
      [a.id, b.id]
    )
    expect(result.success).toBe(true)

    expect(await db.guest.count()).toBe(0)
    const registrants = await db.eventRegistrant.findMany()
    expect(registrants).toHaveLength(2)
    expect(registrants.every((r) => r.memberId === member.id)).toBe(true)

    const updated = await db.member.findUniqueOrThrow({ where: { id: member.id } })
    expect(updated.email).toBe("mia@example.com")
    expect(updated.gender).toBe("Female")
  })
})

describe("integration — partial success", () => {
  it("an already-registered event reports 'already' while the rest register", async () => {
    const [a, b] = await Promise.all([seedEvent("Service"), seedEvent("Feast")])
    const cluster = await seedCluster([a.id, b.id])
    const guest = await db.guest.create({
      data: { firstName: "Juan", lastName: "dela Cruz", phone: CANONICAL_PHONE, language: [] },
      select: { id: true },
    })
    await db.eventRegistrant.create({ data: { eventId: a.id, guestId: guest.id } })

    const result = await registerForCluster(
      cluster.publicToken,
      payload(),
      null,
      null,
      undefined,
      [a.id, b.id]
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    const byEvent = new Map(result.data.results.map((r) => [r.eventId, r.status]))
    expect(byEvent.get(a.id)).toBe("already")
    expect(byEvent.get(b.id)).toBe("registered")

    // Still one Guest (deduped by phone), one NEW registrant.
    expect(await db.guest.count()).toBe(1)
    expect(await db.eventRegistrant.count()).toBe(2)
  })

  it("a closed per-event window fails that event only", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const [a, b] = await Promise.all([
      seedEvent("Open event"),
      seedEvent("Closed event", { registrationEnd: past }),
    ])
    const cluster = await seedCluster([a.id, b.id])

    const result = await registerForCluster(
      cluster.publicToken,
      payload(),
      null,
      null,
      undefined,
      [a.id, b.id]
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    const byEvent = new Map(result.data.results.map((r) => [r.eventId, r.status]))
    expect(byEvent.get(a.id)).toBe("registered")
    expect(byEvent.get(b.id)).toBe("closed")

    const registrants = await db.eventRegistrant.findMany()
    expect(registrants).toHaveLength(1)
    expect(registrants[0].eventId).toBe(a.id)
  })

  it("a volunteer conflict fails that event only", async () => {
    const [a, b] = await Promise.all([seedEvent("Serving here"), seedEvent("Attending here")])
    const cluster = await seedCluster([a.id, b.id])
    const member = await db.member.create({
      data: { firstName: "Vol", lastName: "Unteer", dateJoined: new Date(), language: [] },
      select: { id: true },
    })
    const committee = await db.volunteerCommittee.create({
      data: { name: "Ushering", eventId: a.id },
      select: { id: true },
    })
    const role = await db.committeeRole.create({
      data: { name: "Usher", committeeId: committee.id },
      select: { id: true },
    })
    await db.volunteer.create({
      data: {
        memberId: member.id,
        eventId: a.id,
        committeeId: committee.id,
        preferredRoleId: role.id,
      },
    })

    const result = await registerForCluster(
      cluster.publicToken,
      payload(),
      member.id,
      null,
      undefined,
      [a.id, b.id]
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    const byEvent = new Map(result.data.results.map((r) => [r.eventId, r.status]))
    expect(byEvent.get(a.id)).toBe("volunteer")
    expect(byEvent.get(b.id)).toBe("registered")
    expect(await db.eventRegistrant.count()).toBe(1)
  })
})

describe("integration — cluster window & sanitize enforcement", () => {
  it("a closed cluster refuses the submission outright", async () => {
    const [a] = await Promise.all([seedEvent("Service")])
    const cluster = await seedCluster([a.id], { isOpen: false })

    const result = await registerForCluster(cluster.publicToken, payload(), null, null, undefined, [a.id])
    expect(result.success).toBe(false)
    expect(await db.eventRegistrant.count()).toBe(0)
  })

  it("enforces the CLUSTER form config server-side — disabled fields are dropped before the person is written", async () => {
    const [a] = await Promise.all([seedEvent("Service")])
    const cluster = await seedCluster([a.id])
    // No EventFormConfig row for the cluster → bare: only identity is collected.

    const result = await registerForCluster(
      cluster.publicToken,
      payload({ gender: "Male", birthYear: 1990, birthMonth: 5, workCity: "Taguig" }),
      null,
      null,
      undefined,
      [a.id]
    )
    expect(result.success).toBe(true)

    const guest = await db.guest.findFirstOrThrow()
    expect(guest.gender).toBeNull()
    expect(guest.birthYear).toBeNull()
    expect(guest.workCity).toBeNull()
  })
})

describe("integration — walk-in mode (cluster check-in board)", () => {
  it("is exempt from the closed cluster, checks in OneTime events only, and reuses existing registrations", async () => {
    const oneTime = await seedEvent("Main Service")
    const multiDay = await seedEvent("Conference", {
      type: "MultiDay",
      endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    })
    const cluster = await seedCluster([oneTime.id, multiDay.id], { isOpen: false })

    const result = await registerForCluster(
      cluster.publicToken,
      payload(),
      null,
      null,
      undefined,
      [oneTime.id, multiDay.id],
      true // walk-in
    )
    expect(result.success).toBe(true)
    if (!result.success) return

    const oneTimeRow = await db.eventRegistrant.findFirstOrThrow({
      where: { eventId: oneTime.id },
    })
    const multiDayRow = await db.eventRegistrant.findFirstOrThrow({
      where: { eventId: multiDay.id },
    })
    // OneTime → checked in via attendedAt; MultiDay check-in is deferred.
    expect(oneTimeRow.attendedAt).not.toBeNull()
    expect(multiDayRow.attendedAt).toBeNull()
    expect(await db.occurrenceAttendee.count()).toBe(0)

    const byEvent = new Map(result.data.results.map((r) => [r.eventId, r]))
    expect(byEvent.get(oneTime.id)?.checkedIn).toBe(true)
    expect(byEvent.get(multiDay.id)?.checkedIn).toBeFalsy()

    // Submitting again at the door reuses the rows instead of erroring.
    const again = await registerForCluster(
      cluster.publicToken,
      payload(),
      null,
      null,
      undefined,
      [oneTime.id],
      true
    )
    expect(again.success).toBe(true)
    expect(await db.eventRegistrant.count()).toBe(2)
    expect(await db.guest.count()).toBe(1)
  })
})

describe("integration — cluster membership guards", () => {
  it("blocks paid events", async () => {
    const [free] = await Promise.all([seedEvent("Free")])
    const paid = await seedEvent("Paid gala", {
      price: 50000,
      modules: { create: { type: "Priced" } },
    })
    const cluster = await seedCluster([free.id])

    const result = await addEventToCluster(cluster.id, paid.id)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("paid")
    expect(await db.eventClusterEvent.count()).toBe(1)
  })

  it("blocks pricing an event that is already in a cluster", async () => {
    // The mirror of "blocks paid events": the invariant has to hold on the way out
    // too, or the shared form would take registrations against an uncollected fee.
    const [event] = await Promise.all([seedEvent("Service")])
    await seedCluster([event.id])

    const enabled = await enableModule(event.id, "Priced")
    expect(enabled.success).toBe(false)
    if (!enabled.success) expect(enabled.error).toContain("can't be priced")

    const priced = await setPricedModule(event.id, "2500")
    expect(priced.success).toBe(false)
    if (!priced.success) expect(priced.error).toContain("can't be priced")

    const stored = await db.event.findUnique({
      where: { id: event.id },
      select: { price: true, modules: { select: { type: true } } },
    })
    expect(stored?.price).toBeNull()
    expect(stored?.modules).toEqual([])
  })

  it("allows pricing again once the event leaves the cluster", async () => {
    const [event] = await Promise.all([seedEvent("Service")])
    const cluster = await seedCluster([event.id])
    await db.eventClusterEvent.delete({
      where: { clusterId_eventId: { clusterId: cluster.id, eventId: event.id } },
    })

    const result = await setPricedModule(event.id, "2500")

    expect(result.success).toBe(true)
    const stored = await db.event.findUnique({
      where: { id: event.id },
      select: { price: true },
    })
    expect(stored?.price).toBe(250000)
  })

  it("enforces one cluster per event", async () => {
    const [a] = await Promise.all([seedEvent("Service")])
    await seedCluster([a.id])
    const other = await db.eventCluster.create({
      data: { name: "Another day" },
      select: { id: true },
    })

    const result = await addEventToCluster(other.id, a.id)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain("another cluster")
  })
})

describe("integration — access-scoped roll-up", () => {
  it("counts only the events the user is permitted to see", async () => {
    const [a, b] = await Promise.all([seedEvent("Allowed"), seedEvent("Restricted")])
    const cluster = await seedCluster([a.id, b.id])
    const guest = await db.guest.create({
      data: { firstName: "Ana", lastName: "Reyes", language: [] },
      select: { id: true },
    })
    await db.eventRegistrant.create({ data: { eventId: a.id, guestId: guest.id } })
    await db.eventRegistrant.create({ data: { eventId: b.id, guestId: guest.id } })

    const staff = {
      user: {
        role: "Staff",
        permissions: [{ feature: "Events", actions: ["Read"] }],
        eventAccess: [a.id],
      },
    } as unknown as Session
    const admin = { user: { role: "SuperAdmin", permissions: [], eventAccess: [] } } as unknown as Session

    const scoped = await getClusterOverview(staff, cluster.id)
    expect(scoped.events.map((e) => e.id)).toEqual([a.id])
    expect(scoped.totals.registrations).toBe(1)

    const full = await getClusterOverview(admin, cluster.id)
    expect(full.events).toHaveLength(2)
    expect(full.totals.registrations).toBe(2)
    expect(full.totals.uniquePeople).toBe(1) // same person across both events
  })
})

// ─── Regression: single-event path untouched ─────────────────────────────────

describe("regression — single-event registration is unchanged", () => {
  it("createRegistrant still registers and leaves registrationClusterId null", async () => {
    const event = await seedEvent("Ordinary event")

    const result = await createRegistrant(event.id, payload(), null)
    expect(result.success).toBe(true)

    const registrant = await db.eventRegistrant.findFirstOrThrow()
    expect(registrant.eventId).toBe(event.id)
    expect(registrant.registrationClusterId).toBeNull()

    const guest = await db.guest.findFirstOrThrow()
    expect(registrant.guestId).toBe(guest.id)
    expect(guest.phone).toBe(CANONICAL_PHONE)
  })
})
