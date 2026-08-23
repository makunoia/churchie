import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { db } from "@/lib/db"

/**
 * The registration form's best-fit suggestion, at check-in.
 *
 * The step was wired up long before this and still never showed a suggestion,
 * because it loaded a facilitator-gated candidate set while the registration form
 * loads every enabled table. That hid the step in the two ordinary cases — the
 * team hasn't arrived yet, or a table has no facilitator assigned at all, which
 * no branch of `facilitatorGate` can ever match.
 *
 * It also quietly broke the ranking, which is the part these tests exist for.
 * `resolveFillLevels` reduces the whole candidate set at once, so "the emptiest
 * table" only means "the emptiest of all of them" when the set IS all of them.
 * The gated subset was at its worst in the window where exactly one facilitator
 * had checked in: it collapsed to that single table and every arrival stacked
 * into it — the opposite of the spread the suggestion is for.
 *
 * The walk-in door still gates, and that asymmetry is pinned here too: there a
 * staffer is doing the placing, and handing someone to a table with nobody
 * running it is a real handover to nobody.
 *
 * Signed out by default — the kiosk is a public route.
 */

const authMock = vi.hoisted(() => ({ session: null as unknown }))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => authMock.session),
}))

import { getCheckinBreakoutChoices } from "@/app/(dashboard)/events/breakout-actions"
import { fetchBreakoutAvailability } from "@/lib/breakout-suggestion-server"

beforeEach(async () => {
  authMock.session = null
  await db.$executeRaw`TRUNCATE "OccurrenceSubFacilitator", "OccurrenceAttendee", "BreakoutGroupMember", "BreakoutGroup", "Volunteer", "CommitteeRole", "VolunteerCommittee", "EventRegistrant", "EventOccurrence", "EventModule", "EventClusterEvent", "EventCluster", "Event", "Member", "Guest", "LifeStage" RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

async function seedEvent() {
  const event = await db.event.create({
    data: {
      name: "Retreat",
      type: "OneTime",
      startDate: new Date(),
      endDate: new Date(),
      modules: { create: { type: "Breakout" } },
    },
  })
  const committee = await db.volunteerCommittee.create({
    data: { name: "Facilitators", eventId: event.id },
  })
  const role = await db.committeeRole.create({
    data: { name: "Facilitator", committeeId: committee.id },
  })
  return { event, committee, role }
}

/** A facilitator who has NOT arrived — the state the gate used to hold tables in. */
async function seedAbsentFacilitator(
  eventId: string,
  committeeId: string,
  roleId: string,
  name: string
) {
  const member = await db.member.create({
    data: { firstName: name, lastName: "Faci", dateJoined: new Date(), language: [] },
  })
  return db.volunteer.create({
    data: {
      memberId: member.id,
      eventId,
      committeeId,
      preferredRoleId: roleId,
      status: "Confirmed",
    },
  })
}

async function seedCheckedInGuest(
  eventId: string,
  name: string,
  profile: { gender?: "Male" | "Female"; birthYear?: number; lifeStageId?: string } = {}
) {
  const guest = await db.guest.create({
    data: { firstName: name, lastName: "Attendee", language: [], ...profile },
  })
  const registrant = await db.eventRegistrant.create({
    data: { eventId, guestId: guest.id, attendedAt: new Date() },
  })
  return { guest, registrant }
}

/** Fill a table with `n` bodies, so `fillLevel` has something to rank on. */
async function seatOthers(eventId: string, groupId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const { registrant } = await seedCheckedInGuest(eventId, `Filler${groupId}${i}`)
    await db.breakoutGroupMember.create({
      data: { breakoutGroupId: groupId, registrantId: registrant.id },
    })
  }
}

describe("the suggestion appears where the gate used to hide it", () => {
  it("suggests a table with no facilitator assigned at all", async () => {
    const { event } = await seedEvent()
    const group = await db.breakoutGroup.create({
      data: { name: "Unstaffed", eventId: event.id },
    })
    const { registrant } = await seedCheckedInGuest(event.id, "Nora")

    // Every branch of `facilitatorGate` requires a facilitator relation, so this
    // table could never be offered while the kiosk was gated — however many
    // people were standing in front of it.
    const result = await getCheckinBreakoutChoices(registrant.id, event.id, null)
    if (!result.success || !result.data) throw new Error("expected choices")
    expect(result.data.suggested?.id).toBe(group.id)
  })

  it("still keeps a switched-off table out", async () => {
    const { event } = await seedEvent()
    await db.breakoutGroup.create({
      data: { name: "Retired", eventId: event.id, isEnabled: false },
    })
    const { registrant } = await seedCheckedInGuest(event.id, "Nora")

    // Ungating is about the facilitator, not about the switch. An admin taking
    // every table out of play is still indistinguishable from having none.
    const result = await getCheckinBreakoutChoices(registrant.id, event.id, null)
    expect(result).toEqual({ success: true, data: null })
  })
})

describe("the suggestion distributes across all the groups", () => {
  it("names the emptiest table, counting every group rather than a gated subset", async () => {
    const { event, committee, role } = await seedEvent()
    const busy = await db.breakoutGroup.create({
      data: { name: "Busy", eventId: event.id },
    })
    const middling = await db.breakoutGroup.create({
      data: { name: "Middling", eventId: event.id },
    })
    const empty = await db.breakoutGroup.create({
      data: { name: "Empty", eventId: event.id },
    })
    await seatOthers(event.id, busy.id, 5)
    await seatOthers(event.id, middling.id, 2)

    // The one table whose facilitator has arrived is the FULLEST one. Under the
    // old gate the candidate set was exactly `[busy]`, so it was also the only
    // thing that could be suggested — every arrival stacked into the table that
    // least needed them.
    const present = await seedAbsentFacilitator(event.id, committee.id, role.id, "Ana")
    await db.volunteer.update({
      where: { id: present.id },
      data: { attendedAt: new Date() },
    })
    await db.breakoutGroup.update({
      where: { id: busy.id },
      data: { facilitatorId: present.id },
    })

    const { registrant } = await seedCheckedInGuest(event.id, "Nora")
    const result = await getCheckinBreakoutChoices(registrant.id, event.id, null)
    if (!result.success || !result.data) throw new Error("expected choices")

    expect(result.data.suggested?.id).toBe(empty.id)
    // The browse list is ordered by the same comparator, so the two can never
    // disagree about which table leads.
    expect(result.data.options.map((o) => o.id)).toEqual([empty.id, middling.id, busy.id])
  })

  it("rotates to the next table once the suggested one is seated", async () => {
    const { event } = await seedEvent()
    const first = await db.breakoutGroup.create({
      data: { name: "First", eventId: event.id },
    })
    const second = await db.breakoutGroup.create({
      data: { name: "Second", eventId: event.id },
    })

    const { registrant } = await seedCheckedInGuest(event.id, "Nora")
    const before = await getCheckinBreakoutChoices(registrant.id, event.id, null)
    if (!before.success || !before.data) throw new Error("expected choices")
    // Both empty, so declaration order decides — cuid is monotonic, so `first`.
    expect(before.data.suggested?.id).toBe(first.id)

    await seatOthers(event.id, first.id, 1)

    const { registrant: next } = await seedCheckedInGuest(event.id, "Mika")
    const after = await getCheckinBreakoutChoices(next.id, event.id, null)
    if (!after.success || !after.data) throw new Error("expected choices")
    // This is the whole point: the suggestion moves as the day fills instead of
    // naming one table to everybody.
    expect(after.data.suggested?.id).toBe(second.id)
  })
})

describe("the fit filters still apply", () => {
  it("never suggests a men's table to a woman", async () => {
    const { event } = await seedEvent()
    await db.breakoutGroup.create({
      data: { name: "Brothers", eventId: event.id, genderFocus: "Male" },
    })
    const mixed = await db.breakoutGroup.create({
      data: { name: "Mixed", eventId: event.id, genderFocus: "Mixed" },
    })
    // The gendered table is emptier, so only the gender filter can keep it out.
    await seatOthers(event.id, mixed.id, 3)
    const { registrant } = await seedCheckedInGuest(event.id, "Nora", { gender: "Female" })

    const result = await getCheckinBreakoutChoices(registrant.id, event.id, null)
    if (!result.success || !result.data) throw new Error("expected choices")
    expect(result.data.suggested?.id).toBe(mixed.id)
    expect(result.data.options.map((o) => o.name)).not.toContain("Brothers")
  })

  it("excludes a known life-stage mismatch", async () => {
    const { event } = await seedEvent()
    const young = await db.lifeStage.create({ data: { name: "Young Pro", order: 1 } })
    const senior = await db.lifeStage.create({ data: { name: "Senior", order: 2 } })
    await db.breakoutGroup.create({
      data: {
        name: "Seniors",
        eventId: event.id,
        lifeStages: { connect: { id: senior.id } },
      },
    })
    const open = await db.breakoutGroup.create({ data: { name: "Open", eventId: event.id } })
    await seatOthers(event.id, open.id, 4)
    const { registrant } = await seedCheckedInGuest(event.id, "Nora", {
      lifeStageId: young.id,
    })

    const result = await getCheckinBreakoutChoices(registrant.id, event.id, null)
    if (!result.success || !result.data) throw new Error("expected choices")
    expect(result.data.suggested?.id).toBe(open.id)
    expect(result.data.options.map((o) => o.name)).not.toContain("Seniors")
  })

  it("never suggests a full table, though it stays browsable", async () => {
    const { event } = await seedEvent()
    const full = await db.breakoutGroup.create({
      data: { name: "Full", eventId: event.id, memberLimit: 2 },
    })
    const roomy = await db.breakoutGroup.create({
      data: { name: "Roomy", eventId: event.id, memberLimit: 10 },
    })
    await seatOthers(event.id, full.id, 2)
    await seatOthers(event.id, roomy.id, 5)
    const { registrant } = await seedCheckedInGuest(event.id, "Nora")

    const result = await getCheckinBreakoutChoices(registrant.id, event.id, null)
    if (!result.success || !result.data) throw new Error("expected choices")
    expect(result.data.suggested?.id).toBe(roomy.id)
    // Present but marked, so it doesn't look like it vanished.
    expect(result.data.options.map((o) => o.id)).toContain(full.id)
  })
})

describe("the walk-in door is unchanged", () => {
  it("gates an unstaffed table the kiosk offers", async () => {
    const { event } = await seedEvent()
    await db.breakoutGroup.create({ data: { name: "Unstaffed", eventId: event.id } })
    const { registrant } = await seedCheckedInGuest(event.id, "Nora")

    // Same event, same table, two different answers — deliberately. At the door a
    // staffer is handing someone over, and there is nobody to hand them to.
    const door = await fetchBreakoutAvailability(event.id, null, true)
    expect(door.candidates).toHaveLength(0)
    expect(door.totalGroups).toBe(1)

    const kiosk = await getCheckinBreakoutChoices(registrant.id, event.id, null)
    if (!kiosk.success || !kiosk.data) throw new Error("expected choices")
    expect(kiosk.data.suggested).not.toBeNull()
  })
})
