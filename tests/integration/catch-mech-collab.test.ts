import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import { verifyCatchMechFaci, submitCatchMechConfirmations } from "@/app/events/[id]/catch-mech/actions"
import { resolveCatchMechScope } from "@/lib/catch-mech/scope"

/**
 * Catch Mech on a Collab day.
 *
 * The day's tables belong to the CLUSTER, so scoping on a bare eventId found only
 * each ministry's standing tables — which nobody sat at. A cluster table is now
 * endorsed to the ministry event of whoever staffs it, which needs no schema
 * change: `Volunteer.eventId` is required, and `CatchMechSession.breakoutGroupId`
 * already accepts a cluster-owned group.
 */
async function seed() {
  const makeEvent = (name: string) =>
    db.event.create({
      data: {
        name,
        type: "OneTime",
        startDate: new Date(),
        endDate: new Date(),
        modules: { create: { type: "CatchMech" } },
      },
    })

  const [eventA, eventB, outsider] = await Promise.all([
    makeEvent("Youth"),
    makeEvent("Singles"),
    makeEvent("Unrelated"),
  ])

  const cluster = await db.eventCluster.create({
    data: {
      name: "Youth x Singles",
      kind: "Collab",
      events: {
        create: [
          { eventId: eventA.id, order: 0 },
          { eventId: eventB.id, order: 1 },
        ],
      },
    },
  })

  const makeFaci = async (eventId: string, firstName: string, phone: string) => {
    const member = await db.member.create({
      data: { firstName, lastName: "Faci", phone, dateJoined: new Date(), language: [] },
    })
    const group = await db.smallGroup.create({
      data: { name: `${firstName}'s DGroup`, leaderId: member.id, language: [] },
    })
    const committee = await db.volunteerCommittee.create({
      data: { name: `${firstName} Committee`, eventId },
    })
    const role = await db.committeeRole.create({
      data: { name: "Facilitator", committeeId: committee.id },
    })
    const volunteer = await db.volunteer.create({
      data: {
        memberId: member.id,
        eventId,
        committeeId: committee.id,
        preferredRoleId: role.id,
        status: "Confirmed",
      },
    })
    return { member, volunteer, group }
  }

  // Ministry A leads the table, Ministry B co-facilitates it.
  const faciA = await makeFaci(eventA.id, "Ana", "+63 917 111 1111")
  const faciB = await makeFaci(eventB.id, "Ben", "+63 917 222 2222")

  const sharedTable = await db.breakoutGroup.create({
    data: {
      clusterId: cluster.id,
      name: "Table 1",
      facilitatorId: faciA.volunteer.id,
      coFacilitatorId: faciB.volunteer.id,
      language: [],
    },
  })
  const orphanTable = await db.breakoutGroup.create({
    data: { clusterId: cluster.id, name: "Table 2", language: [] },
  })
  // Ministry A's own standing table — untouched and unused for the collab day.
  const standingTable = await db.breakoutGroup.create({
    data: { eventId: eventA.id, name: "Standing", language: [] },
  })

  return { eventA, eventB, outsider, cluster, faciA, faciB, sharedTable, orphanTable, standingTable }
}

describe("Catch Mech on a Collab cluster", () => {
  beforeEach(async () => {
    await db.$executeRaw`
      TRUNCATE
        "ConfirmationSubmission", "CatchMechVolunteerSession", "CatchMechSession",
        "BreakoutGroupMember", "BreakoutGroup", "EventRegistrant", "Guest",
        "SmallGroupMemberRequest", "SmallGroupLog", "Volunteer", "CommitteeRole",
        "VolunteerCommittee", "SmallGroup", "Member", "EventClusterEvent",
        "EventCluster", "EventMinistry", "Event"
      RESTART IDENTITY CASCADE
    `
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it("endorses a cluster table to both ministries that staff it", async () => {
    const { eventA, eventB, outsider, sharedTable, standingTable } = await seed()

    const inA = await db.breakoutGroup.findMany({
      where: (await resolveCatchMechScope(eventA.id)).where,
      select: { id: true },
    })
    const inB = await db.breakoutGroup.findMany({
      where: (await resolveCatchMechScope(eventB.id)).where,
      select: { id: true },
    })
    const inOutsider = await db.breakoutGroup.findMany({
      where: (await resolveCatchMechScope(outsider.id)).where,
      select: { id: true },
    })

    // The lead's ministry and the co-faci's ministry both see the shared table...
    expect(inA.map((g) => g.id)).toContain(sharedTable.id)
    expect(inB.map((g) => g.id)).toEqual([sharedTable.id])
    // ...and A keeps its OWN standing table in scope alongside it. The scope is a
    // union: an event's follow-up history is keyed to the tables it was recorded
    // against, and joining a collab must not put it out of reach.
    expect(inA.map((g) => g.id).sort()).toEqual([sharedTable.id, standingTable.id].sort())
    // B never had a standing table of its own, so it sees only the shared one.
    // An event outside the cluster is unaffected and sees only its own.
    expect(inOutsider).toEqual([])
  })

  it("leaves an unstaffed cluster table endorsed to nobody", async () => {
    const { eventA, eventB, orphanTable } = await seed()

    const inA = await db.breakoutGroup.findMany({
      where: (await resolveCatchMechScope(eventA.id)).where,
      select: { id: true },
    })
    const inB = await db.breakoutGroup.findMany({
      where: (await resolveCatchMechScope(eventB.id)).where,
      select: { id: true },
    })

    // Surfaced on the cluster Breakouts page instead — that is where you fix it
    // by assigning a facilitator.
    expect(inA.map((g) => g.id)).not.toContain(orphanTable.id)
    expect(inB.map((g) => g.id)).not.toContain(orphanTable.id)
  })

  it("mints a session against the facilitator's own ministry event", async () => {
    const { eventA, eventB, sharedTable, faciA, faciB } = await seed()

    const leadEntry = await verifyCatchMechFaci(eventA.id, sharedTable.id, "09171111111")
    const coEntry = await verifyCatchMechFaci(eventB.id, sharedTable.id, "09172222222")

    expect(leadEntry.success).toBe(true)
    expect(coEntry.success).toBe(true)

    const leadSession = await db.catchMechSession.findFirstOrThrow({
      where: { facilitatorVolunteerId: faciA.volunteer.id },
    })
    const coSession = await db.catchMechSession.findFirstOrThrow({
      where: { facilitatorVolunteerId: faciB.volunteer.id },
    })

    // One cluster-owned table, two sessions, each keyed to its own ministry.
    expect(leadSession.breakoutGroupId).toBe(sharedTable.id)
    expect(leadSession.eventId).toBe(eventA.id)
    expect(coSession.breakoutGroupId).toBe(sharedTable.id)
    expect(coSession.eventId).toBe(eventB.id)
  })

  it("refuses a table the event does not staff", async () => {
    const { outsider, sharedTable } = await seed()

    // Before scoping, verifyCatchMechFaci accepted ANY breakout group id.
    const result = await verifyCatchMechFaci(outsider.id, sharedTable.id, "09171111111")

    expect(result).toEqual({ success: false, error: "Breakout group not found" })
    expect(await db.catchMechSession.count()).toBe(0)
  })

  it("confirms a cluster table's participant into the facilitator's DGroup", async () => {
    const { eventA, sharedTable, faciA } = await seed()
    const guest = await db.guest.create({
      data: { firstName: "Mia", lastName: "Guest", language: [] },
    })
    const registrant = await db.eventRegistrant.create({
      data: { eventId: eventA.id, guestId: guest.id },
    })
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: sharedTable.id, registrantId: registrant.id },
    })

    const entry = await verifyCatchMechFaci(eventA.id, sharedTable.id, "09171111111")
    if (!entry.success) throw new Error(entry.error)

    const result = await submitCatchMechConfirmations(entry.data.token, [
      { registrantId: registrant.id, status: "confirmed", targetGroupId: faciA.group.id },
    ])
    expect(result.success).toBe(true)

    const promoted = await db.guest.findUniqueOrThrow({ where: { id: guest.id } })
    expect(promoted.memberId).toBeTruthy()
    const member = await db.member.findUniqueOrThrow({ where: { id: promoted.memberId! } })
    expect(member.smallGroupId).toBe(faciA.group.id)

    // The request hangs off the CLUSTER-owned table, which is what makes it
    // visible on this ministry's Catch Mech lists.
    const request = await db.smallGroupMemberRequest.findFirstOrThrow()
    expect(request.breakoutGroupId).toBe(sharedTable.id)
    expect(request.status).toBe("Confirmed")
  })
})
