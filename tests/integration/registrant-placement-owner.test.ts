import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { db } from "@/lib/db"
import {
  breakoutGroupHref,
  getRegistrantPlacement,
} from "@/lib/breakouts/registrant-placement"

/**
 * The registrant detail page's Breakout section, on a Collab day.
 *
 * The page asks three questions, and they do NOT all answer about the same set of
 * tables — which is the whole point of this file:
 *
 *  - **Which tables to offer** is one set: the event's own, because this is the
 *    event workspace and an assignment here writes through `surface.owner`. The
 *    day's tables are placed from the day's own Breakouts page.
 *  - **Whether this person staffs a table** spans both. It is a guard, not an
 *    offer — a host of the day's table is exactly as unseatable as a host of the
 *    event's own, and answering from one set would badge some hosts and hand the
 *    rest an assign list.
 *  - **Where a seat links to** follows the group's OWN owner columns, so a seat
 *    at a cluster table lands in the cluster workspace and a seat at the event's
 *    own lands in the event's. The event route scopes on `{ id, eventId }` and
 *    404s on a cluster-owned table, which is what this originally fixed.
 *
 *  - unit:        `breakoutGroupHref` answers from the group's own owner columns
 *  - integration: the offer list is the workspace's own set; a facilitator of a
 *                 cluster-owned table is still recognised; the seat's link lands
 *                 in whichever workspace serves it
 *  - regression:  a single event (no cluster) and a Parallel day are unchanged
 *  - edge case:   a seat held at a member event's own table still links into the
 *                 event workspace; an unowned row yields no link
 *  - e2e:         skipped — this is a data-resolution fix behind an existing
 *                 screen, and there are no Playwright cluster fixtures
 */

beforeEach(async () => {
  await db.$executeRaw`TRUNCATE
    "BreakoutGroupMember", "BreakoutGroup", "Volunteer", "CommitteeRole",
    "VolunteerCommittee", "EventRegistrant", "EventModule", "EventClusterEvent",
    "EventCluster", "Event", "Guest", "Member", "Ministry", "LifeStage"
    RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

async function seedEvent(name = "Youth Night") {
  return db.event.create({
    data: {
      name,
      type: "OneTime",
      startDate: new Date(),
      endDate: new Date(),
      modules: { create: { type: "Breakout" } },
    },
    select: { id: true },
  })
}

async function seedCluster(
  eventIds: string[],
  kind: "Collab" | "Parallel" = "Collab"
) {
  return db.eventCluster.create({
    data: {
      name: "Collab Sunday",
      kind,
      isOpen: true,
      events: { create: eventIds.map((eventId, order) => ({ eventId, order })) },
    },
    select: { id: true },
  })
}

async function seedMember(firstName = "Juan", gender: "Male" | "Female" | null = null) {
  return db.member.create({
    data: {
      firstName,
      lastName: "dela Cruz",
      dateJoined: new Date(),
      language: [],
      ...(gender ? { gender } : {}),
    },
    select: { id: true },
  })
}

async function seedRegistrant(eventId: string, memberId: string) {
  return db.eventRegistrant.create({
    data: { eventId, memberId },
    select: { id: true },
  })
}

/** A volunteer row on `eventId` — the provenance a facilitator keeps under a Collab. */
async function seedFacilitator(eventId: string, memberId: string) {
  const committee = await db.volunteerCommittee.create({
    data: { name: "Facilitators", eventId },
  })
  const role = await db.committeeRole.create({
    data: { name: "Facilitator", committeeId: committee.id },
  })
  return db.volunteer.create({
    data: {
      memberId,
      eventId,
      committeeId: committee.id,
      preferredRoleId: role.id,
      status: "Confirmed",
    },
    select: { id: true },
  })
}

// ─── Unit ────────────────────────────────────────────────────────────────────

describe("unit — breakoutGroupHref answers from the group's own owner", () => {
  it("routes an event-owned table into the event workspace", () => {
    expect(breakoutGroupHref({ id: "g1", eventId: "e1", clusterId: null })).toBe(
      "/event/e1/breakouts/g1"
    )
  })

  it("routes a cluster-owned table into the cluster workspace", () => {
    expect(breakoutGroupHref({ id: "g1", eventId: null, clusterId: "c1" })).toBe(
      "/cluster/c1/breakouts/g1"
    )
  })

  it("yields no link for a row that satisfies neither side of the XOR", () => {
    expect(breakoutGroupHref({ id: "g1", eventId: null, clusterId: null })).toBeNull()
    expect(breakoutGroupHref({ id: "g1", eventId: "e1", clusterId: "c1" })).toBeNull()
  })
})

// ─── Integration ─────────────────────────────────────────────────────────────

describe("integration — a Collab day's registrant", () => {
  it("is offered this workspace's own tables, not the day's", async () => {
    // The offer list is one set — the workspace you are standing in. An
    // assignment made here writes through `surface.owner`, and the day's tables
    // are placed from the day's own Breakouts page.
    const event = await seedEvent()
    const cluster = await seedCluster([event.id])
    const standing = await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Standing table" },
      select: { id: true },
    })
    await db.breakoutGroup.create({
      data: { clusterId: cluster.id, name: "Day table" },
    })
    const member = await seedMember()
    const registrant = await seedRegistrant(event.id, member.id)

    const placement = await getRegistrantPlacement({
      id: registrant.id,
      eventId: event.id,
      memberId: member.id,
      gender: null,
    })

    expect(placement.availableGroups.map((g) => g.name)).toEqual(["Standing table"])
    expect(placement.availableGroups[0].id).toBe(standing.id)
  })

  it("addresses the event, so an assignment writes to its own tables", async () => {
    const event = await seedEvent()
    await seedCluster([event.id])
    const member = await seedMember()
    const registrant = await seedRegistrant(event.id, member.id)

    const placement = await getRegistrantPlacement({
      id: registrant.id,
      eventId: event.id,
      memberId: member.id,
      gender: null,
    })

    expect(placement.surface.owner).toEqual({ eventId: event.id })
    expect(placement.surface.basePath).toBe(`/event/${event.id}`)
  })

  it("links an existing seat into the cluster workspace, which serves it", async () => {
    const event = await seedEvent()
    const cluster = await seedCluster([event.id])
    const table = await db.breakoutGroup.create({
      data: { clusterId: cluster.id, name: "Day table" },
      select: { id: true },
    })
    const member = await seedMember()
    const registrant = await seedRegistrant(event.id, member.id)
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: table.id, registrantId: registrant.id },
    })

    const placement = await getRegistrantPlacement({
      id: registrant.id,
      eventId: event.id,
      memberId: member.id,
      gender: null,
    })

    expect(placement.seats).toEqual([
      { id: table.id, name: "Day table", href: `/cluster/${cluster.id}/breakouts/${table.id}` },
    ])
    // The 404 this replaced: the event workspace scopes on { id, eventId }.
    const servedByEvent = await db.breakoutGroup.findFirst({
      where: { id: table.id, eventId: event.id },
    })
    expect(servedByEvent).toBeNull()
    const servedByCluster = await db.breakoutGroup.findFirst({
      where: { id: table.id, clusterId: cluster.id },
    })
    expect(servedByCluster).not.toBeNull()
  })

  it("recognises someone staffing a cluster-owned table, across either ministry", async () => {
    const mine = await seedEvent("Youth Night")
    const partner = await seedEvent("Young Pro Night")
    const cluster = await seedCluster([mine.id, partner.id])
    const member = await seedMember()
    // The volunteer row stays owned by the partner ministry's event — a person
    // serves under a ministry — while the table belongs to the day.
    const volunteer = await seedFacilitator(partner.id, member.id)
    const table = await db.breakoutGroup.create({
      data: { clusterId: cluster.id, name: "Day table", facilitatorId: volunteer.id },
      select: { id: true },
    })
    const registrant = await seedRegistrant(mine.id, member.id)

    const placement = await getRegistrantPlacement({
      id: registrant.id,
      eventId: mine.id,
      memberId: member.id,
      gender: null,
    })

    expect(placement.facilitatedGroup).toEqual({ id: table.id, name: "Day table" })
  })

  it("still links a seat held at a member event's own table into that event", async () => {
    const event = await seedEvent()
    // A Collab day, but this seat predates it — the link must follow the table.
    await seedCluster([event.id])
    const standing = await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Standing table" },
      select: { id: true },
    })
    const member = await seedMember()
    const registrant = await seedRegistrant(event.id, member.id)
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: standing.id, registrantId: registrant.id },
    })

    const placement = await getRegistrantPlacement({
      id: registrant.id,
      eventId: event.id,
      memberId: member.id,
      gender: null,
    })

    expect(placement.seats[0].href).toBe(`/event/${event.id}/breakouts/${standing.id}`)
  })
})

// ─── Regression: the un-clustered cases are untouched ────────────────────────

describe("regression — an event that is not on a Collab day", () => {
  it("keeps its own tables and its own workspace when it has no cluster", async () => {
    const event = await seedEvent()
    const table = await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Table 1" },
      select: { id: true },
    })
    const member = await seedMember()
    const registrant = await seedRegistrant(event.id, member.id)

    const placement = await getRegistrantPlacement({
      id: registrant.id,
      eventId: event.id,
      memberId: member.id,
      gender: null,
    })

    expect(placement.surface.owner).toEqual({ eventId: event.id })
    expect(placement.availableGroups.map((g) => g.id)).toEqual([table.id])
  })

  it("does the same on a Parallel day, whose events each run their own tables", async () => {
    const event = await seedEvent()
    const cluster = await seedCluster([event.id], "Parallel")
    const own = await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Table 1" },
      select: { id: true },
    })
    await db.breakoutGroup.create({
      data: { clusterId: cluster.id, name: "Not in play" },
    })
    const member = await seedMember()
    const registrant = await seedRegistrant(event.id, member.id)

    const placement = await getRegistrantPlacement({
      id: registrant.id,
      eventId: event.id,
      memberId: member.id,
      gender: null,
    })

    expect(placement.surface.owner).toEqual({ eventId: event.id })
    expect(placement.availableGroups.map((g) => g.id)).toEqual([own.id])
  })
})

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("excludes a table the registrant already sits at from the offer list", async () => {
    // Inside a cluster, over the event's own set — the exclusion rule is what is
    // under test here, and it is the same rule whoever owns the tables.
    const event = await seedEvent()
    await seedCluster([event.id])
    const seated = await db.breakoutGroup.create({
      data: { eventId: event.id, name: "A table" },
      select: { id: true },
    })
    const other = await db.breakoutGroup.create({
      data: { eventId: event.id, name: "B table" },
      select: { id: true },
    })
    const member = await seedMember()
    const registrant = await seedRegistrant(event.id, member.id)
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: seated.id, registrantId: registrant.id },
    })

    const placement = await getRegistrantPlacement({
      id: registrant.id,
      eventId: event.id,
      memberId: member.id,
      gender: null,
    })

    expect(placement.availableGroups.map((g) => g.id)).toEqual([other.id])
  })

  it("keeps the gender filter on the offered tables", async () => {
    const event = await seedEvent()
    await seedCluster([event.id])
    await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Men's table", genderFocus: "Male" },
    })
    const womens = await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Women's table", genderFocus: "Female" },
      select: { id: true },
    })
    const member = await seedMember("Maria", "Female")
    const registrant = await seedRegistrant(event.id, member.id)

    const placement = await getRegistrantPlacement({
      id: registrant.id,
      eventId: event.id,
      memberId: member.id,
      gender: "Female",
    })

    expect(placement.availableGroups.map((g) => g.id)).toEqual([womens.id])
  })

  it("offers every table to a registrant with no gender on file", async () => {
    const event = await seedEvent()
    await seedCluster([event.id])
    await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Men's table", genderFocus: "Male" },
    })
    await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Women's table", genderFocus: "Female" },
    })
    const member = await seedMember()
    const registrant = await seedRegistrant(event.id, member.id)

    const placement = await getRegistrantPlacement({
      id: registrant.id,
      eventId: event.id,
      memberId: member.id,
      gender: null,
    })

    expect(placement.availableGroups).toHaveLength(2)
  })

  it("looks up no facilitator for a guest registrant", async () => {
    const event = await seedEvent()
    await seedCluster([event.id])
    const guest = await db.guest.create({
      data: { firstName: "Ana", lastName: "Reyes", language: [] },
      select: { id: true },
    })
    const registrant = await db.eventRegistrant.create({
      data: { eventId: event.id, guestId: guest.id },
      select: { id: true },
    })

    const placement = await getRegistrantPlacement({
      id: registrant.id,
      eventId: event.id,
      memberId: null,
      gender: null,
    })

    expect(placement.facilitatedGroup).toBeNull()
  })
})
