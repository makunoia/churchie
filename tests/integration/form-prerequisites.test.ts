import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { db } from "@/lib/db"
import {
  clusterFormPrerequisites,
  eventFormPrerequisites,
} from "@/lib/forms/form-prerequisites-server"

/**
 * The builder warnings that stop a form from silently rendering one step short.
 * Each case here corresponds to a real way an enabled toggle produced nothing.
 */

beforeEach(async () => {
  await db.$executeRaw`TRUNCATE "BreakoutGroupMember", "BreakoutGroup", "Volunteer", "CommitteeRole", "VolunteerCommittee", "EventRegistrant", "EventOccurrence", "EventModule", "EventClusterEvent", "EventCluster", "Event", "Member", "Guest", "LifeStage", "AgeRangeBucket" RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

async function seedEvent() {
  return db.event.create({
    data: { name: "Retreat", type: "OneTime", startDate: new Date(), endDate: new Date() },
  })
}

async function seedCluster(kind: "Parallel" | "Collab") {
  return db.eventCluster.create({ data: { name: "Event Day", kind } })
}

async function seedFacilitatorVolunteer(eventId: string) {
  const committee = await db.volunteerCommittee.create({
    data: { name: "Facilitators", eventId },
  })
  const role = await db.committeeRole.create({
    data: { name: "Facilitator", committeeId: committee.id },
  })
  const member = await db.member.create({
    data: { firstName: "Ana", lastName: "Faci", dateJoined: new Date(), language: [] },
  })
  return db.volunteer.create({
    data: {
      memberId: member.id,
      eventId,
      committeeId: committee.id,
      preferredRoleId: role.id,
      status: "Confirmed",
    },
  })
}

describe("eventFormPrerequisites — breakout warnings", () => {
  it("warns that auto-assign means nobody sees the step, on every surface", async () => {
    const event = await seedEvent()
    const result = await eventFormPrerequisites(event.id, true)

    expect(result.sectionBreakout?.message).toContain("Auto-assign is on")
    // Auto-assign suppresses the picker on the public form too, so it isn't scoped.
    expect(result.sectionBreakout?.contexts).toBeUndefined()
  })

  it("warns when the event has no breakout groups at all", async () => {
    const event = await seedEvent()
    const result = await eventFormPrerequisites(event.id, false)

    expect(result.sectionBreakout?.message).toContain("no breakout groups yet")
    expect(result.sectionBreakout?.contexts).toBeUndefined()
  })

  it("warns the door when groups exist but none has a facilitator", async () => {
    const event = await seedEvent()
    await db.breakoutGroup.create({ data: { name: "One", eventId: event.id } })
    await db.breakoutGroup.create({ data: { name: "Two", eventId: event.id } })

    const result = await eventFormPrerequisites(event.id, false)

    expect(result.sectionBreakout?.message).toContain("2 breakout groups have a facilitator")
    // The door alone. The registration form is filled in days ahead and offers
    // unstaffed groups regardless; so does the kiosk, which stopped gating its
    // pool when it learned to ask (`fetchBreakoutAvailability(…, false)`) —
    // a table whose host hasn't arrived is the ordinary state of the first half
    // hour, and gating there collapsed the ranking onto whoever had.
    expect(result.sectionBreakout?.contexts).toEqual(["WalkIn"])
  })

  it("uses singular phrasing for a single unstaffed group", async () => {
    const event = await seedEvent()
    await db.breakoutGroup.create({ data: { name: "Only", eventId: event.id } })

    const result = await eventFormPrerequisites(event.id, false)
    expect(result.sectionBreakout?.message).toContain("1 breakout group has a facilitator")
  })

  it("distinguishes 'all groups switched off' from 'no groups'", async () => {
    const event = await seedEvent()
    const volunteer = await seedFacilitatorVolunteer(event.id)
    await db.breakoutGroup.create({
      data: { name: "Off", eventId: event.id, facilitatorId: volunteer.id, isEnabled: false },
    })

    const result = await eventFormPrerequisites(event.id, false)

    // Staffed, so the staffing warning would not have fired — and "create one"
    // would be the wrong instruction when one already exists.
    expect(result.sectionBreakout?.message).toContain("switched off")
    expect(result.sectionBreakout?.message).toContain("Switch one on")
    expect(result.sectionBreakout?.message).not.toContain("no breakout groups yet")
    // Off closes the public form's picker too, so this one isn't Walk-in scoped.
    expect(result.sectionBreakout?.contexts).toBeUndefined()
  })

  it("counts only enabled groups in the staffing warning", async () => {
    const event = await seedEvent()
    await db.breakoutGroup.create({ data: { name: "On", eventId: event.id } })
    await db.breakoutGroup.create({
      data: { name: "Off", eventId: event.id, isEnabled: false },
    })

    // Two groups exist, one is in play — the number quoted has to be the one the
    // admin can act on.
    const result = await eventFormPrerequisites(event.id, false)
    expect(result.sectionBreakout?.message).toContain("1 breakout group has a facilitator")
  })

  it("stays quiet once a group is staffed", async () => {
    const event = await seedEvent()
    const volunteer = await seedFacilitatorVolunteer(event.id)
    await db.breakoutGroup.create({
      data: { name: "Staffed", eventId: event.id, facilitatorId: volunteer.id },
    })

    const result = await eventFormPrerequisites(event.id, false)
    expect(result.sectionBreakout).toBeUndefined()
  })

  it("prefers the auto-assign warning over the staffing one", async () => {
    // Both conditions hold; auto-assign is the more decisive fact.
    const event = await seedEvent()
    await db.breakoutGroup.create({ data: { name: "Unstaffed", eventId: event.id } })

    const result = await eventFormPrerequisites(event.id, true)
    expect(result.sectionBreakout?.message).toContain("Auto-assign is on")
  })
})

describe("global field warnings", () => {
  it("warns about missing life stages and age ranges", async () => {
    const event = await seedEvent()
    const result = await eventFormPrerequisites(event.id, false)

    expect(result.fieldLifeStage?.message).toContain("Settings → Life Stages")
    expect(result.fieldAgeRange?.message).toContain("Settings → Age Ranges")
  })

  it("stays quiet once the settings data exists", async () => {
    const event = await seedEvent()
    await db.lifeStage.create({ data: { name: "Singles", order: 1 } })
    await db.ageRangeBucket.create({ data: { label: "18-24", order: 1 } })

    const result = await eventFormPrerequisites(event.id, false)
    expect(result.fieldLifeStage).toBeUndefined()
    expect(result.fieldAgeRange).toBeUndefined()
  })

  it("reaches the cluster form too, which also collects both fields", async () => {
    // Regression: the cluster builder shipped without these warnings even though
    // its form renders the same Life Stage / Age Range inputs.
    const cluster = await seedCluster("Parallel")
    const result = await clusterFormPrerequisites(cluster.id, "Parallel")

    expect(result.fieldLifeStage?.message).toContain("Settings → Life Stages")
    expect(result.fieldAgeRange?.message).toContain("Settings → Age Ranges")
    // A Parallel day has no tables of its own, so there is no picker to warn about.
    expect(result.sectionBreakout).toBeUndefined()
  })
})

describe("clusterFormPrerequisites — Collab breakout warnings", () => {
  /** A Collab day with one member event that can actually receive a placement. */
  async function seedCollab(
    opts: { autoAssign?: boolean; withModule?: boolean } = {}
  ) {
    const cluster = await seedCluster("Collab")
    const event = await db.event.create({
      data: {
        name: "Youth",
        type: "OneTime",
        startDate: new Date(),
        endDate: new Date(),
        autoAssignBreakout: opts.autoAssign ?? false,
      },
    })
    await db.eventClusterEvent.create({
      data: { clusterId: cluster.id, eventId: event.id },
    })
    if (opts.withModule ?? true) {
      await db.eventModule.create({ data: { eventId: event.id, type: "Breakout" } })
    }
    return { cluster, event }
  }

  it("warns that the day has no tables yet", async () => {
    const { cluster } = await seedCollab()
    const result = await clusterFormPrerequisites(cluster.id, "Collab")

    expect(result.sectionBreakout?.message).toContain("no breakout groups yet")
    expect(result.sectionBreakout?.contexts).toBeUndefined()
  })

  it("distinguishes 'all switched off' from 'none exist'", async () => {
    const { cluster } = await seedCollab()
    await db.breakoutGroup.create({
      data: { clusterId: cluster.id, name: "Table 1", isEnabled: false },
    })

    const result = await clusterFormPrerequisites(cluster.id, "Collab")
    expect(result.sectionBreakout?.message).toContain("switched off")
    expect(result.sectionBreakout?.message).not.toContain("no breakout groups yet")
  })

  it("names a member event missing the Breakout module — the pick would be dropped", async () => {
    // The quietest failure: the form accepts the choice and
    // `assignBreakoutForRegistrant` throws it away, because placement is gated on
    // the registrant's own event holding the module.
    const { cluster } = await seedCollab({ withModule: false })
    await db.breakoutGroup.create({ data: { clusterId: cluster.id, name: "Table 1" } })

    const result = await clusterFormPrerequisites(cluster.id, "Collab")
    expect(result.sectionBreakout?.message).toContain("Youth")
    expect(result.sectionBreakout?.message).toContain("Settings → Modules")
    expect(result.sectionBreakout?.contexts).toBeUndefined()
  })

  it("mentions auto-assign without claiming the step is pointless", async () => {
    const { cluster } = await seedCollab({ autoAssign: true })
    await db.breakoutGroup.create({ data: { clusterId: cluster.id, name: "Table 1" } })

    const result = await clusterFormPrerequisites(cluster.id, "Collab")
    // Unlike a single event — where auto-assign SUPPRESSES the picker — a pick
    // made on the shared form still wins, so the copy must not say nobody sees it.
    expect(result.sectionBreakout?.message).toContain("still wins")
  })

  it("warns about the unstaffed door only, once the rest is in order", async () => {
    const { cluster } = await seedCollab()
    await db.breakoutGroup.create({ data: { clusterId: cluster.id, name: "Table 1" } })

    const result = await clusterFormPrerequisites(cluster.id, "Collab")
    expect(result.sectionBreakout?.message).toContain("facilitator has checked in")
    // The door, not the shared form and not the kiosk — see the event-side twin.
    expect(result.sectionBreakout?.contexts).toEqual(["WalkIn"])
  })

  it("stays quiet once a table is enabled and staffed", async () => {
    const { cluster, event } = await seedCollab()
    const faci = await seedFacilitatorVolunteer(event.id)
    await db.breakoutGroup.create({
      data: { clusterId: cluster.id, name: "Table 1", facilitatorId: faci.id },
    })

    const result = await clusterFormPrerequisites(cluster.id, "Collab")
    expect(result.sectionBreakout).toBeUndefined()
  })
})

/**
 * The one warning that fires while its own switch is *off*.
 *
 * A gendered table is never suggested to someone whose gender we don't hold, so
 * switching Gender off quietly removes those tables from play and leaves life
 * stage to decide. That is a survivable fallback rather than a broken form —
 * but it has to be said out loud, because nothing on the screen showed it.
 *
 * The focus is usually *implied* by who runs the table rather than set on it,
 * which is why counting the `genderFocus` column alone would have reported zero
 * for most affected events.
 */
describe("gender field warning", () => {
  async function seedGenderedGroup(
    eventId: string,
    opts: { facilitatorGender?: "Male" | "Female"; focus?: "Male" | "Female" | "Mixed" } = {}
  ) {
    const committee = await db.volunteerCommittee.create({
      data: { name: "Facilitators", eventId },
    })
    const role = await db.committeeRole.create({
      data: { name: "Facilitator", committeeId: committee.id },
    })
    const member = await db.member.create({
      data: {
        firstName: "Ana",
        lastName: "Faci",
        dateJoined: new Date(),
        language: [],
        gender: opts.facilitatorGender ?? null,
      },
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
    return db.breakoutGroup.create({
      data: {
        eventId,
        name: "Table 1",
        genderFocus: opts.focus ?? null,
        facilitatorId: volunteer.id,
      },
    })
  }

  it("raises the warning off a facilitator-implied focus, not just an explicit one", async () => {
    const event = await seedEvent()
    await seedGenderedGroup(event.id, { facilitatorGender: "Male" })

    const result = await eventFormPrerequisites(event.id, false)
    expect(result.fieldGender?.whenOff).toBe(true)
    expect(result.fieldGender?.message).toContain("for one gender")
    expect(result.fieldGender?.message).toContain("life stage")
    // Nothing about the step failing to appear — it appears fine.
    expect(result.fieldGender?.contexts).toBeUndefined()
  })

  it("says nobody can be placed at all when auto-assign is on", async () => {
    const event = await seedEvent()
    await seedGenderedGroup(event.id, { facilitatorGender: "Female" })

    const result = await eventFormPrerequisites(event.id, true)
    expect(result.fieldGender?.message).toContain("nobody can be placed")
    // The sectionBreakout chain still answers its own question independently.
    expect(result.sectionBreakout?.message).toContain("Auto-assign is on")
  })

  it("stays quiet for an explicitly Mixed table", async () => {
    const event = await seedEvent()
    await seedGenderedGroup(event.id, { facilitatorGender: "Male", focus: "Mixed" })

    const result = await eventFormPrerequisites(event.id, false)
    expect(result.fieldGender).toBeUndefined()
  })

  it("stays quiet when no table is gendered at all", async () => {
    const event = await seedEvent()
    await seedGenderedGroup(event.id)

    const result = await eventFormPrerequisites(event.id, false)
    expect(result.fieldGender).toBeUndefined()
  })

  it("ignores a switched-off table, which is never offered anyway", async () => {
    const event = await seedEvent()
    const group = await seedGenderedGroup(event.id, { facilitatorGender: "Male" })
    await db.breakoutGroup.update({ where: { id: group.id }, data: { isEnabled: false } })

    const result = await eventFormPrerequisites(event.id, false)
    expect(result.fieldGender).toBeUndefined()
  })

  it("counts a Collab day's own tables", async () => {
    const cluster = await seedCluster("Collab")
    const event = await db.event.create({
      data: { name: "Youth", type: "OneTime", startDate: new Date(), endDate: new Date() },
    })
    await db.eventClusterEvent.create({ data: { clusterId: cluster.id, eventId: event.id } })
    await db.eventModule.create({ data: { eventId: event.id, type: "Breakout" } })
    await db.breakoutGroup.create({
      data: { clusterId: cluster.id, name: "Men's Table", genderFocus: "Male" },
    })

    const result = await clusterFormPrerequisites(cluster.id, "Collab")
    expect(result.fieldGender?.whenOff).toBe(true)
    expect(result.fieldGender?.message).toContain("for one gender")
  })
})
