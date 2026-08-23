import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const authMock = vi.hoisted(() => ({ session: null as unknown }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => authMock.session) }))

import { db } from "@/lib/db"
import { FacilitatorRole } from "@/app/generated/prisma/client"
import {
  assignSubFacilitator,
  removeSubFacilitator,
} from "@/app/(event)/event/[id]/sessions/[occurrenceId]/sub-facilitator-actions"

/**
 * Standing in for a facilitator, on a Collab day and against a stranger.
 *
 * Two things were wrong with these actions. The session screen listed tables
 * with a bare `eventId`, so a Collab day offered the member event's standing
 * tables and none of the day's own — even though `OccurrenceSubFacilitator`
 * carries no event of its own and could always name a cluster-owned table. And
 * neither action had a guard of any kind: no `auth()`, no permission check, and
 * no verification that the caller-supplied occurrence, group and volunteer
 * belonged together.
 *
 *  - security:    signed out is refused; a table from another event or another
 *                 day is refused; a volunteer from outside the day is refused
 *  - integration: a cluster-owned table can be staffed, from either ministry's
 *                 roster
 *  - regression:  an ordinary event still behaves exactly as CCF-77 pinned it
 *                 (that file still runs, signed in)
 *  - e2e:         skipped — no Playwright cluster fixtures; the guard is
 *                 asserted from both sides here instead
 */

const SIGNED_OUT = null
const STAFF = { user: { id: "u1", role: "SuperAdmin" } }

beforeEach(async () => {
  authMock.session = STAFF
  await db.$executeRaw`TRUNCATE
    "OccurrenceSubFacilitator", "OccurrenceAttendee", "EventOccurrence",
    "BreakoutGroupMember", "BreakoutGroup", "Volunteer", "CommitteeRole",
    "VolunteerCommittee", "EventRegistrant", "EventModule", "EventClusterEvent",
    "EventCluster", "Event", "Member", "Guest"
    RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

async function seedEvent(name = "Youth Night") {
  return db.event.create({
    data: { name, type: "Recurring", startDate: new Date(), endDate: new Date() },
    select: { id: true },
  })
}

async function seedOccurrence(eventId: string, date = new Date("2026-05-18T00:00:00Z")) {
  return db.eventOccurrence.create({ data: { eventId, date }, select: { id: true } })
}

async function seedVolunteer(eventId: string, firstName = "Sub") {
  const member = await db.member.create({
    data: { firstName, lastName: "Cruz", dateJoined: new Date(), language: [] },
    select: { id: true },
  })
  const committee = await db.volunteerCommittee.create({
    data: { name: "Facilitators", eventId },
  })
  const role = await db.committeeRole.create({
    data: { name: "Facilitator", committeeId: committee.id },
  })
  return db.volunteer.create({
    data: {
      memberId: member.id,
      eventId,
      committeeId: committee.id,
      preferredRoleId: role.id,
      status: "Confirmed",
    },
    select: { id: true },
  })
}

async function seedCollab(eventIds: string[]) {
  return db.eventCluster.create({
    data: {
      name: "Collab Sunday",
      kind: "Collab",
      isOpen: true,
      events: { create: eventIds.map((eventId, order) => ({ eventId, order })) },
    },
    select: { id: true },
  })
}

function errorOf(result: { success: true } | { success: false; error: string }) {
  return result.success ? null : result.error
}

// ─── Security ────────────────────────────────────────────────────────────────

describe("security — the actions carry their own arguments, so they check them", () => {
  it("refuses a signed-out caller", async () => {
    const event = await seedEvent()
    const occurrence = await seedOccurrence(event.id)
    const table = await db.breakoutGroup.create({
      data: { name: "Table 1", eventId: event.id },
      select: { id: true },
    })
    const volunteer = await seedVolunteer(event.id)
    authMock.session = SIGNED_OUT

    const result = await assignSubFacilitator(
      occurrence.id,
      table.id,
      FacilitatorRole.Facilitator,
      volunteer.id
    )

    expect(errorOf(result)).toBe("Not authenticated.")
    expect(await db.occurrenceSubFacilitator.count()).toBe(0)
  })

  it("refuses a signed-out caller on removal too", async () => {
    const event = await seedEvent()
    const occurrence = await seedOccurrence(event.id)
    const table = await db.breakoutGroup.create({
      data: { name: "Table 1", eventId: event.id },
      select: { id: true },
    })
    const volunteer = await seedVolunteer(event.id)
    await assignSubFacilitator(
      occurrence.id,
      table.id,
      FacilitatorRole.Facilitator,
      volunteer.id
    )
    authMock.session = SIGNED_OUT

    const result = await removeSubFacilitator(
      occurrence.id,
      table.id,
      FacilitatorRole.Facilitator
    )

    expect(errorOf(result)).toBe("Not authenticated.")
    expect(await db.occurrenceSubFacilitator.count()).toBe(1)
  })

  it("refuses a table belonging to a different event", async () => {
    const mine = await seedEvent()
    const stranger = await seedEvent("Someone else's event")
    const occurrence = await seedOccurrence(mine.id)
    const theirTable = await db.breakoutGroup.create({
      data: { name: "Their table", eventId: stranger.id },
      select: { id: true },
    })
    const volunteer = await seedVolunteer(mine.id)

    const result = await assignSubFacilitator(
      occurrence.id,
      theirTable.id,
      FacilitatorRole.Facilitator,
      volunteer.id
    )

    expect(errorOf(result)).toBe("That breakout group isn't part of this session.")
    expect(await db.occurrenceSubFacilitator.count()).toBe(0)
  })

  it("refuses a cluster-owned table from another day", async () => {
    const event = await seedEvent()
    await seedCollab([event.id])
    const otherDay = await db.eventCluster.create({
      data: { name: "Another day", kind: "Collab", isOpen: true },
      select: { id: true },
    })
    const occurrence = await seedOccurrence(event.id)
    const theirTable = await db.breakoutGroup.create({
      data: { name: "Their table", clusterId: otherDay.id },
      select: { id: true },
    })
    const volunteer = await seedVolunteer(event.id)

    const result = await assignSubFacilitator(
      occurrence.id,
      theirTable.id,
      FacilitatorRole.Facilitator,
      volunteer.id
    )

    expect(errorOf(result)).toBe("That breakout group isn't part of this session.")
  })

  it("refuses a volunteer who serves neither of the day's events", async () => {
    const event = await seedEvent()
    const outside = await seedEvent("Unrelated event")
    const occurrence = await seedOccurrence(event.id)
    const table = await db.breakoutGroup.create({
      data: { name: "Table 1", eventId: event.id },
      select: { id: true },
    })
    const stranger = await seedVolunteer(outside.id, "Stranger")

    const result = await assignSubFacilitator(
      occurrence.id,
      table.id,
      FacilitatorRole.Facilitator,
      stranger.id
    )

    expect(errorOf(result)).toBe("That volunteer isn't serving on this day.")
    expect(await db.occurrenceSubFacilitator.count()).toBe(0)
  })

  it("still reports a missing occurrence rather than leaking anything else", async () => {
    const result = await assignSubFacilitator(
      "no-such-occurrence",
      "no-such-group",
      FacilitatorRole.Facilitator,
      "no-such-volunteer"
    )

    expect(errorOf(result)).toBe("Occurrence not found.")
  })
})

// ─── Integration: a Collab day ───────────────────────────────────────────────

describe("integration — a Collab day's cluster-owned table", () => {
  it("can be staffed by a substitute", async () => {
    const event = await seedEvent()
    const cluster = await seedCollab([event.id])
    const occurrence = await seedOccurrence(event.id)
    const dayTable = await db.breakoutGroup.create({
      data: { name: "Day table", clusterId: cluster.id },
      select: { id: true },
    })
    const volunteer = await seedVolunteer(event.id)

    const result = await assignSubFacilitator(
      occurrence.id,
      dayTable.id,
      FacilitatorRole.Facilitator,
      volunteer.id
    )

    expect(result.success).toBe(true)
    const row = await db.occurrenceSubFacilitator.findUnique({
      where: {
        occurrenceId_breakoutGroupId_role: {
          occurrenceId: occurrence.id,
          breakoutGroupId: dayTable.id,
          role: FacilitatorRole.Facilitator,
        },
      },
    })
    expect(row?.substituteId).toBe(volunteer.id)
  })

  it("accepts a substitute from the partner ministry's roster", async () => {
    const mine = await seedEvent("Youth Night")
    const partner = await seedEvent("Young Pro Night")
    const cluster = await seedCollab([mine.id, partner.id])
    const occurrence = await seedOccurrence(mine.id)
    const dayTable = await db.breakoutGroup.create({
      data: { name: "Day table", clusterId: cluster.id },
      select: { id: true },
    })
    // A person serves under a ministry — their volunteer row stays on the
    // partner's event while the table belongs to the day.
    const volunteer = await seedVolunteer(partner.id, "Partner")

    const result = await assignSubFacilitator(
      occurrence.id,
      dayTable.id,
      FacilitatorRole.Facilitator,
      volunteer.id
    )

    expect(result.success).toBe(true)
  })

  it("accepts the member event's own standing table too — both sets are in play", async () => {
    // The occurrence belongs to the member event, and that event keeps its own
    // tables inside a collab. A sitting can need a stand-in at either set, so a
    // scope naming only the day's would leave the event's own unstaffable.
    const event = await seedEvent()
    await seedCollab([event.id])
    const occurrence = await seedOccurrence(event.id)
    const standing = await db.breakoutGroup.create({
      data: { name: "Standing table", eventId: event.id },
      select: { id: true },
    })
    const volunteer = await seedVolunteer(event.id)

    const result = await assignSubFacilitator(
      occurrence.id,
      standing.id,
      FacilitatorRole.Facilitator,
      volunteer.id
    )

    expect(result.success).toBe(true)
    expect(
      await db.occurrenceSubFacilitator.count({
        where: { occurrenceId: occurrence.id, breakoutGroupId: standing.id },
      })
    ).toBe(1)
  })

  it("still refuses a table belonging to neither set", async () => {
    // The security property the previous case was standing in for: "in play"
    // widened to two sets, it did not stop meaning anything.
    const event = await seedEvent()
    await seedCollab([event.id])
    const occurrence = await seedOccurrence(event.id)
    const stranger = await seedEvent()
    const foreign = await db.breakoutGroup.create({
      data: { name: "Another event's table", eventId: stranger.id },
      select: { id: true },
    })
    const volunteer = await seedVolunteer(event.id)

    const result = await assignSubFacilitator(
      occurrence.id,
      foreign.id,
      FacilitatorRole.Facilitator,
      volunteer.id
    )

    expect(errorOf(result)).toBe("That breakout group isn't part of this session.")
  })

  it("removes one again", async () => {
    const event = await seedEvent()
    const cluster = await seedCollab([event.id])
    const occurrence = await seedOccurrence(event.id)
    const dayTable = await db.breakoutGroup.create({
      data: { name: "Day table", clusterId: cluster.id },
      select: { id: true },
    })
    const volunteer = await seedVolunteer(event.id)
    await assignSubFacilitator(
      occurrence.id,
      dayTable.id,
      FacilitatorRole.Facilitator,
      volunteer.id
    )

    const result = await removeSubFacilitator(
      occurrence.id,
      dayTable.id,
      FacilitatorRole.Facilitator
    )

    expect(result.success).toBe(true)
    expect(await db.occurrenceSubFacilitator.count()).toBe(0)
  })
})

// ─── Regression: a Parallel day is an ordinary event ─────────────────────────

describe("regression — a Parallel day keeps its events independent", () => {
  it("staffs the event's own table, not the day's", async () => {
    const event = await seedEvent()
    const cluster = await db.eventCluster.create({
      data: {
        name: "Parallel Sunday",
        kind: "Parallel",
        isOpen: true,
        events: { create: { eventId: event.id, order: 0 } },
      },
      select: { id: true },
    })
    const occurrence = await seedOccurrence(event.id)
    const own = await db.breakoutGroup.create({
      data: { name: "Own table", eventId: event.id },
      select: { id: true },
    })
    const notInPlay = await db.breakoutGroup.create({
      data: { name: "Cluster table", clusterId: cluster.id },
      select: { id: true },
    })
    const volunteer = await seedVolunteer(event.id)

    const accepted = await assignSubFacilitator(
      occurrence.id,
      own.id,
      FacilitatorRole.Facilitator,
      volunteer.id
    )
    const refused = await assignSubFacilitator(
      occurrence.id,
      notInPlay.id,
      FacilitatorRole.Facilitator,
      volunteer.id
    )

    expect(accepted.success).toBe(true)
    expect(errorOf(refused)).toBe("That breakout group isn't part of this session.")
  })
})
