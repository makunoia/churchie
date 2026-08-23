import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { revalidatePath } from "next/cache"

import { db } from "@/lib/db"
import {
  addRegistrantsToBreakout,
  autoAssignBreakouts,
  createBreakoutGroup,
  deleteBreakoutGroup,
  autoAssignRegistrantToBreakout,
  getRegistrantBreakoutGroupName,
  setFacilitator,
} from "@/app/(dashboard)/events/breakout-actions"
import {
  addEventToCluster,
  carryOverBreakoutGroups,
  registerForCluster,
  updateEventCluster,
} from "@/app/(dashboard)/events/cluster-actions"
import { unassignedCandidateWhere } from "@/lib/breakouts/candidate-pool"
import { resolvePoolScope } from "@/lib/events/pool-scope"
import { resolveCatchMechScope } from "@/lib/catch-mech/scope"

/**
 * Collab clusters (CCF-148): two ministries co-running one event.
 *
 * The suite is organised around the four things that were structurally impossible
 * before and the two bugs the change fixes.
 */

beforeEach(async () => {
  await db.$executeRaw`TRUNCATE "EventFormConfig", "Ministry", "EventMinistry", "EventCluster", "EventClusterEvent", "Event", "EventRegistrant", "BreakoutGroup", "BreakoutGroupMember", "Volunteer", "VolunteerCommittee", "CommitteeRole", "Member", "Guest", "LifeStage", "EventModule", "SmallGroup", "SmallGroupMemberRequest" RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

const DAY = new Date("2026-09-05T00:00:00.000Z")

async function seedDay(kind: "Parallel" | "Collab") {
  const cluster = await db.eventCluster.create({
    data: { name: "Youth × Singles Night", date: DAY, kind },
    select: { id: true },
  })
  const youth = await db.event.create({
    data: { name: "Youth Night", type: "OneTime", startDate: DAY, endDate: DAY },
    select: { id: true },
  })
  const singles = await db.event.create({
    data: { name: "Singles Connect", type: "OneTime", startDate: DAY, endDate: DAY },
    select: { id: true },
  })
  await db.eventClusterEvent.createMany({
    data: [
      { clusterId: cluster.id, eventId: youth.id, order: 0 },
      { clusterId: cluster.id, eventId: singles.id, order: 1 },
    ],
  })
  // Breakout placement is module-gated (CCF-128) on every write path.
  await db.eventModule.createMany({
    data: [
      { eventId: youth.id, type: "Breakout" },
      { eventId: singles.id, type: "Breakout" },
    ],
  })
  return { clusterId: cluster.id, youthId: youth.id, singlesId: singles.id }
}

async function seedMember(firstName: string) {
  return db.member.create({
    data: { firstName, lastName: "Cruz", dateJoined: new Date(), language: [] },
    select: { id: true },
  })
}

async function seedRegistrant(eventId: string, memberId: string) {
  return db.eventRegistrant.create({
    data: { eventId, memberId },
    select: { id: true },
  })
}

async function seedVolunteer(eventId: string, memberId: string) {
  const committee = await db.volunteerCommittee.create({
    data: { name: "Facilitators", eventId },
    select: { id: true },
  })
  const role = await db.committeeRole.create({
    data: { name: "Table host", committeeId: committee.id },
    select: { id: true },
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

// ─── The owner seam ──────────────────────────────────────────────────────────

describe("pool scope resolution", () => {
  it("keeps a Collab event's own tables and names the day's beside them", async () => {
    // The two sets sit side by side: joining a collab does not take an event's
    // breakout pool (or its Catch Mech history) away from it.
    const { clusterId, youthId, singlesId } = await seedDay("Collab")
    const scope = await resolvePoolScope(youthId)
    expect(scope.breakoutOwner).toEqual({ eventId: youthId })
    expect(scope.clusterBreakoutOwner).toEqual({ clusterId })
    expect(scope.candidateEventIds.sort()).toEqual([youthId, singlesId].sort())
  })

  it("leaves a Parallel event exactly as an unclustered one", async () => {
    const { youthId } = await seedDay("Parallel")
    const scope = await resolvePoolScope(youthId)
    expect(scope.breakoutOwner).toEqual({ eventId: youthId })
    expect(scope.clusterBreakoutOwner).toBeNull()
    expect(scope.candidateEventIds).toEqual([youthId])
  })
})

// ─── An event keeps its own pool inside a cluster ────────────────────────────

describe("a member event keeps its own tables and its own Catch Mech", () => {
  it("finds the event's own tables through the Catch Mech scope on a Collab", async () => {
    // The bug: joining a Collab replaced the event's tables with the cluster's in
    // `catchMechScopeFor`, and every Catch Mech read filters on
    // `breakoutGroupId IN <that scope>` — so the event's whole follow-up history
    // fell out of every screen at once. Nothing was deleted; it was unreachable.
    const { youthId } = await seedDay("Collab")
    const standing = await db.breakoutGroup.create({
      data: { eventId: youthId, name: "Youth Cell A" },
      select: { id: true },
    })

    const scope = await resolveCatchMechScope(youthId)
    const visible = await db.breakoutGroup.findMany({
      where: scope.where,
      select: { id: true },
    })

    expect(scope.viaCluster).toBe(true)
    expect(visible.map((g) => g.id)).toContain(standing.id)
  })

  it("still endorses a cluster table to the ministry that staffs it", async () => {
    // The other half: the day's tables must not fall out either. Both sets, or
    // the fix would just have moved the blind spot.
    const { clusterId, youthId, singlesId } = await seedDay("Collab")
    const host = await seedMember("Host")
    const volunteer = await seedVolunteer(youthId, host.id)
    const dayTable = await db.breakoutGroup.create({
      data: { clusterId, name: "Collab Table 1", facilitatorId: volunteer.id },
      select: { id: true },
    })
    const ownTable = await db.breakoutGroup.create({
      data: { eventId: youthId, name: "Youth Cell A" },
      select: { id: true },
    })

    const youthScope = await resolveCatchMechScope(youthId)
    const youthVisible = await db.breakoutGroup.findMany({
      where: youthScope.where,
      select: { id: true },
    })
    expect(youthVisible.map((g) => g.id).sort()).toEqual([dayTable.id, ownTable.id].sort())

    // Singles staffs nothing, so the day's table is not endorsed to it — and
    // Youth's standing table was never theirs to begin with.
    const singlesScope = await resolveCatchMechScope(singlesId)
    const singlesVisible = await db.breakoutGroup.findMany({
      where: singlesScope.where,
      select: { id: true },
    })
    expect(singlesVisible).toEqual([])
  })

  it("seats a registrant at the event's OWN table when the event asks", async () => {
    // `breakoutOwner` is the event's, so a per-event surface fills the event's
    // standing set — inside a collab exactly as outside one.
    const { clusterId, youthId } = await seedDay("Collab")
    const scope = await resolvePoolScope(youthId)
    expect(scope.breakoutOwner).toEqual({ eventId: youthId })
    expect(scope.clusterBreakoutOwner).toEqual({ clusterId })

    const person = await seedMember("Attendee")
    const reg = await seedRegistrant(youthId, person.id)
    const standing = await db.breakoutGroup.create({
      data: { eventId: youthId, name: "Youth Cell A" },
      select: { id: true },
    })

    const result = await addRegistrantsToBreakout(standing.id, [reg.id], scope.breakoutOwner)
    expect(result.success).toBe(true)
    // Read back through the same seam the registrant screens use: it resolves the
    // owner itself, and on a collab that owner is now the event's own set.
    expect(await getRegistrantBreakoutGroupName(reg.id, youthId)).toEqual({
      name: "Youth Cell A",
    })
  })

  it("counts a seat at either set as seated, for the unseated figure", async () => {
    // `seatedWhere` is the wider of the two: someone at the day's table is not
    // "nobody sat them anywhere", even though that table is the cluster's.
    const { clusterId, youthId } = await seedDay("Collab")
    const person = await seedMember("Seated")
    const reg = await seedRegistrant(youthId, person.id)
    const dayTable = await db.breakoutGroup.create({
      data: { clusterId, name: "Collab Table 1" },
      select: { id: true },
    })
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: dayTable.id, registrantId: reg.id },
    })

    const scope = await resolveCatchMechScope(youthId)
    const unseated = await db.eventRegistrant.findMany({
      where: { eventId: youthId, ...unassignedCandidateWhere(scope.seatedWhere) },
      select: { id: true },
    })
    expect(unseated.map((r) => r.id)).not.toContain(reg.id)
  })
})

// ─── Cross-event seating ─────────────────────────────────────────────────────

describe("cluster-owned tables seat either ministry's registrants", () => {
  it("accepts a registrant from each member event into one cluster table", async () => {
    const { clusterId, youthId, singlesId } = await seedDay("Collab")
    const table = await db.breakoutGroup.create({
      data: { clusterId, name: "Table 1" },
      select: { id: true },
    })

    const josh = await seedMember("Josh")
    const maria = await seedMember("Maria")
    const joshReg = await seedRegistrant(youthId, josh.id)
    const mariaReg = await seedRegistrant(singlesId, maria.id)

    const result = await addRegistrantsToBreakout(
      table.id,
      [joshReg.id, mariaReg.id],
      { clusterId }
    )
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.added).toBe(2)

    const seats = await db.breakoutGroupMember.count({
      where: { breakoutGroupId: table.id },
    })
    expect(seats).toBe(2)
  })

  it("refuses a registrant from outside the day", async () => {
    const { clusterId } = await seedDay("Collab")
    const other = await db.event.create({
      data: { name: "Unrelated", type: "OneTime", startDate: DAY, endDate: DAY },
      select: { id: true },
    })
    const table = await db.breakoutGroup.create({
      data: { clusterId, name: "Table 1" },
      select: { id: true },
    })
    const outsider = await seedMember("Outsider")
    const reg = await seedRegistrant(other.id, outsider.id)

    const result = await addRegistrantsToBreakout(table.id, [reg.id], { clusterId })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.added).toBe(0)
      expect(result.data.failed[0].reason).toContain("event day")
    }
  })

  it("keeps an event-owned table refusing the partner event's registrant", async () => {
    const { youthId, singlesId } = await seedDay("Collab")
    const standing = await db.breakoutGroup.create({
      data: { eventId: youthId, name: "Youth Cell A" },
      select: { id: true },
    })
    const maria = await seedMember("Maria")
    const mariaReg = await seedRegistrant(singlesId, maria.id)

    const result = await addRegistrantsToBreakout(standing.id, [mariaReg.id], {
      eventId: youthId,
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.added).toBe(0)
  })
})

// ─── The recurring-registrant finding ────────────────────────────────────────

describe("a standing placement does not block the day's table", () => {
  it("keeps a member already seated in their ministry's own group eligible", async () => {
    const { clusterId, youthId } = await seedDay("Collab")

    // A Youth regular: one long-lived registrant row, already seated in Youth's
    // standing table. Under a global `breakoutGroupMemberships: { none: {} }` this
    // person — and every regular like them — would be invisible to the collab.
    const regular = await seedMember("Regular")
    const reg = await seedRegistrant(youthId, regular.id)
    const standing = await db.breakoutGroup.create({
      data: { eventId: youthId, name: "Youth Cell A" },
      select: { id: true },
    })
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: standing.id, registrantId: reg.id },
    })

    const eligible = await db.eventRegistrant.findMany({
      where: { eventId: youthId, ...unassignedCandidateWhere({ clusterId }) },
      select: { id: true },
    })
    expect(eligible.map((e) => e.id)).toContain(reg.id)

    // …and the event's own page still sees them as taken.
    const forEvent = await db.eventRegistrant.findMany({
      where: { eventId: youthId, ...unassignedCandidateWhere({ eventId: youthId }) },
      select: { id: true },
    })
    expect(forEvent.map((e) => e.id)).not.toContain(reg.id)
  })
})

// ─── One seat per person ─────────────────────────────────────────────────────

describe("one seat per person across the day", () => {
  it("refuses a second registrant row for someone already seated", async () => {
    const { clusterId, youthId, singlesId } = await seedDay("Collab")
    const table1 = await db.breakoutGroup.create({
      data: { clusterId, name: "Table 1" },
      select: { id: true },
    })
    const table2 = await db.breakoutGroup.create({
      data: { clusterId, name: "Table 2" },
      select: { id: true },
    })

    // A Collab registers one person to every member event, so Maria has two rows.
    const maria = await seedMember("Maria")
    const rowA = await seedRegistrant(youthId, maria.id)
    const rowB = await seedRegistrant(singlesId, maria.id)

    const first = await addRegistrantsToBreakout(table1.id, [rowA.id], { clusterId })
    expect(first.success).toBe(true)

    const second = await addRegistrantsToBreakout(table2.id, [rowB.id], { clusterId })
    expect(second.success).toBe(true)
    if (second.success) {
      expect(second.data.added).toBe(0)
      expect(second.data.failed[0].reason).toContain("already in a breakout group")
    }
  })

  it("auto-assign at the day's kiosk does not seat the same person twice", async () => {
    const { clusterId, youthId, singlesId } = await seedDay("Collab")
    await db.breakoutGroup.createMany({
      data: [
        { clusterId, name: "Table 1" },
        { clusterId, name: "Table 2" },
      ],
    })
    // Auto-assign only runs when the event asks for it.
    await db.event.updateMany({
      where: { id: { in: [youthId, singlesId] } },
      data: { autoAssignBreakout: true },
    })

    const maria = await seedMember("Maria")
    const rowA = await seedRegistrant(youthId, maria.id)
    const rowB = await seedRegistrant(singlesId, maria.id)

    // The day's kiosk fills the day's set, and fires once per registrant row —
    // a Collab gives one person a row on every member event.
    await autoAssignRegistrantToBreakout(rowA.id, youthId, "cluster")
    await autoAssignRegistrantToBreakout(rowB.id, singlesId, "cluster")

    const seats = await db.breakoutGroupMember.count({
      where: { breakoutGroup: { clusterId } },
    })
    expect(seats).toBe(1)
  })

  it("won't add an event-set seat to someone already at the day's table", async () => {
    // A seat made for TODAY answers on every surface. Placement lands in one set,
    // but the day's table is the one actually being run, so a person it already
    // seated must not pick up a second seat at their own event's dormant standing
    // table on the way past its kiosk. The converse does NOT hold and is not
    // symmetric — see `surfaceBreakoutSet`, and the standing-seat case in
    // `checkin-breakout-pick.test.ts`.
    const { clusterId, youthId } = await seedDay("Collab")
    await db.event.update({
      where: { id: youthId },
      data: { autoAssignBreakout: true },
    })
    const dayTable = await db.breakoutGroup.create({
      data: { clusterId, name: "Collab Table 1" },
      select: { id: true },
    })
    await db.breakoutGroup.create({
      data: { eventId: youthId, name: "Youth Cell A" },
      select: { id: true },
    })

    const maria = await seedMember("Maria")
    const reg = await seedRegistrant(youthId, maria.id)
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: dayTable.id, registrantId: reg.id },
    })

    await autoAssignRegistrantToBreakout(reg.id, youthId)

    expect(await db.breakoutGroupMember.count()).toBe(1)
  })

  it("won't sweep the day's seated people into the event's tables in bulk", async () => {
    // The same rule at the bulk end, and the sharper failure of the two.
    // `autoAssignBreakouts` read "unassigned" and "already seated" through the
    // bare owner, so on a collab day EVERY person the day had seated came back as
    // unassigned and was seated a second time in the event's dormant standing
    // tables — in one click, for the whole roster. See `resolveSeatedScope`.
    const { clusterId, youthId } = await seedDay("Collab")
    const dayTable = await db.breakoutGroup.create({
      data: { clusterId, name: "Collab Table 1" },
      select: { id: true },
    })
    await db.breakoutGroup.create({
      data: { eventId: youthId, name: "Youth Cell A" },
      select: { id: true },
    })

    const maria = await seedMember("Maria")
    const reg = await seedRegistrant(youthId, maria.id)
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: dayTable.id, registrantId: reg.id },
    })

    const result = await autoAssignBreakouts({ eventId: youthId })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.assigned).toBe(0)
    // Still exactly the one seat the day gave them.
    const seats = await db.breakoutGroupMember.findMany({
      select: { breakoutGroupId: true },
    })
    expect(seats.map((s) => s.breakoutGroupId)).toEqual([dayTable.id])
  })

  it("still fills the event's own tables for someone the day has NOT seated", async () => {
    // The scope must narrow who counts as placed, not switch auto-assign off.
    const { youthId } = await seedDay("Collab")
    const standing = await db.breakoutGroup.create({
      data: { eventId: youthId, name: "Youth Cell A" },
      select: { id: true },
    })

    const maria = await seedMember("Maria")
    const reg = await seedRegistrant(youthId, maria.id)

    const result = await autoAssignBreakouts({ eventId: youthId })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.assigned).toBe(1)
    const seat = await db.breakoutGroupMember.findFirstOrThrow({
      where: { registrantId: reg.id },
      select: { breakoutGroupId: true },
    })
    expect(seat.breakoutGroupId).toBe(standing.id)
  })
})

// ─── The check-in success screen ─────────────────────────────────────────────

describe("getRegistrantBreakoutGroupName", () => {
  it("finds a cluster-owned table for a member event's registrant", async () => {
    const { clusterId, youthId } = await seedDay("Collab")
    const table = await db.breakoutGroup.create({
      data: { clusterId, name: "Table 7" },
      select: { id: true },
    })
    const josh = await seedMember("Josh")
    const reg = await seedRegistrant(youthId, josh.id)
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: table.id, registrantId: reg.id },
    })

    // Previously scoped `breakoutGroup: { eventId }`, so a cluster-owned table
    // matched nothing and the public success screen said "no group".
    await expect(getRegistrantBreakoutGroupName(reg.id, youthId)).resolves.toEqual({
      name: "Table 7",
    })
  })
})

// ─── The volunteer union ─────────────────────────────────────────────────────

describe("volunteers pool as a union", () => {
  it("lets the partner ministry's volunteer run one of the day's tables", async () => {
    const { clusterId, singlesId } = await seedDay("Collab")
    const table = await db.breakoutGroup.create({
      data: { clusterId, name: "Table 1" },
      select: { id: true },
    })
    const ana = await seedMember("Ana")
    const volunteer = await seedVolunteer(singlesId, ana.id)

    const result = await setFacilitator(table.id, volunteer.id, "facilitator", {
      clusterId,
    })
    expect(result.success).toBe(true)

    const saved = await db.breakoutGroup.findUnique({
      where: { id: table.id },
      select: { facilitatorId: true },
    })
    expect(saved?.facilitatorId).toBe(volunteer.id)
  })

  it("still refuses a volunteer from outside the day", async () => {
    const { clusterId } = await seedDay("Collab")
    const other = await db.event.create({
      data: { name: "Unrelated", type: "OneTime", startDate: DAY, endDate: DAY },
      select: { id: true },
    })
    const table = await db.breakoutGroup.create({
      data: { clusterId, name: "Table 1" },
      select: { id: true },
    })
    const stranger = await seedMember("Stranger")
    const volunteer = await seedVolunteer(other.id, stranger.id)

    const result = await setFacilitator(table.id, volunteer.id, "facilitator", {
      clusterId,
    })
    expect(result.success).toBe(false)
  })

  it("keeps an event-owned table refusing the partner's volunteer", async () => {
    const { youthId, singlesId } = await seedDay("Collab")
    const standing = await db.breakoutGroup.create({
      data: { eventId: youthId, name: "Youth Cell A" },
      select: { id: true },
    })
    const ana = await seedMember("Ana")
    const volunteer = await seedVolunteer(singlesId, ana.id)

    const result = await setFacilitator(standing.id, volunteer.id, "facilitator", {
      eventId: youthId,
    })
    expect(result.success).toBe(false)
  })
})

// ─── Carry-over ──────────────────────────────────────────────────────────────

describe("carryOverBreakoutGroups", () => {
  it("copies definitions, facilitators and schedules without members by default", async () => {
    const { clusterId, youthId } = await seedDay("Collab")
    const lifeStage = await db.lifeStage.create({
      data: { name: "Youth", order: 1 },
      select: { id: true },
    })
    const ana = await seedMember("Ana")
    const volunteer = await seedVolunteer(youthId, ana.id)
    const source = await db.breakoutGroup.create({
      data: {
        eventId: youthId,
        name: "Cell A",
        facilitatorId: volunteer.id,
        memberLimit: 8,
        genderFocus: "Mixed",
        language: ["English"],
        locationCity: "Pasig",
        lifeStages: { connect: [{ id: lifeStage.id }] },
        schedules: { create: [{ dayOfWeek: 6, timeStart: "18:00", timeEnd: "20:00" }] },
      },
      select: { id: true },
    })
    // Somebody already sitting in the source group.
    const josh = await seedMember("Josh")
    const joshReg = await seedRegistrant(youthId, josh.id)
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: source.id, registrantId: joshReg.id },
    })

    const result = await carryOverBreakoutGroups(clusterId, youthId, {
      includeMembers: false,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.created).toBe(1)
      expect(result.data.membersCopied).toBe(0)
    }

    const copy = await db.breakoutGroup.findFirst({
      where: { clusterId },
      include: { lifeStages: true, schedules: true, _count: { select: { members: true } } },
    })
    expect(copy?.name).toBe("Cell A")
    expect(copy?.facilitatorId).toBe(volunteer.id)
    expect(copy?.memberLimit).toBe(8)
    expect(copy?.locationCity).toBe("Pasig")
    expect(copy?.lifeStages.map((l) => l.id)).toEqual([lifeStage.id])
    expect(copy?.schedules).toHaveLength(1)
    expect(copy?._count.members).toBe(0)

    // The source is untouched — a copy, never a move.
    const srcAfter = await db.breakoutGroup.findUnique({
      where: { id: source.id },
      select: { eventId: true, _count: { select: { members: true } } },
    })
    expect(srcAfter?.eventId).toBe(youthId)
    expect(srcAfter?._count.members).toBe(1)
  })

  it("copies members when asked, and skips anyone already seated on the day", async () => {
    const { clusterId, youthId } = await seedDay("Collab")
    const source = await db.breakoutGroup.create({
      data: { eventId: youthId, name: "Cell A" },
      select: { id: true },
    })
    const josh = await seedMember("Josh")
    const maria = await seedMember("Maria")
    const joshReg = await seedRegistrant(youthId, josh.id)
    const mariaReg = await seedRegistrant(youthId, maria.id)
    await db.breakoutGroupMember.createMany({
      data: [
        { breakoutGroupId: source.id, registrantId: joshReg.id },
        { breakoutGroupId: source.id, registrantId: mariaReg.id },
      ],
    })
    // Maria is already at one of the day's tables.
    const existing = await db.breakoutGroup.create({
      data: { clusterId, name: "Table 1" },
      select: { id: true },
    })
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: existing.id, registrantId: mariaReg.id },
    })

    const result = await carryOverBreakoutGroups(clusterId, youthId, {
      includeMembers: true,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.membersCopied).toBe(1)
      expect(result.data.membersSkipped).toBe(1)
    }
  })

  it("suffixes a name that already exists on the day", async () => {
    const { clusterId, youthId } = await seedDay("Collab")
    await db.breakoutGroup.create({ data: { clusterId, name: "Cell A" } })
    await db.breakoutGroup.create({ data: { eventId: youthId, name: "Cell A" } })

    const result = await carryOverBreakoutGroups(clusterId, youthId, {
      includeMembers: false,
    })
    expect(result.success).toBe(true)

    const names = (
      await db.breakoutGroup.findMany({ where: { clusterId }, select: { name: true } })
    ).map((g) => g.name)
    expect(names.sort()).toEqual(["Cell A", "Cell A (2)"])
  })

  it("refuses an event outside the cluster", async () => {
    const { clusterId } = await seedDay("Collab")
    const other = await db.event.create({
      data: { name: "Unrelated", type: "OneTime", startDate: DAY, endDate: DAY },
      select: { id: true },
    })
    await db.breakoutGroup.create({ data: { eventId: other.id, name: "Cell A" } })

    const result = await carryOverBreakoutGroups(clusterId, other.id, {
      includeMembers: false,
    })
    expect(result.success).toBe(false)
  })

  it("refuses a Parallel day — it has no tables of its own", async () => {
    const { clusterId, youthId } = await seedDay("Parallel")
    await db.breakoutGroup.create({ data: { eventId: youthId, name: "Cell A" } })

    const result = await carryOverBreakoutGroups(clusterId, youthId, {
      includeMembers: false,
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("collab")
  })

  it("honours the source group's member limit", async () => {
    const { clusterId, youthId } = await seedDay("Collab")
    const source = await db.breakoutGroup.create({
      data: { eventId: youthId, name: "Cell A", memberLimit: 1 },
      select: { id: true },
    })
    for (const name of ["A", "B", "C"]) {
      const m = await seedMember(name)
      const r = await seedRegistrant(youthId, m.id)
      await db.breakoutGroupMember.create({
        data: { breakoutGroupId: source.id, registrantId: r.id },
      })
    }

    const result = await carryOverBreakoutGroups(clusterId, youthId, {
      includeMembers: true,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.membersCopied).toBe(1)
      expect(result.data.membersSkipped).toBe(2)
    }
  })
})

// ─── Ministry routing ────────────────────────────────────────────────────────

describe("registerForCluster on a Collab day", () => {
  async function openDay(kind: "Parallel" | "Collab") {
    const cluster = await db.eventCluster.create({
      data: {
        name: "Youth × Singles Night",
        date: DAY,
        kind,
        isOpen: true,
        publicToken: `tok-${kind.toLowerCase()}`,
      },
      select: { id: true, publicToken: true },
    })
    const youthMinistry = await db.ministry.create({
      data: { name: "Youth", logoUrl: "https://images.ccfeastwood.app/youth.png" },
      select: { id: true },
    })
    const singlesMinistry = await db.ministry.create({
      data: { name: "Singles" },
      select: { id: true },
    })
    const youth = await db.event.create({
      data: {
        name: "Youth Night",
        type: "OneTime",
        startDate: DAY,
        endDate: DAY,
        ministries: { create: [{ ministryId: youthMinistry.id }] },
      },
      select: { id: true },
    })
    const singles = await db.event.create({
      data: {
        name: "Singles Connect",
        type: "OneTime",
        startDate: DAY,
        endDate: DAY,
        ministries: { create: [{ ministryId: singlesMinistry.id }] },
      },
      select: { id: true },
    })
    await db.eventClusterEvent.createMany({
      data: [
        { clusterId: cluster.id, eventId: youth.id, order: 0 },
        { clusterId: cluster.id, eventId: singles.id, order: 1 },
      ],
    })
    await db.eventModule.createMany({
      data: [
        { eventId: youth.id, type: "Breakout" },
        { eventId: singles.id, type: "Breakout" },
      ],
    })
    return { ...cluster, youthId: youth.id, singlesId: singles.id }
  }

  const payload = {
    firstName: "Maria",
    lastName: "Cruz",
    mobileNumber: "0917 111 2222",
  }

  it("registers to the one event the chosen ministry names", async () => {
    const day = await openDay("Collab")

    // The form sends the event id behind the ministry the person picked.
    const result = await registerForCluster(
      day.publicToken,
      payload,
      null,
      null,
      undefined,
      [day.singlesId]
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.results).toHaveLength(1)
      expect(result.data.results[0].eventId).toBe(day.singlesId)
    }

    const rows = await db.eventRegistrant.findMany({ select: { eventId: true } })
    expect(rows.map((r) => r.eventId)).toEqual([day.singlesId])
  })

  it("refuses a submission with no ministry chosen", async () => {
    const day = await openDay("Collab")

    const result = await registerForCluster(
      day.publicToken,
      payload,
      null,
      null,
      undefined,
      []
    )
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("ministry")
    expect(await db.eventRegistrant.count()).toBe(0)
  })

  it("refuses a payload claiming both ministries", async () => {
    const day = await openDay("Collab")

    const result = await registerForCluster(
      day.publicToken,
      payload,
      null,
      null,
      undefined,
      [day.youthId, day.singlesId]
    )
    expect(result.success).toBe(false)
    expect(await db.eventRegistrant.count()).toBe(0)
  })

  it("places them at one table and files one seeker request", async () => {
    const day = await openDay("Collab")
    // `wantsSmallGroup` is stripped by `sanitizeRegistrantPayload` unless the
    // day's shared form actually collects it.
    await db.eventFormConfig.create({
      data: { clusterId: day.id, context: "Register", sectionSmallGroup: true },
    })
    await db.breakoutGroup.createMany({
      data: [
        { clusterId: day.id, name: "Table 1" },
        { clusterId: day.id, name: "Table 2" },
      ],
    })
    await db.event.updateMany({
      where: { id: { in: [day.youthId, day.singlesId] } },
      data: { autoAssignBreakout: true },
    })

    const result = await registerForCluster(
      day.publicToken,
      { ...payload, wantsSmallGroup: true },
      null,
      null,
      undefined,
      [day.youthId]
    )
    expect(result.success).toBe(true)

    expect(await db.eventRegistrant.count()).toBe(1)
    expect(await db.breakoutGroupMember.count()).toBe(1)
    expect(await db.smallGroupMemberRequest.count()).toBe(1)
  })

  it("still honours the tickboxes on a Parallel day", async () => {
    const day = await openDay("Parallel")

    const result = await registerForCluster(
      day.publicToken,
      payload,
      null,
      null,
      undefined,
      [day.youthId, day.singlesId]
    )
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.results).toHaveLength(2)
    expect(await db.eventRegistrant.count()).toBe(2)
  })

  it("reports closed when the chosen ministry's event has shut registration", async () => {
    const day = await openDay("Collab")
    await db.event.update({
      where: { id: day.singlesId },
      data: {
        registrationStart: new Date("2026-08-01T00:00:00.000Z"),
        registrationEnd: new Date("2026-08-02T00:00:00.000Z"),
      },
    })

    const result = await registerForCluster(
      day.publicToken,
      payload,
      null,
      null,
      undefined,
      [day.singlesId]
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.results).toHaveLength(1)
      expect(result.data.results[0].status).toBe("closed")
    }
    expect(await db.eventRegistrant.count()).toBe(0)
  })

  // ── The reported bug ──
  //
  // Amending re-opens an existing registration, and the ministry step isn't part
  // of that form: the person already answered it when they first registered.
  // The submission therefore arrives with an empty selection, which must resolve
  // to the registration being amended rather than erroring — the shipped version
  // told them to "select an event" on a screen with no event picker on it.
  it("resolves an empty selection to the registration already held", async () => {
    const day = await openDay("Collab")
    const member = await db.member.create({
      data: {
        firstName: "Maria",
        lastName: "Cruz",
        dateJoined: new Date(),
        language: [],
        phone: "+63 917 111 2222",
      },
      select: { id: true },
    })
    // Stamped for this day, because that is the only way an amend arises: the
    // person registered through the day's shared form, and it is that
    // registration they are re-opening. An *unstamped* row on a member event is a
    // different thing entirely — see `cluster-collab-fresh-list.test.ts`.
    await db.eventRegistrant.create({
      data: { eventId: day.singlesId, memberId: member.id, registrationClusterId: day.id },
    })

    const result = await registerForCluster(
      day.publicToken,
      payload,
      member.id,
      null,
      undefined,
      []
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.results).toHaveLength(1)
      expect(result.data.results[0].eventId).toBe(day.singlesId)
      expect(result.data.results[0].status).toBe("already")
    }
    // Reused, not duplicated.
    expect(await db.eventRegistrant.count()).toBe(1)
  })

  it("asks for the ministry when there is no registration to fall back on", async () => {
    const day = await openDay("Collab")
    const member = await db.member.create({
      data: { firstName: "New", lastName: "Person", dateJoined: new Date(), language: [] },
      select: { id: true },
    })

    const result = await registerForCluster(
      day.publicToken,
      payload,
      member.id,
      null,
      undefined,
      []
    )
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("ministry")
  })
})

// ─── The collab precondition ─────────────────────────────────────────────────
//
// A collab form's only question is "which ministry are you part of?", which has
// an answer only when every member event names exactly one ministry and no two
// name the same. The guard lives on the writes rather than only in the UI: `kind`
// is a plain enum column, and a day that slipped into Collab misconfigured would
// put an unanswerable question in front of every registrant.

describe("switching a day to Collab", () => {
  async function dayWith(
    events: { name: string; ministries?: string[]; allMinistries?: boolean }[]
  ) {
    const cluster = await db.eventCluster.create({
      data: { name: "Day", date: DAY, kind: "Parallel" },
      select: { id: true },
    })
    let order = 0
    for (const spec of events) {
      const ministryIds: string[] = []
      for (const name of spec.ministries ?? []) {
        const existing = await db.ministry.findUnique({ where: { name } })
        ministryIds.push(
          existing?.id ??
            (await db.ministry.create({ data: { name }, select: { id: true } })).id
        )
      }
      const event = await db.event.create({
        data: {
          name: spec.name,
          type: "OneTime",
          startDate: DAY,
          endDate: DAY,
          allMinistries: spec.allMinistries ?? false,
          ministries: { create: ministryIds.map((id) => ({ ministryId: id })) },
        },
        select: { id: true },
      })
      await db.eventClusterEvent.create({
        data: { clusterId: cluster.id, eventId: event.id, order: order++ },
      })
    }
    return cluster.id
  }

  async function toCollab(clusterId: string) {
    return updateEventCluster(clusterId, { kind: "Collab" })
  }

  it("succeeds when each event names one distinct ministry", async () => {
    const id = await dayWith([
      { name: "Youth Night", ministries: ["Youth"] },
      { name: "Singles Connect", ministries: ["Singles"] },
    ])
    const result = await toCollab(id)
    expect(result.success).toBe(true)

    const after = await db.eventCluster.findUnique({
      where: { id },
      select: { kind: true },
    })
    expect(after?.kind).toBe("Collab")
  })

  it("refuses when an event has no ministry", async () => {
    const id = await dayWith([
      { name: "Youth Night", ministries: ["Youth"] },
      { name: "Singles Connect" },
    ])
    const result = await toCollab(id)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("no ministry set")
  })

  it("refuses a church-wide event — every ministry is no single answer", async () => {
    const id = await dayWith([
      { name: "Youth Night", ministries: ["Youth"] },
      { name: "All Church", allMinistries: true },
    ])
    const result = await toCollab(id)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("church-wide")
  })

  it("refuses an event naming several ministries", async () => {
    const id = await dayWith([
      { name: "Youth Night", ministries: ["Youth", "Kids"] },
      { name: "Singles Connect", ministries: ["Singles"] },
    ])
    const result = await toCollab(id)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("exactly one")
  })

  it("refuses two events sharing one ministry — registrants couldn't tell them apart", async () => {
    const id = await dayWith([
      { name: "Singles Connect", ministries: ["Singles"] },
      { name: "Young Pros", ministries: ["Singles"] },
    ])
    const result = await toCollab(id)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("both under Singles")
  })

  it("refuses an empty day", async () => {
    const id = await dayWith([])
    const result = await toCollab(id)
    expect(result.success).toBe(false)
  })

  it("leaves an unrelated settings save alone", async () => {
    const id = await dayWith([{ name: "Youth Night" }])
    // No `kind` in the payload, so the guard must not fire on a day that
    // wouldn't qualify anyway.
    const result = await updateEventCluster(id, { name: "Renamed" })
    expect(result.success).toBe(true)
  })
})

describe("adding an event to a Collab day", () => {
  async function collabDay() {
    const cluster = await db.eventCluster.create({
      data: { name: "Day", date: DAY, kind: "Collab" },
      select: { id: true },
    })
    const ministry = await db.ministry.create({
      data: { name: "Youth" },
      select: { id: true },
    })
    const youth = await db.event.create({
      data: {
        name: "Youth Night",
        type: "OneTime",
        startDate: DAY,
        endDate: DAY,
        ministries: { create: [{ ministryId: ministry.id }] },
      },
      select: { id: true },
    })
    await db.eventClusterEvent.create({
      data: { clusterId: cluster.id, eventId: youth.id, order: 0 },
    })
    return cluster.id
  }

  async function candidate(name: string, ministryName?: string) {
    const ministryIds: string[] = []
    if (ministryName) {
      const existing = await db.ministry.findUnique({ where: { name: ministryName } })
      ministryIds.push(
        existing?.id ??
          (await db.ministry.create({ data: { name: ministryName }, select: { id: true } })).id
      )
    }
    return db.event.create({
      data: {
        name,
        type: "OneTime",
        startDate: DAY,
        endDate: DAY,
        ministries: { create: ministryIds.map((id) => ({ ministryId: id })) },
      },
      select: { id: true },
    })
  }

  it("accepts an event under a ministry not yet represented", async () => {
    const clusterId = await collabDay()
    const singles = await candidate("Singles Connect", "Singles")
    const result = await addEventToCluster(clusterId, singles.id)
    expect(result.success).toBe(true)
  })

  it("refuses an event with no ministry", async () => {
    const clusterId = await collabDay()
    const orphan = await candidate("Mystery Event")
    const result = await addEventToCluster(clusterId, orphan.id)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("no ministry set")
    expect(await db.eventClusterEvent.count({ where: { clusterId } })).toBe(1)
  })

  it("refuses an event duplicating a ministry already on the day", async () => {
    const clusterId = await collabDay()
    const second = await candidate("Youth Extra", "Youth")
    const result = await addEventToCluster(clusterId, second.id)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("both under Youth")
  })

  it("lets a Parallel day take an event with no ministry", async () => {
    const cluster = await db.eventCluster.create({
      data: { name: "Day", date: DAY, kind: "Parallel" },
      select: { id: true },
    })
    const orphan = await candidate("Mystery Event")
    const result = await addEventToCluster(cluster.id, orphan.id)
    expect(result.success).toBe(true)
  })
})

// ─── The day's public surfaces are revalidated too ───────────────────────────

describe("revalidating a cluster-owned table's public surfaces", () => {
  /**
   * The cluster branch of `revalidateBreakoutSurfaces` used to stop at the
   * workspace, so a table added to the day never invalidated the shared form,
   * the door or the kiosk — while the event branch had always invalidated its
   * own. Nothing about a collab day makes its public pickers less public.
   *
   * By ROUTE rather than by path, because a cluster's public surfaces are keyed
   * by `publicToken` and the function is handed an owner carrying the cluster's
   * *id*.
   */
  const PUBLIC_ROUTES = [
    "/register/c/[token]",
    "/register/c/[token]/walk-in",
    "/register/c/[token]/check-in",
  ]

  function revalidatedPaths() {
    return vi.mocked(revalidatePath).mock.calls.map((c) => c[0])
  }

  it("revalidates them when a table is added to the day", async () => {
    const { clusterId } = await seedDay("Collab")
    vi.mocked(revalidatePath).mockClear()

    const result = await createBreakoutGroup(
      { clusterId },
      { name: "Collab Table 1", lifeStageIds: [], language: [] }
    )

    expect(result.success).toBe(true)
    for (const route of PUBLIC_ROUTES) expect(revalidatedPaths()).toContain(route)
  })

  it("revalidates them when a table is removed from the day", async () => {
    const { clusterId } = await seedDay("Collab")
    const group = await db.breakoutGroup.create({
      data: { clusterId, name: "Collab Table 1" },
      select: { id: true },
    })
    vi.mocked(revalidatePath).mockClear()

    const result = await deleteBreakoutGroup(group.id, { clusterId })

    expect(result.success).toBe(true)
    for (const route of PUBLIC_ROUTES) expect(revalidatedPaths()).toContain(route)
  })

  it("still revalidates the day's own workspace", async () => {
    // The public routes are an addition, not a replacement.
    const { clusterId } = await seedDay("Collab")
    vi.mocked(revalidatePath).mockClear()

    await createBreakoutGroup(
      { clusterId },
      { name: "Collab Table 1", lifeStageIds: [], language: [] }
    )

    expect(revalidatedPaths()).toContain(`/cluster/${clusterId}/breakouts`)
  })

  it("never sends an event's table to the cluster's public routes", async () => {
    // The reason the helper is centralised: an event-owned group must not
    // invalidate a day it has nothing to do with.
    const { youthId } = await seedDay("Collab")
    vi.mocked(revalidatePath).mockClear()

    await createBreakoutGroup(
      { eventId: youthId },
      { name: "Youth Cell A", lifeStageIds: [], language: [] }
    )

    for (const route of PUBLIC_ROUTES) expect(revalidatedPaths()).not.toContain(route)
    expect(revalidatedPaths()).toContain(`/events/${youthId}/walk-in`)
  })
})
