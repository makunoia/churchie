import { describe, expect, it } from "vitest"

import {
  buildClusterCheckinStats,
  clusterCheckinPersonHref,
  clusterCheckinStatusFor,
  filterClusterCheckinPeople,
  formatClusterCheckinRatio,
  sortClusterCheckinPeople,
  type ClusterCheckinPerson,
} from "@/lib/clusters/checkin-board"
import { buildClusterRoster, type ClusterRegistrantRow } from "@/lib/clusters/roster"

/**
 * The arithmetic behind the cluster admin check-in board, now that the board
 * renders the way the session detail screen does — stat tiles over a filtered,
 * sorted list. Everything here is pure, so the figures can be pinned without a
 * database and the tiles can never disagree with the rows beneath them.
 */

function person(overrides: Partial<ClusterCheckinPerson> = {}): ClusterCheckinPerson {
  return {
    key: "member:m1",
    name: "Maria Cruz",
    phone: "+63 917 111 2222",
    isMember: true,
    isVolunteer: false,
    gender: null,
    events: [
      {
        eventId: "e1",
        eventName: "Youth Night",
        registrantId: "r1",
        kind: "Registrant",
        checkedIn: false,
      },
    ],
    checkedInAtFormatted: null,
    ...overrides,
  }
}

function eventCell(eventId: string, checkedIn: boolean) {
  return {
    eventId,
    eventName: eventId,
    registrantId: `r-${eventId}`,
    kind: "Registrant" as const,
    checkedIn,
  }
}

const NO_FILTER = { type: "all", status: "all", eventId: "all", search: "" } as const

describe("clusterCheckinStatusFor", () => {
  it("names the three states a person can be in on the day", () => {
    expect(clusterCheckinStatusFor({ events: [eventCell("e1", false)] })).toBe("NotIn")
    expect(clusterCheckinStatusFor({ events: [eventCell("e1", true)] })).toBe("CheckedIn")
    expect(
      clusterCheckinStatusFor({ events: [eventCell("e1", true), eventCell("e2", false)] })
    ).toBe("Partial")
  })

  // A Collab person holds exactly one event, so the middle state can't arise —
  // which is what lets that day's board hide the per-event column entirely.
  it("has no middle state for someone holding one event", () => {
    expect(clusterCheckinStatusFor({ events: [eventCell("e1", true)] })).not.toBe("Partial")
  })

  // Nobody on any of the day's events is not "everyone is in".
  it("reads an empty event list as not in", () => {
    expect(clusterCheckinStatusFor({ events: [] })).toBe("NotIn")
  })
})

describe("buildClusterCheckinStats", () => {
  const people = [
    // In for one of two events — an arrival, partial or not.
    person({
      key: "member:m1",
      gender: "Female",
      events: [eventCell("e1", true), eventCell("e2", false)],
    }),
    person({ key: "member:m2", name: "Jon Reyes", gender: "Male", events: [eventCell("e1", true)] }),
    person({ key: "guest:g1", name: "Ana Lim", isMember: false, gender: "Female" }),
    person({
      key: "member:m3",
      name: "Paolo Diaz",
      isVolunteer: true,
      gender: "Male",
      events: [eventCell("e1", true)],
    }),
    person({ key: "member:m4", name: "Rita Uy", isVolunteer: true, gender: "Female" }),
  ]
  const stats = buildClusterCheckinStats(people)

  it("counts a partial arrival as in the room", () => {
    expect(stats.checkedInCount).toBe(3)
    expect(stats.notInCount).toBe(2)
    expect(stats.expected).toBe(5)
  })

  it("splits attendees from volunteers on both sides of the ratio", () => {
    expect(stats.attendeesCheckedIn).toBe(2)
    expect(stats.attendeesExpected).toBe(3)
    expect(stats.volunteersCheckedIn).toBe(1)
    expect(stats.volunteersExpected).toBe(2)
  })

  // The bar describes the room, not the guest list — someone who hasn't arrived
  // is not in it.
  it("takes the gender split from the arrivals alone", () => {
    expect(stats.menCount).toBe(2)
    expect(stats.womenCount).toBe(1)
  })

  // Unlike the session screen's, this denominator counts volunteers: a cluster
  // day expects people, not registrations, so the rate can't exceed 100%.
  it("rates arrivals against everyone expected", () => {
    expect(stats.turnout.preRegistered).toBe(5)
    expect(stats.turnout.checkedIn).toBe(3)
    expect(stats.turnout.rate).toBeCloseTo(0.6)
    expect(formatClusterCheckinRatio(stats)).toBe("3 of 5 expected")
  })

  it("has no rate at all before anyone is on the day", () => {
    expect(buildClusterCheckinStats([]).turnout.rate).toBeNull()
  })
})

describe("filterClusterCheckinPeople", () => {
  const maria = person({ key: "member:m1" })
  const guest = person({ key: "guest:g1", name: "Ana Lim", isMember: false, phone: null })
  const volunteer = person({
    key: "member:m3",
    name: "Paolo Diaz",
    phone: "+63 918 333 4444",
    isVolunteer: true,
    events: [eventCell("e2", true)],
  })
  const all = [maria, guest, volunteer]

  // Every volunteer is a member, so offering the two as peers would count them
  // twice — "Members" means members who are not serving.
  it("partitions type rather than overlapping it", () => {
    expect(
      filterClusterCheckinPeople(all, { ...NO_FILTER, type: "member" }).map((p) => p.key)
    ).toEqual(["member:m1"])
    expect(
      filterClusterCheckinPeople(all, { ...NO_FILTER, type: "guest" }).map((p) => p.key)
    ).toEqual(["guest:g1"])
    expect(
      filterClusterCheckinPeople(all, { ...NO_FILTER, type: "volunteer" }).map((p) => p.key)
    ).toEqual(["member:m3"])
  })

  it("answers 'who isn't here yet' in one filter", () => {
    expect(
      filterClusterCheckinPeople(all, { ...NO_FILTER, status: "out" }).map((p) => p.key)
    ).toEqual(["member:m1", "guest:g1"])
    expect(
      filterClusterCheckinPeople(all, { ...NO_FILTER, status: "in" }).map((p) => p.key)
    ).toEqual(["member:m3"])
  })

  it("scopes to one of the day's events", () => {
    expect(
      filterClusterCheckinPeople(all, { ...NO_FILTER, eventId: "e2" }).map((p) => p.key)
    ).toEqual(["member:m3"])
  })

  it("searches name and mobile, and tolerates a person with neither", () => {
    expect(filterClusterCheckinPeople(all, { ...NO_FILTER, search: "  ana " })).toHaveLength(1)
    expect(filterClusterCheckinPeople(all, { ...NO_FILTER, search: "917 111" })).toHaveLength(1)
    // A null phone must not throw or match the empty query fragment.
    expect(filterClusterCheckinPeople(all, { ...NO_FILTER, search: "0000" })).toHaveLength(0)
  })

  it("stacks filters", () => {
    expect(
      filterClusterCheckinPeople(all, { ...NO_FILTER, type: "volunteer", status: "out" })
    ).toHaveLength(0)
  })
})

describe("sortClusterCheckinPeople", () => {
  const rows = [
    person({ key: "a", name: "Zoe Santos", events: [eventCell("e1", true)] }),
    person({ key: "b", name: "Ben Cruz" }),
    person({ key: "c", name: "Mia Tan", events: [eventCell("e1", true), eventCell("e2", false)] }),
    person({ key: "d", name: "Ana Reyes" }),
  ]

  // The board exists to answer "who is missing", so ascending leads with them
  // rather than sorting the status label alphabetically.
  it("leads with the people the day is still waiting on", () => {
    expect(sortClusterCheckinPeople(rows, "asc").map((p) => p.name)).toEqual([
      "Ana Reyes",
      "Ben Cruz",
      "Mia Tan",
      "Zoe Santos",
    ])
  })

  it("flips for the other question", () => {
    expect(sortClusterCheckinPeople(rows, "desc").map((p) => p.name)).toEqual([
      "Zoe Santos",
      "Mia Tan",
      "Ana Reyes",
      "Ben Cruz",
    ])
  })

  it("leaves the input untouched", () => {
    const before = rows.map((p) => p.name)
    sortClusterCheckinPeople(rows, "desc")
    expect(rows.map((p) => p.name)).toEqual(before)
  })
})

describe("clusterCheckinPersonHref", () => {
  it("sends a volunteer to the volunteers screen, not the registrants one", () => {
    expect(clusterCheckinPersonHref({ ...eventCell("e1", true), kind: "Volunteer", registrantId: "v9" })).toBe(
      "/event/e1/volunteers/v9"
    )
    expect(clusterCheckinPersonHref(eventCell("e1", true))).toBe("/event/e1/registrants/r-e1")
  })
})

describe("the roster carries what the board renders", () => {
  const base: Omit<ClusterRegistrantRow, "id" | "eventId" | "checkedIn" | "checkedInAt"> = {
    kind: "Registrant",
    eventType: "Recurring",
    memberId: "m1",
    guestId: null,
    firstName: "Mark",
    lastName: "Noya",
    phone: null,
    isMember: true,
    gender: null,
    hasLinkedSession: true,
    registrationClusterId: null,
    registeredAt: new Date("2026-08-01T00:00:00.000Z"),
    onClusterDay: true,
  }
  const events = [
    { id: "e1", name: "PAG", type: "Recurring" as const },
    { id: "e2", name: "Youth", type: "Recurring" as const },
  ]

  // A walk-in row carries no profile. Taking the first stated answer is what
  // keeps it from erasing the gender the Member record already holds.
  it("keeps the first stated gender across a person's rows", () => {
    const roster = buildClusterRoster(events, [
      { ...base, id: "r1", eventId: "e1", checkedIn: false, checkedInAt: null, gender: null },
      { ...base, id: "r2", eventId: "e2", checkedIn: false, checkedInAt: null, gender: "Female" },
    ])
    expect(roster.rows).toHaveLength(1)
    expect(roster.rows[0].gender).toBe("Female")
  })

  it("carries each arrival's time onto its own cell", () => {
    const at = new Date("2026-08-22T01:30:00.000Z")
    const roster = buildClusterRoster(events, [
      { ...base, id: "r1", eventId: "e1", checkedIn: true, checkedInAt: at },
      { ...base, id: "r2", eventId: "e2", checkedIn: false, checkedInAt: null },
    ])
    expect(roster.rows[0].perEvent.e1?.checkedInAt).toEqual(at)
    expect(roster.rows[0].perEvent.e2?.checkedInAt).toBeNull()
  })
})
