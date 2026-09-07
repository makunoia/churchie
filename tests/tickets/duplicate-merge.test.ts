import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: "test-admin", role: "SuperAdmin", permissions: [], eventAccess: [] },
  }),
}))

import { db } from "@/lib/db"
import { portalTokenWhere } from "@/lib/people/portal-tokens"
import { setUpwardSatellite, declareLeaderAndJoin } from "@/app/me/[token]/actions"
import {
  resolveDuplicateGroup,
  resolveDuplicateGroups,
} from "@/app/(dashboard)/settings/duplicate-profiles/actions"

afterAll(async () => {
  await db.$disconnect()
})

beforeEach(async () => {
  await db.$executeRaw`TRUNCATE
    "ConfirmationSubmission", "CatchMechVolunteerSession", "CatchMechSession",
    "OccurrenceSubFacilitator", "BreakoutGroupMember", "BreakoutGroup",
    "BaptismOptIn", "BusPassenger", "Bus",
    "OccurrenceAttendee", "EventOccurrence", "EventRegistrant",
    "EventModule", "Event", "Volunteer", "CommitteeRole", "VolunteerCommittee",
    "SmallGroupMemberRequest", "SmallGroupLog", "SmallGroup",
    "MemberLog", "SchedulePreference", "FamilyMember", "Family",
    "Guest", "Member", "LifeStage"
    RESTART IDENTITY CASCADE`
})

async function seedMember(overrides: Partial<{
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  address: string | null
  birthYear: number | null
  workCity: string | null
}> = {}) {
  return db.member.create({
    data: {
      firstName: overrides.firstName ?? "Juan",
      lastName: overrides.lastName ?? "Cruz",
      email: overrides.email ?? null,
      phone: overrides.phone ?? null,
      address: overrides.address ?? null,
      birthYear: overrides.birthYear ?? null,
      workCity: overrides.workCity ?? null,
      dateJoined: new Date(),
      language: [],
    },
  })
}

async function seedGuest(overrides: Partial<{
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  workCity: string | null
  birthYear: number | null
}> = {}) {
  return db.guest.create({
    data: {
      firstName: overrides.firstName ?? "Juan",
      lastName: overrides.lastName ?? "Cruz",
      email: overrides.email ?? null,
      phone: overrides.phone ?? null,
      workCity: overrides.workCity ?? null,
      birthYear: overrides.birthYear ?? null,
      language: [],
    },
  })
}

async function seedEvent() {
  return db.event.create({
    data: {
      name: "Test Event",
      type: "OneTime",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-01"),
    },
  })
}

describe("resolveDuplicateGroup", () => {
  describe("member → member", () => {
    it("merges loser into keeper, transferring event registrations", async () => {
      const keeper = await seedMember({ email: "k@example.com" })
      const loser = await seedMember({ email: "l@example.com" })
      const [eventA, eventB] = [await seedEvent(), await seedEvent()]

      await db.eventRegistrant.create({ data: { eventId: eventA.id, memberId: keeper.id } })
      await db.eventRegistrant.create({ data: { eventId: eventB.id, memberId: loser.id } })

      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "member",
        losers: [{ id: loser.id, type: "member" }],
      })

      expect(result).toEqual({ success: true, data: { merged: 1 } })
      expect(await db.member.findUnique({ where: { id: loser.id } })).toBeNull()
      // Different events, so both registrations survive on the keeper.
      expect(await db.eventRegistrant.count({ where: { memberId: keeper.id } })).toBe(2)
    })

    it("fills the keeper's null fields from the loser (keeper still wins on conflicts)", async () => {
      const keeper = await seedMember({ firstName: "Juan", workCity: null, birthYear: null, address: "Keeper Address" })
      const loser = await seedMember({ firstName: "Jon",  workCity: "Makati", birthYear: 1995, address: "Loser Address" })

      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "member",
        losers: [{ id: loser.id, type: "member" }],
      })

      expect(result.success).toBe(true)
      const merged = await db.member.findUnique({ where: { id: keeper.id } })
      // Filled from loser because keeper was null
      expect(merged?.workCity).toBe("Makati")
      expect(merged?.birthYear).toBe(1995)
      // Keeper wins because it already had a value
      expect(merged?.firstName).toBe("Juan")
      expect(merged?.address).toBe("Keeper Address")
    })

    it("fills a unique field (email) from the loser without a unique-constraint collision", async () => {
      // Phone-grouped duplicate: keeper has no email, loser does. Filling the
      // keeper's email from the loser must not collide with the loser's own
      // still-present email (the bug — loser was deleted after the keeper update).
      const keeper = await seedMember({ phone: "+639170000099", email: null })
      const loser = await seedMember({ phone: "+639170000099", email: "loser@example.com", firstName: "Maria" })

      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "member",
        losers: [{ id: loser.id, type: "member" }],
      })

      expect(result.success).toBe(true)
      const merged = await db.member.findUnique({ where: { id: keeper.id } })
      expect(merged?.email).toBe("loser@example.com")
      expect(await db.member.findUnique({ where: { id: loser.id } })).toBeNull()
    })

    it("re-points groups led by the loser to the keeper", async () => {
      const keeper = await seedMember()
      const loser = await seedMember({ firstName: "Maria" })
      const group = await db.smallGroup.create({
        data: { name: "Loser-led Group", leaderId: loser.id },
      })

      await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "member",
        losers: [{ id: loser.id, type: "member" }],
      })

      const updated = await db.smallGroup.findUnique({ where: { id: group.id } })
      expect(updated?.leaderId).toBe(keeper.id)
    })

    it("transfers schedule preferences and volunteer rows", async () => {
      const keeper = await seedMember()
      const loser = await seedMember({ firstName: "Maria" })
      const event = await seedEvent()
      const committee = await db.volunteerCommittee.create({
        data: { name: "Hospitality", eventId: event.id },
      })
      const role = await db.committeeRole.create({
        data: { name: "Greeter", committeeId: committee.id },
      })
      await db.volunteer.create({
        data: {
          memberId: loser.id,
          eventId: event.id,
          committeeId: committee.id,
          preferredRoleId: role.id,
        },
      })
      await db.schedulePreference.create({
        data: { memberId: loser.id, dayOfWeek: 3, timeStart: "19:00", timeEnd: "21:00" },
      })

      await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "member",
        losers: [{ id: loser.id, type: "member" }],
      })

      expect(await db.volunteer.count({ where: { memberId: keeper.id } })).toBe(1)
      expect(await db.volunteer.count({ where: { memberId: loser.id } })).toBe(0)
      expect(await db.schedulePreference.count({ where: { memberId: keeper.id } })).toBe(1)
      expect(await db.member.findUnique({ where: { id: loser.id } })).toBeNull()
    })

    it("deletes the loser's promoted guest, moving its history to the keeper member", async () => {
      // A Guest hanging off a Member being deleted is a second identity on a record the
      // admin chose to remove. Leaving it behind would resurrect it as an active guest
      // the moment `Guest.memberId` was nulled by the delete — the same person straight
      // back on the duplicates page.
      const keeper = await seedMember()
      const loser = await seedMember({ firstName: "Maria" })
      const event = await seedEvent()

      const keeperGuest = await db.guest.create({
        data: { firstName: "K", lastName: "G", memberId: keeper.id, language: [] },
      })
      const loserGuest = await db.guest.create({
        data: { firstName: "L", lastName: "G", memberId: loser.id, workCity: "Cebu", language: [] },
      })
      // The loser's guest owns history that must survive its deletion.
      await db.eventRegistrant.create({ data: { eventId: event.id, guestId: loserGuest.id } })

      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "member",
        losers: [{ id: loser.id, type: "member" }],
      })

      expect(result.success).toBe(true)
      expect(await db.guest.findUnique({ where: { id: loserGuest.id } })).toBeNull()
      // The keeper's own guest is a record the admin kept — untouched.
      const guests = await db.guest.findMany({ where: { memberId: keeper.id } })
      expect(guests).toHaveLength(1)
      expect(guests[0].id).toBe(keeperGuest.id)
      // Activity preserved on the keeper member itself, not on its guest.
      expect(await db.eventRegistrant.count({ where: { memberId: keeper.id } })).toBe(1)
      expect(await db.eventRegistrant.count({ where: { guestId: { not: null } } })).toBe(0)
    })
  })

  describe("guest → guest", () => {
    it("merges and transfers event registrations", async () => {
      const keeper = await seedGuest({ email: "k@example.com" })
      const loser = await seedGuest({ email: "l@example.com" })
      const [eventA, eventB] = [await seedEvent(), await seedEvent()]

      await db.eventRegistrant.create({ data: { eventId: eventA.id, guestId: keeper.id } })
      await db.eventRegistrant.create({ data: { eventId: eventB.id, guestId: loser.id } })

      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "guest",
        losers: [{ id: loser.id, type: "guest" }],
      })

      expect(result).toEqual({ success: true, data: { merged: 1 } })
      expect(await db.guest.findUnique({ where: { id: loser.id } })).toBeNull()
      // Different events, so both registrations survive. Two on one event would fold.
      expect(await db.eventRegistrant.count({ where: { guestId: keeper.id } })).toBe(2)
    })

    it("fills a unique field (email) from the loser without a unique-constraint collision", async () => {
      const keeper = await seedGuest({ phone: "+639170000098", email: null })
      const loser = await seedGuest({ phone: "+639170000098", email: "loser@example.com", firstName: "Anna" })

      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "guest",
        losers: [{ id: loser.id, type: "guest" }],
      })

      expect(result.success).toBe(true)
      const merged = await db.guest.findUnique({ where: { id: keeper.id } })
      expect(merged?.email).toBe("loser@example.com")
      expect(await db.guest.findUnique({ where: { id: loser.id } })).toBeNull()
    })

    it("inherits the loser's promotion link onto the keeper without a collision (ordering)", async () => {
      // Loser guest is already promoted; keeper is not. The keeper must inherit the
      // loser's memberId only AFTER the loser is deleted — otherwise both rows hold
      // the same unique Guest.memberId at once (P2002).
      const member = await seedMember()
      const keeper = await seedGuest()
      const loser = await seedGuest({ firstName: "Promoted" })
      await db.guest.update({ where: { id: loser.id }, data: { memberId: member.id } })

      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "guest",
        losers: [{ id: loser.id, type: "guest" }],
      })

      expect(result.success).toBe(true)
      expect(await db.guest.findUnique({ where: { id: loser.id } })).toBeNull()
      const merged = await db.guest.findUnique({ where: { id: keeper.id } })
      expect(merged?.memberId).toBe(member.id)
    })

    it("rejects merging a member into a guest keeper", async () => {
      const member = await seedMember()
      const guest = await seedGuest()

      const result = await resolveDuplicateGroup({
        keeperId: guest.id,
        keeperType: "guest",
        losers: [{ id: member.id, type: "member" }],
      })

      expect(result.success).toBe(false)
      // Original records intact
      expect(await db.member.findUnique({ where: { id: member.id } })).not.toBeNull()
      expect(await db.guest.findUnique({ where: { id: guest.id } })).not.toBeNull()
    })
  })

  describe("guest → member (promotion-like)", () => {
    it("moves the guest's registrations to the member and deletes the guest record", async () => {
      const member = await seedMember({ email: "same@example.com", workCity: null })
      const guest = await seedGuest({ email: "same@example.com", workCity: "Makati" })
      const event = await seedEvent()
      await db.eventRegistrant.create({ data: { eventId: event.id, guestId: guest.id } })

      const result = await resolveDuplicateGroup({
        keeperId: member.id,
        keeperType: "member",
        losers: [{ id: guest.id, type: "guest" }],
      })

      expect(result.success).toBe(true)

      // The losing record is gone, not retained under the keeper's memberId. A guest
      // kept that way still existed while being invisible on the Guests list and on the
      // duplicates page, so the merge looked complete and wasn't.
      expect(await db.guest.findUnique({ where: { id: guest.id } })).toBeNull()

      // Event registrations re-pointed to the member
      const registrants = await db.eventRegistrant.findMany({ where: { eventId: event.id } })
      expect(registrants).toHaveLength(1)
      expect(registrants[0].memberId).toBe(member.id)
      expect(registrants[0].guestId).toBeNull()

      // Filled blanks
      const updatedMember = await db.member.findUnique({ where: { id: member.id } })
      expect(updatedMember?.workCity).toBe("Makati")
    })

    it("deletes the loser guest even when the keeper member already retains its own guest", async () => {
      // The keeper's own guest is a record the admin chose to keep — it survives, and
      // `Guest.memberId` being unique never comes into it because the loser is deleted
      // rather than linked.
      const member = await seedMember()
      const event = await seedEvent()
      const existingGuest = await db.guest.create({
        data: { firstName: "Old", lastName: "Guest", memberId: member.id, language: [] },
      })
      const loserGuest = await seedGuest({ workCity: "Davao" })
      await db.eventRegistrant.create({ data: { eventId: event.id, guestId: loserGuest.id } })

      const result = await resolveDuplicateGroup({
        keeperId: member.id,
        keeperType: "member",
        losers: [{ id: loserGuest.id, type: "guest" }],
      })

      expect(result.success).toBe(true)
      expect(await db.guest.findUnique({ where: { id: loserGuest.id } })).toBeNull()
      const guests = await db.guest.findMany({ where: { memberId: member.id } })
      expect(guests).toHaveLength(1)
      expect(guests[0].id).toBe(existingGuest.id)
      // Registration re-pointed to the keeper member.
      const reg = await db.eventRegistrant.findMany({ where: { eventId: event.id } })
      expect(reg).toHaveLength(1)
      expect(reg[0].memberId).toBe(member.id)
      expect(reg[0].guestId).toBeNull()
      // Profile data still carried across before the delete.
      expect((await db.member.findUnique({ where: { id: member.id } }))?.workCity).toBe("Davao")
    })
  })

  describe("authorization", () => {
    it("rejects callers that are not Super Admin", async () => {
      const { auth } = await import("@/lib/auth")
      const mockedAuth = auth as unknown as { mockResolvedValueOnce: (v: unknown) => void }
      mockedAuth.mockResolvedValueOnce({
        user: { id: "staff", role: "Staff", permissions: [], eventAccess: [] },
      })

      const keeper = await seedMember()
      const loser = await seedMember({ firstName: "Maria" })

      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "member",
        losers: [{ id: loser.id, type: "member" }],
      })

      expect(result).toEqual({ success: false, error: "Unauthorized" })
      // Both still exist — no destructive action ran
      expect(await db.member.findUnique({ where: { id: keeper.id } })).not.toBeNull()
      expect(await db.member.findUnique({ where: { id: loser.id } })).not.toBeNull()
    })
  })

  describe("batch — resolveDuplicateGroups", () => {
    it("merges multiple groups in a single call and reports per-item results", async () => {
      // Group 1: phone duplicate between two Members
      const a1 = await seedMember({ email: "a1@example.com", phone: "+639170000001" })
      const a2 = await seedMember({ email: "a2@example.com", phone: "+639170000001", firstName: "Maria" })
      // Group 2: email duplicate between two Guests
      const b1 = await seedGuest({ email: "shared@example.com" })
      const b2 = await seedGuest({ email: "shared@example.com", firstName: "Anna" })

      const result = await resolveDuplicateGroups([
        { keeperId: a1.id, keeperType: "member", losers: [{ id: a2.id, type: "member" }] },
        { keeperId: b1.id, keeperType: "guest",  losers: [{ id: b2.id, type: "guest"  }] },
      ])

      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.total).toBe(2)
      expect(result.data.succeeded).toBe(2)
      expect(result.data.failed).toBe(0)
      expect(result.data.totalMerged).toBe(2)

      expect(await db.member.findUnique({ where: { id: a2.id } })).toBeNull()
      expect(await db.guest.findUnique({ where: { id: b2.id } })).toBeNull()
    })

    it("isolates failures — a bad group does not roll back successful ones", async () => {
      const a1 = await seedMember({ email: "ok@example.com" })
      const a2 = await seedMember({ email: "ok2@example.com", firstName: "Maria" })
      const event = await seedEvent()
      await db.eventRegistrant.create({ data: { eventId: event.id, memberId: a2.id } })

      const result = await resolveDuplicateGroups([
        // Valid merge
        { keeperId: a1.id, keeperType: "member", losers: [{ id: a2.id, type: "member" }] },
        // Bad input — keeper appears in losers list
        { keeperId: a1.id, keeperType: "member", losers: [{ id: a1.id, type: "member" }] },
      ])

      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.succeeded).toBe(1)
      expect(result.data.failed).toBe(1)
      const okItem = result.data.items[0]
      const badItem = result.data.items[1]
      expect(okItem.success).toBe(true)
      expect(badItem.success).toBe(false)

      // The first merge committed — registrant moved to keeper, loser deleted
      expect(await db.member.findUnique({ where: { id: a2.id } })).toBeNull()
      expect(await db.eventRegistrant.count({ where: { memberId: a1.id } })).toBe(1)
    })

    it("rejects an empty input list", async () => {
      const result = await resolveDuplicateGroups([])
      expect(result).toEqual({ success: false, error: "Nothing to merge" })
    })

    it("rejects non-Super-Admin callers", async () => {
      const { auth } = await import("@/lib/auth")
      const mockedAuth = auth as unknown as { mockResolvedValueOnce: (v: unknown) => void }
      mockedAuth.mockResolvedValueOnce({
        user: { id: "staff", role: "Staff", permissions: [], eventAccess: [] },
      })

      const a1 = await seedMember()
      const a2 = await seedMember({ firstName: "Maria" })

      const result = await resolveDuplicateGroups([
        { keeperId: a1.id, keeperType: "member", losers: [{ id: a2.id, type: "member" }] },
      ])

      expect(result).toEqual({ success: false, error: "Unauthorized" })
      expect(await db.member.findUnique({ where: { id: a2.id } })).not.toBeNull()
    })
  })

  describe("input guards", () => {
    it("rejects an empty losers list", async () => {
      const keeper = await seedMember()
      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "member",
        losers: [],
      })
      expect(result).toEqual({ success: false, error: "No records to merge" })
    })

    it("rejects the keeper appearing in the losers list", async () => {
      const keeper = await seedMember()
      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "member",
        losers: [{ id: keeper.id, type: "member" }],
      })
      expect(result.success).toBe(false)
    })

    it("rejects a guest already promoted to a different member", async () => {
      // A callable endpoint takes ids from the caller. A guest linked to somebody else
      // is that person's history, not a duplicate of this keeper.
      const keeper = await seedMember()
      const other = await seedMember({ firstName: "Other" })
      const guest = await db.guest.create({
        data: { firstName: "G", lastName: "X", memberId: other.id, language: [] },
      })

      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "member",
        losers: [{ id: guest.id, type: "guest" }],
      })

      expect(result.success).toBe(false)
      expect(await db.guest.findUnique({ where: { id: guest.id } })).not.toBeNull()
    })

    it("reports zero merged when the loser is already gone", async () => {
      // The same pair is flagged by both phone and email whenever they share both, so a
      // group gets merged twice in one batch. The second pass used to report `merged: 1`
      // for work it had not done.
      const keeper = await seedMember()
      const loser = await seedMember({ firstName: "Ghost" })
      await db.member.delete({ where: { id: loser.id } })

      const result = await resolveDuplicateGroup({
        keeperId: keeper.id,
        keeperType: "member",
        losers: [{ id: loser.id, type: "member" }],
      })

      expect(result).toEqual({ success: true, data: { merged: 0 } })
    })
  })
})

// ─── Regressions ──────────────────────────────────────────────────────────────

/**
 * One test per defect found in the audit of this feature. Each pins behaviour that was
 * demonstrably broken, so none of them can come back quietly.
 */
describe("merge regressions", () => {
  async function seedCommittee(eventId: string) {
    const committee = await db.volunteerCommittee.create({ data: { name: "Ushers", eventId } })
    const role = await db.committeeRole.create({ data: { name: "Greeter", committeeId: committee.id } })
    return { committeeId: committee.id, preferredRoleId: role.id }
  }

  it("re-points SmallGroupLog.performedByMemberId instead of nulling it", async () => {
    const keeper = await seedMember()
    const loser = await seedMember({ firstName: "Maria" })
    const leader = await seedMember({ firstName: "Lead" })
    const group = await db.smallGroup.create({ data: { name: "DG A", leaderId: leader.id } })
    await db.smallGroupLog.create({
      data: { smallGroupId: group.id, action: "MemberAdded", performedByMemberId: loser.id },
    })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: loser.id, type: "member" }],
    })

    const log = await db.smallGroupLog.findFirst({ where: { action: "MemberAdded" } })
    expect(log?.performedByMemberId).toBe(keeper.id)
  })

  it("re-points ConfirmationSubmission.submittedByMemberId instead of nulling it", async () => {
    const keeper = await seedMember()
    const loser = await seedMember({ firstName: "Maria" })
    const event = await seedEvent()
    await db.confirmationSubmission.create({
      data: {
        source: "CatchMech",
        eventId: event.id,
        submittedByMemberId: loser.id,
        submittedByName: "Maria Cruz",
        decisions: [],
      },
    })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: loser.id, type: "member" }],
    })

    const submission = await db.confirmationSubmission.findFirst()
    expect(submission?.submittedByMemberId).toBe(keeper.id)
  })

  it("carries the loser's DGroup placement with its groupStatus, never one without the other", async () => {
    // `groupStatus` used to be copied by the generic field pass while `smallGroupId` was
    // deliberately excluded, leaving the keeper marked as a DGroup Member with no DGroup.
    const leader = await seedMember({ firstName: "Lead" })
    const group = await db.smallGroup.create({ data: { name: "DG A", leaderId: leader.id } })
    const keeper = await seedMember()
    const loser = await seedMember({ firstName: "Maria" })
    await db.member.update({
      where: { id: loser.id },
      data: { smallGroupId: group.id, groupStatus: "Member" },
    })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: loser.id, type: "member" }],
    })

    const merged = await db.member.findUnique({ where: { id: keeper.id } })
    expect(merged?.smallGroupId).toBe(group.id)
    expect(merged?.groupStatus).toBe("Member")
  })

  it("never leaves groupStatus set without a group when the keeper already has one", async () => {
    const leader = await seedMember({ firstName: "Lead" })
    const keeperGroup = await db.smallGroup.create({ data: { name: "Keeper DG", leaderId: leader.id } })
    const loserGroup = await db.smallGroup.create({ data: { name: "Loser DG", leaderId: leader.id } })
    const keeper = await seedMember()
    const loser = await seedMember({ firstName: "Maria" })
    await db.member.update({
      where: { id: keeper.id },
      data: { smallGroupId: keeperGroup.id, groupStatus: "Leader" },
    })
    await db.member.update({
      where: { id: loser.id },
      data: { smallGroupId: loserGroup.id, groupStatus: "Member" },
    })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: loser.id, type: "member" }],
    })

    const merged = await db.member.findUnique({ where: { id: keeper.id } })
    expect(merged?.smallGroupId).toBe(keeperGroup.id)
    expect(merged?.groupStatus).toBe("Leader")
    // The DGroup it couldn't take is recorded rather than lost.
    const log = await db.memberLog.findFirst({ where: { memberId: keeper.id } })
    expect(log?.description).toContain("DGroup")
  })

  it("carries guest profile data but queues the DGroup claim for confirmation", async () => {
    const leader = await seedMember({ firstName: "Lead" })
    const claimed = await db.smallGroup.create({ data: { name: "Claimed DG", leaderId: leader.id } })
    const keeper = await seedMember()
    const guest = await db.guest.create({
      data: {
        firstName: "Juan",
        lastName: "Cruz",
        notes: "Prayed to receive Christ 2026-03-01",
        scheduleDayOfWeek: 3,
        scheduleTimeStart: "19:00",
        claimedSmallGroupId: claimed.id,
        language: ["Tagalog"],
      },
    })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: guest.id, type: "guest" }],
    })

    const merged = await db.member.findUnique({
      where: { id: keeper.id },
      include: { schedulePreferences: true },
    })
    expect(merged?.notes).toContain("Prayed to receive Christ")
    expect(merged?.smallGroupId).toBeNull()
    expect(merged?.groupStatus).toBeNull()
    expect(await db.smallGroupMemberRequest.findFirst({ where: { memberId: keeper.id } })).toMatchObject({
      smallGroupId: claimed.id, status: "Pending",
    })
    expect(merged?.language).toEqual(["Tagalog"])
    // The guest's single slot becomes a real SchedulePreference — Member has no
    // scheduleDayOfWeek column, which is why the answer used to be dropped entirely.
    expect(merged?.schedulePreferences).toHaveLength(1)
    expect(merged?.schedulePreferences[0].dayOfWeek).toBe(3)
    expect(merged?.schedulePreferences[0].timeStart).toBe("19:00")
  })

  it("carries a guest's claimed satellite onto upwardSatellite", async () => {
    const keeper = await seedMember()
    const guest = await db.guest.create({
      data: { firstName: "Juan", lastName: "Cruz", claimedSatellite: "CCF Ortigas", language: [] },
    })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: guest.id, type: "guest" }],
    })

    expect((await db.member.findUnique({ where: { id: keeper.id } }))?.upwardSatellite).toBe(
      "CCF Ortigas",
    )
  })

  it("succeeds when the loser guest's email belongs to a third member", async () => {
    // The merge used to copy the email onto the keeper while the guest still existed,
    // hit P2002 against the third member, and roll the whole transaction back — nothing
    // transferred, loser undeleted, reported as a bare "data conflict".
    await seedMember({ firstName: "Third", email: "shared@example.com" })
    const keeper = await seedMember({ email: null })
    const guest = await seedGuest({ email: "shared@example.com", workCity: "Cebu" })
    const event = await seedEvent()
    await db.eventRegistrant.create({ data: { eventId: event.id, guestId: guest.id } })

    const result = await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: guest.id, type: "guest" }],
    })

    expect(result).toEqual({ success: true, data: { merged: 1 } })
    expect(await db.guest.findUnique({ where: { id: guest.id } })).toBeNull()
    const merged = await db.member.findUnique({ where: { id: keeper.id } })
    // The email stays with the third member; everything else still transfers.
    expect(merged?.email).toBeNull()
    expect(merged?.workCity).toBe("Cebu")
    expect(await db.eventRegistrant.count({ where: { memberId: keeper.id } })).toBe(1)
    // And the address it had to refuse is on the record.
    const log = await db.memberLog.findFirst({ where: { memberId: keeper.id } })
    expect(log?.description).toContain("shared@example.com")
  })

  it("folds two registrations for one event into one, keeping attendance and seats", async () => {
    const keeper = await seedMember()
    const loser = await seedMember({ firstName: "Maria" })
    const event = await db.event.create({
      data: {
        name: "Recurring",
        type: "Recurring",
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-12-01"),
      },
    })
    const occA = await db.eventOccurrence.create({
      data: { eventId: event.id, date: new Date("2026-06-07") },
    })
    const occB = await db.eventOccurrence.create({
      data: { eventId: event.id, date: new Date("2026-06-14") },
    })
    const table = await db.breakoutGroup.create({ data: { eventId: event.id, name: "Table 1" } })

    const keeperReg = await db.eventRegistrant.create({
      data: { eventId: event.id, memberId: keeper.id },
    })
    const loserReg = await db.eventRegistrant.create({
      data: { eventId: event.id, memberId: loser.id, isPaid: true, paymentReference: "REF-9" },
    })
    await db.occurrenceAttendee.create({
      data: { occurrenceId: occA.id, registrantId: keeperReg.id },
    })
    await db.occurrenceAttendee.create({
      data: { occurrenceId: occB.id, registrantId: loserReg.id },
    })
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: table.id, registrantId: loserReg.id },
    })
    await db.baptismOptIn.create({ data: { eventId: event.id, registrantId: loserReg.id } })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: loser.id, type: "member" }],
    })

    // One person, one event, one row — two rows is what made a finished merge still
    // show the person twice on the registrants screen.
    const rows = await db.eventRegistrant.findMany({ where: { eventId: event.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(keeperReg.id)
    // Both sittings survive on the surviving row.
    expect(await db.occurrenceAttendee.count({ where: { registrantId: keeperReg.id } })).toBe(2)
    // As does the seat, the baptism opt-in and the payment.
    expect(await db.breakoutGroupMember.count({ where: { registrantId: keeperReg.id } })).toBe(1)
    expect(await db.baptismOptIn.count({ where: { registrantId: keeperReg.id } })).toBe(1)
    expect(rows[0].isPaid).toBe(true)
    expect(rows[0].paymentReference).toBe("REF-9")
  })

  it("never leaves the merged person seated at two tables of one owner", async () => {
    const keeper = await seedMember()
    const loser = await seedMember({ firstName: "Maria" })
    const event = await seedEvent()
    const tableA = await db.breakoutGroup.create({ data: { eventId: event.id, name: "Table A" } })
    const tableB = await db.breakoutGroup.create({ data: { eventId: event.id, name: "Table B" } })

    const keeperReg = await db.eventRegistrant.create({
      data: { eventId: event.id, memberId: keeper.id },
    })
    const loserReg = await db.eventRegistrant.create({
      data: { eventId: event.id, memberId: loser.id },
    })
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: tableA.id, registrantId: keeperReg.id },
    })
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: tableB.id, registrantId: loserReg.id },
    })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: loser.id, type: "member" }],
    })

    const seats = await db.breakoutGroupMember.findMany()
    expect(seats).toHaveLength(1)
    expect(seats[0].breakoutGroupId).toBe(tableA.id)
  })

  it("folds two volunteer rows for one event, keeping the stronger status and the facilitation", async () => {
    const keeper = await seedMember()
    const loser = await seedMember({ firstName: "Maria" })
    const event = await seedEvent()
    const { committeeId, preferredRoleId } = await seedCommittee(event.id)

    const keeperVol = await db.volunteer.create({
      data: { memberId: keeper.id, eventId: event.id, committeeId, preferredRoleId, status: "Pending" },
    })
    const loserVol = await db.volunteer.create({
      data: {
        memberId: loser.id,
        eventId: event.id,
        committeeId,
        preferredRoleId,
        status: "Confirmed",
        notes: "Drives the van",
      },
    })
    const table = await db.breakoutGroup.create({
      data: { eventId: event.id, name: "Table 1", facilitatorId: loserVol.id },
    })
    const session = await db.catchMechSession.create({
      data: { eventId: event.id, breakoutGroupId: table.id, facilitatorVolunteerId: loserVol.id },
    })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: loser.id, type: "member" }],
    })

    const vols = await db.volunteer.findMany({ where: { eventId: event.id } })
    expect(vols).toHaveLength(1)
    expect(vols[0].id).toBe(keeperVol.id)
    expect(vols[0].memberId).toBe(keeper.id)
    // A confirmation already given must not be withdrawn by a merge.
    expect(vols[0].status).toBe("Confirmed")
    expect(vols[0].notes).toContain("Drives the van")
    // The table keeps a facilitator, and the Catch Mech session keeps its owner.
    expect((await db.breakoutGroup.findUnique({ where: { id: table.id } }))?.facilitatorId).toBe(
      keeperVol.id,
    )
    expect(
      (await db.catchMechSession.findUnique({ where: { id: session.id } }))?.facilitatorVolunteerId,
    ).toBe(keeperVol.id)
  })

  it("keeps the deleted guest's portal link working by adopting its token", async () => {
    // `/me/[token]` resolves Member before Guest, so moving the token means an old link
    // in someone's SMS still lands on the portal instead of a 404.
    const keeper = await seedMember()
    const guest = await db.guest.create({
      data: { firstName: "Juan", lastName: "Cruz", selfServiceToken: "tok-abc", language: [] },
    })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: guest.id, type: "guest" }],
    })

    expect((await db.member.findUnique({ where: { id: keeper.id } }))?.selfServiceToken).toBe(
      "tok-abc",
    )
  })

  it("writes one audit entry per absorbed record, naming it and the conflicts", async () => {
    const keeper = await seedMember({ workCity: "Makati" })
    const loser = await seedMember({ firstName: "Maria", workCity: "Cebu" })
    const event = await seedEvent()
    await db.eventRegistrant.create({ data: { eventId: event.id, memberId: loser.id } })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: loser.id, type: "member" }],
    })

    const logs = await db.memberLog.findMany({ where: { memberId: keeper.id } })
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe("ProfilesMerged")
    expect(logs[0].description).toContain("Maria")
    expect(logs[0].description).toContain(loser.id)
    expect(logs[0].description).toContain("1 registration")
    expect(logs[0].description).toContain('workCity: kept "Makati", discarded "Cebu"')
  })

  it("unions languages rather than keeping only the keeper's", async () => {
    const keeper = await seedMember()
    const loser = await seedMember({ firstName: "Maria" })
    await db.member.update({ where: { id: keeper.id }, data: { language: ["English"] } })
    await db.member.update({ where: { id: loser.id }, data: { language: ["Tagalog"] } })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: loser.id, type: "member" }],
    })

    const merged = await db.member.findUnique({ where: { id: keeper.id } })
    expect(merged?.language).toEqual(["English", "Tagalog"])
  })

  it("appends both records' notes instead of dropping the loser's", async () => {
    const keeper = await seedMember()
    const loser = await seedMember({ firstName: "Maria" })
    await db.member.update({ where: { id: keeper.id }, data: { notes: "Serves on Sundays" } })
    await db.member.update({ where: { id: loser.id }, data: { notes: "Invited by Ana" } })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: loser.id, type: "member" }],
    })

    const merged = await db.member.findUnique({ where: { id: keeper.id } })
    expect(merged?.notes).toContain("Serves on Sundays")
    expect(merged?.notes).toContain("Invited by Ana")
  })

  it("records a guest keeper's conflicts in its notes, having no log table to use", async () => {
    const keeper = await seedGuest({ workCity: "Makati" })
    const loser = await seedGuest({ firstName: "Maria", workCity: "Cebu" })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "guest",
      losers: [{ id: loser.id, type: "guest" }],
    })

    const merged = await db.guest.findUnique({ where: { id: keeper.id } })
    expect(merged?.workCity).toBe("Makati")
    expect(merged?.notes).toContain('workCity: kept "Makati", discarded "Cebu"')
    expect(merged?.notes).toContain(loser.id)
  })

  it("folds two guests' registrations for one event when merging guest into guest", async () => {
    const keeper = await seedGuest()
    const loser = await seedGuest({ firstName: "Maria" })
    const event = await seedEvent()
    await db.eventRegistrant.create({ data: { eventId: event.id, guestId: keeper.id } })
    await db.eventRegistrant.create({
      data: { eventId: event.id, guestId: loser.id, isPaid: true, paymentReference: "REF-3" },
    })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "guest",
      losers: [{ id: loser.id, type: "guest" }],
    })

    const rows = await db.eventRegistrant.findMany({ where: { eventId: event.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].guestId).toBe(keeper.id)
    expect(rows[0].isPaid).toBe(true)
    expect(rows[0].paymentReference).toBe("REF-3")
    expect((await db.guest.findUnique({ where: { id: keeper.id } }))?.notes).toContain(
      "Combined duplicate registration",
    )
  })

  it("does not duplicate a schedule slot both records held", async () => {
    const keeper = await seedMember()
    const loser = await seedMember({ firstName: "Maria" })
    await db.schedulePreference.create({
      data: { memberId: keeper.id, dayOfWeek: 3, timeStart: "19:00", timeEnd: "20:00" },
    })
    await db.schedulePreference.create({
      data: { memberId: loser.id, dayOfWeek: 3, timeStart: "19:00", timeEnd: "20:00" },
    })
    await db.schedulePreference.create({
      data: { memberId: loser.id, dayOfWeek: 5, timeStart: "18:00", timeEnd: "19:00" },
    })

    await resolveDuplicateGroup({
      keeperId: keeper.id,
      keeperType: "member",
      losers: [{ id: loser.id, type: "member" }],
    })

    const prefs = await db.schedulePreference.findMany({ where: { memberId: keeper.id } })
    expect(prefs).toHaveLength(2)
  })
})


describe("review regression fixes", () => {
  async function merge(keeperId: string, loserId: string, type: "member" | "guest" = "member") {
    return resolveDuplicateGroup({ keeperId, keeperType: "member", losers: [{ id: loserId, type }] })
  }

  it("preserves a linked guest's profile, schedule and all portal tokens", async () => {
    const keeper = await seedMember({ workCity: "Makati" })
    const loser = await seedMember()
    await db.member.update({ where: { id: keeper.id }, data: { selfServiceToken: "keeper" } })
    await db.member.update({ where: { id: loser.id }, data: { selfServiceToken: "loser", selfServiceTokenAliases: ["older"] } })
    const guest = await db.guest.create({ data: {
      firstName: "Juan", lastName: "Cruz", memberId: loser.id,
      notes: "Guest-only history", workCity: "Cebu", language: ["Tagalog"],
      scheduleDayOfWeek: 2, scheduleTimeStart: "18:00", selfServiceToken: "guest",
    } })
    expect((await merge(keeper.id, loser.id)).success).toBe(true)
    const saved = await db.member.findUniqueOrThrow({ where: { id: keeper.id }, include: { schedulePreferences: true, logs: true } })
    expect(saved.notes).toContain("Guest-only history")
    expect(saved.language).toContain("Tagalog")
    expect(saved.schedulePreferences).toHaveLength(1)
    expect(saved.logs.some(log => log.description?.includes("Cebu"))).toBe(true)
    expect(await db.guest.findUnique({ where: { id: guest.id } })).toBeNull()
    for (const token of ["keeper", "loser", "older", "guest"]) {
      expect((await db.member.findFirst({ where: portalTokenWhere(token) }))?.id).toBe(keeper.id)
      expect((await setUpwardSatellite(token, "CCF Cebu")).success).toBe(true)
    }
    expect((await setUpwardSatellite("unknown-token", "CCF Cebu")).success).toBe(false)
  })

  it("keeps guest aliases usable through onboarding after repeated merges", async () => {
    const keeper = await seedGuest()
    const loser = await seedGuest()
    await db.guest.update({ where: { id: keeper.id }, data: { selfServiceToken: "guest-main" } })
    await db.guest.update({ where: { id: loser.id }, data: { selfServiceToken: "guest-old", selfServiceTokenAliases: ["guest-older"] } })
    expect((await resolveDuplicateGroup({ keeperId: keeper.id, keeperType: "guest", losers: [{ id: loser.id, type: "guest" }] })).success).toBe(true)
    for (const token of ["guest-main", "guest-old", "guest-older"]) {
      expect((await db.guest.findFirst({ where: portalTokenWhere(token) }))?.id).toBe(keeper.id)
    }
    const result = await declareLeaderAndJoin("guest-older", { scope: "satellite", satellite: "CCF Cebu" })
    expect(result.success).toBe(true)
  })

  it("keeps a satellite instead of inheriting a conflicting local group and synchronizes led groups", async () => {
    const keeper = await seedMember()
    await db.member.update({ where: { id: keeper.id }, data: { upwardSatellite: "CCF Cebu" } })
    const loser = await seedMember()
    const leader = await seedMember()
    const parent = await db.smallGroup.create({ data: { name: "Parent", leaderId: leader.id } })
    const led = await db.smallGroup.create({ data: { name: "Led", leaderId: loser.id, parentGroupId: parent.id } })
    await db.member.update({ where: { id: loser.id }, data: { smallGroupId: parent.id, groupStatus: "Member" } })
    expect((await merge(keeper.id, loser.id)).success).toBe(true)
    expect(await db.member.findUnique({ where: { id: keeper.id } })).toMatchObject({ smallGroupId: null, upwardSatellite: "CCF Cebu" })
    expect(await db.smallGroup.findUnique({ where: { id: led.id } })).toMatchObject({ leaderId: keeper.id, parentGroupId: null, parentSatellite: "CCF Cebu" })
  })

  it("rolls back a merge that would make a leader their own ancestor", async () => {
    const keeper = await seedMember()
    const loser = await seedMember()
    const group = await db.smallGroup.create({ data: { name: "Keeper leads", leaderId: keeper.id } })
    await db.member.update({ where: { id: loser.id }, data: { smallGroupId: group.id, groupStatus: "Member" } })
    expect((await merge(keeper.id, loser.id)).success).toBe(false)
    expect(await db.member.findUnique({ where: { id: loser.id } })).not.toBeNull()
    expect(await db.memberLog.count()).toBe(0)
  })

  it("does not queue inactive claims or duplicate an existing pending request", async () => {
    const keeper = await seedMember()
    const leader = await seedMember()
    const group = await db.smallGroup.create({ data: { name: "Inactive", leaderId: leader.id, status: "Inactive" } })
    const guest = await seedGuest()
    await db.guest.update({ where: { id: guest.id }, data: { claimedSmallGroupId: group.id } })
    expect((await merge(keeper.id, guest.id, "guest")).success).toBe(true)
    expect(await db.smallGroupMemberRequest.count()).toBe(0)
    await db.smallGroup.update({ where: { id: group.id }, data: { status: "Active" } })
    await db.smallGroupMemberRequest.create({ data: { memberId: keeper.id, smallGroupId: group.id, status: "Pending" } })
    const second = await seedGuest()
    await db.guest.update({ where: { id: second.id }, data: { claimedSmallGroupId: group.id } })
    expect((await merge(keeper.id, second.id, "guest")).success).toBe(true)
    expect(await db.smallGroupMemberRequest.count()).toBe(1)
    expect((await db.member.findUnique({ where: { id: keeper.id } }))?.smallGroupId).toBeNull()
  })

  it("keeps volunteer roles in their committee and audits discarded event values", async () => {
    const keeper = await seedMember()
    const loser = await seedMember()
    const event = await seedEvent()
    const a = await db.volunteerCommittee.create({ data: { eventId: event.id, name: "Ushers" } })
    const b = await db.volunteerCommittee.create({ data: { eventId: event.id, name: "Music" } })
    const ra = await db.committeeRole.create({ data: { committeeId: a.id, name: "Greeter" } })
    const rb = await db.committeeRole.create({ data: { committeeId: b.id, name: "Singer" } })
    await db.volunteer.create({ data: { memberId: keeper.id, eventId: event.id, committeeId: a.id, preferredRoleId: ra.id, createdAt: new Date("2020-01-01") } })
    await db.volunteer.create({ data: { memberId: loser.id, eventId: event.id, committeeId: b.id, preferredRoleId: rb.id, assignedRoleId: rb.id } })
    await db.eventRegistrant.create({ data: { eventId: event.id, memberId: keeper.id, isPaid: true, paymentReference: "PAY-A", dietaryOther: "No nuts" } })
    await db.eventRegistrant.create({ data: { eventId: event.id, memberId: loser.id, isPaid: true, paymentReference: "PAY-B", dietaryOther: "No dairy" } })
    expect((await merge(keeper.id, loser.id)).success).toBe(true)
    expect(await db.volunteer.findFirst()).toMatchObject({ committeeId: a.id, assignedRoleId: null })
    const logs = await db.memberLog.findMany({ where: { memberId: keeper.id } })
    const report = logs.map(log => log.description).join("\n")
    for (const value of ["PAY-A", "PAY-B", "No nuts", "No dairy", rb.id]) expect(report).toContain(value)
  })
})

// Real database regressions for the final staging review. No browser behavior changes;
// integration tests exercise the transaction, constraints, and surviving audit records.
describe("staging review regressions", () => {
  it("preserves the chosen keeper's volunteer row even when the duplicate signed up first", async () => {
    const keeper = await seedMember()
    const loser = await seedMember()
    const event = await seedEvent()
    const committee = await db.volunteerCommittee.create({ data: { eventId: event.id, name: "Team" } })
    const role = await db.committeeRole.create({ data: { committeeId: committee.id, name: "Role" } })
    const common = { eventId: event.id, committeeId: committee.id, preferredRoleId: role.id }
    const old = await db.volunteer.create({ data: { ...common, memberId: loser.id, createdAt: new Date("2020-01-01") } })
    const kept = await db.volunteer.create({ data: { ...common, memberId: keeper.id } })
    const keptSession = await db.catchMechVolunteerSession.create({ data: { eventId: event.id, volunteerId: kept.id } })
    const oldSession = await db.catchMechVolunteerSession.create({ data: { eventId: event.id, volunteerId: old.id } })
    const submission = await db.confirmationSubmission.create({ data: {
      source: "CatchMech", eventId: event.id, volunteerSessionId: oldSession.id,
      facilitatorVolunteerId: old.id, submittedByName: "Juan", decisions: [],
    } })
    expect((await resolveDuplicateGroup({ keeperId: keeper.id, keeperType: "member", losers: [{ id: loser.id, type: "member" }] })).success).toBe(true)
    expect(await db.volunteer.findMany()).toMatchObject([{ id: kept.id }])
    expect(await db.confirmationSubmission.findUnique({ where: { id: submission.id } })).toMatchObject({
      volunteerSessionId: keptSession.id, facilitatorVolunteerId: kept.id,
    })
  })

  it("preserves submission links when both folded volunteer rows have follow-up sessions", async () => {
    const keeper = await seedMember()
    const loser = await seedMember()
    const event = await seedEvent()
    const committee = await db.volunteerCommittee.create({ data: { eventId: event.id, name: "Team" } })
    const role = await db.committeeRole.create({ data: { committeeId: committee.id, name: "Role" } })
    const common = { eventId: event.id, committeeId: committee.id, preferredRoleId: role.id }
    const kept = await db.volunteer.create({ data: { ...common, memberId: keeper.id, createdAt: new Date("2020-01-01") } })
    const old = await db.volunteer.create({ data: { ...common, memberId: loser.id } })
    const keptSession = await db.catchMechVolunteerSession.create({ data: { eventId: event.id, volunteerId: kept.id } })
    const oldSession = await db.catchMechVolunteerSession.create({ data: { eventId: event.id, volunteerId: old.id } })
    const submission = await db.confirmationSubmission.create({ data: {
      source: "CatchMech", eventId: event.id, volunteerSessionId: oldSession.id,
      facilitatorVolunteerId: old.id, submittedByName: "Juan", decisions: [],
    } })
    expect((await resolveDuplicateGroup({ keeperId: keeper.id, keeperType: "member", losers: [{ id: loser.id, type: "member" }] })).success).toBe(true)
    expect(await db.confirmationSubmission.findUnique({ where: { id: submission.id } })).toMatchObject({ volunteerSessionId: keptSession.id })
  })

  it("does not borrow another day's times or combine local and satellite guest claims", async () => {
    const keeper = await seedGuest()
    const loser = await seedGuest()
    const leader = await seedMember()
    const group = await db.smallGroup.create({ data: { name: "Local", leaderId: leader.id } })
    await db.guest.update({ where: { id: keeper.id }, data: { scheduleDayOfWeek: 1, claimedSatellite: "CCF Main" } })
    await db.guest.update({ where: { id: loser.id }, data: {
      scheduleDayOfWeek: 5, scheduleTimeStart: "19:00", scheduleTimeEnd: "20:00", claimedSmallGroupId: group.id,
    } })
    expect((await resolveDuplicateGroup({ keeperId: keeper.id, keeperType: "guest", losers: [{ id: loser.id, type: "guest" }] })).success).toBe(true)
    const result = await db.guest.findUniqueOrThrow({ where: { id: keeper.id } })
    expect(result).toMatchObject({ scheduleDayOfWeek: 1, scheduleTimeStart: null, scheduleTimeEnd: null, claimedSatellite: "CCF Main", claimedSmallGroupId: null })
    expect(result.notes).toContain("19:00")
    expect(result.notes).toContain(group.id)
  })
})

describe("merge across event boundaries", () => {
  it.each([false, true])("keeps the keeper's Collab table across events (overlapping registration: %s)", async (overlapping) => {
    const keeper = await seedMember()
    const loser = await seedMember()
    const a = await seedEvent()
    const b = await seedEvent()
    const cluster = await db.eventCluster.create({ data: { name: "Collab", kind: "Collab" } })
    const kept = await db.eventRegistrant.create({ data: { eventId: a.id, memberId: keeper.id } })
    if (overlapping) await db.eventRegistrant.create({ data: { eventId: b.id, memberId: keeper.id } })
    const incoming = await db.eventRegistrant.create({ data: { eventId: b.id, memberId: loser.id } })
    const tableA = await db.breakoutGroup.create({ data: { clusterId: cluster.id, name: "Keeper table" } })
    const tableB = await db.breakoutGroup.create({ data: { clusterId: cluster.id, name: "Duplicate table" } })
    await db.breakoutGroupMember.create({ data: { breakoutGroupId: tableB.id, registrantId: incoming.id } })
    await db.breakoutGroupMember.create({ data: { breakoutGroupId: tableA.id, registrantId: kept.id } })
    expect((await resolveDuplicateGroup({ keeperId: keeper.id, keeperType: "member", losers: [{ id: loser.id, type: "member" }] })).success).toBe(true)
    expect(await db.eventRegistrant.count()).toBe(2)
    expect(await db.breakoutGroupMember.findMany()).toMatchObject([{ breakoutGroupId: tableA.id, registrantId: kept.id }])
  })

  it("does not reopen a rejected volunteer signup when the duplicate is still pending", async () => {
    const keeper = await seedMember()
    const loser = await seedMember()
    const event = await seedEvent()
    const committee = await db.volunteerCommittee.create({ data: { eventId: event.id, name: "Team" } })
    const role = await db.committeeRole.create({ data: { committeeId: committee.id, name: "Role" } })
    const common = { eventId: event.id, committeeId: committee.id, preferredRoleId: role.id }
    await db.volunteer.create({ data: { ...common, memberId: keeper.id, status: "Rejected", leaderNotes: "Unavailable" } })
    await db.volunteer.create({ data: { ...common, memberId: loser.id, status: "Pending" } })
    expect((await resolveDuplicateGroup({ keeperId: keeper.id, keeperType: "member", losers: [{ id: loser.id, type: "member" }] })).success).toBe(true)
    expect(await db.volunteer.findFirst()).toMatchObject({ status: "Rejected" })
  })
})

it("rejects guest merges that would redirect a promoted guest's portal to another member", async () => {
  const a = await seedMember()
  const b = await seedMember()
  const keeper = await db.guest.create({ data: { firstName: "Juan", lastName: "Cruz", language: [], memberId: a.id } })
  const loser = await db.guest.create({ data: { firstName: "Juan", lastName: "Cruz", language: [], memberId: b.id, selfServiceToken: "promoted-guest" } })
  const result = await resolveDuplicateGroup({ keeperId: keeper.id, keeperType: "guest", losers: [{ id: loser.id, type: "guest" }] })
  expect(result.success).toBe(false)
  expect(await db.guest.findUnique({ where: { id: loser.id } })).toMatchObject({ memberId: b.id, selfServiceToken: "promoted-guest" })
  expect(await db.guest.count()).toBe(2)
})
