import { describe, expect, it } from "vitest"

import {
  clusterCheckinRemovalEvents,
  clusterCheckinRemovalSkipHint,
  planClusterCheckinRemoval,
  type ClusterCheckinRemovalRow,
  type ClusterCheckinRemovalTarget,
} from "@/lib/clusters/checkin-removal"

/**
 * Undoing an arrival on the cluster admin board.
 *
 * The mirror of `planClusterCheckinToggle`, and pinned the same way: a check-in
 * lives in one of two shapes depending on the event, and the planner's whole job
 * is dispatching to the right one. Everything here is pure, so the rules hold
 * without a database.
 */

const oneTime: ClusterCheckinRemovalTarget = {
  shortcut: { eventId: "e-onetime", eventName: "Youth Night", eventType: "OneTime" },
  occurrenceId: null,
}
const recurring: ClusterCheckinRemovalTarget = {
  shortcut: { eventId: "e-recurring", eventName: "Sunday Service", eventType: "Recurring" },
  occurrenceId: "occ-today",
}

function row(overrides: Partial<ClusterCheckinRemovalRow> = {}): ClusterCheckinRemovalRow {
  return {
    id: "r1",
    eventId: "e-onetime",
    kind: "Registrant",
    checkedIn: true,
    ...overrides,
  }
}

describe("planClusterCheckinRemoval", () => {
  // The two lanes `recordCheckinAttendance` writes, undone the same two ways.
  it("clears attendedAt on a OneTime event and the session row on a recurring one", () => {
    const ops = planClusterCheckinRemoval(
      [oneTime, recurring],
      [row(), row({ id: "r2", eventId: "e-recurring" })]
    )
    expect(ops).toEqual([
      {
        kind: "attendedAt",
        eventId: "e-onetime",
        eventName: "Youth Night",
        subject: { kind: "registrant", id: "r1" },
      },
      {
        kind: "occurrence",
        eventId: "e-recurring",
        eventName: "Sunday Service",
        occurrenceId: "occ-today",
        subject: { kind: "registrant", id: "r2" },
      },
    ])
  })

  it("undoes a volunteer's shift on the volunteer lane", () => {
    const ops = planClusterCheckinRemoval([oneTime], [row({ kind: "Volunteer", id: "v1" })])
    expect(ops).toEqual([
      {
        kind: "attendedAt",
        eventId: "e-onetime",
        eventName: "Youth Night",
        subject: { kind: "volunteer", id: "v1" },
      },
    ])
  })

  // The board collapses a person's rows into one cell per event. Undoing the
  // cell has to undo every row behind it, or it comes back checked in.
  it("clears every row a person holds on one event", () => {
    const ops = planClusterCheckinRemoval(
      [oneTime],
      [row({ id: "r1" }), row({ id: "r2" }), row({ id: "v1", kind: "Volunteer" })]
    )
    expect(ops).toHaveLength(3)
    expect(ops.map((op) => (op.kind === "attendedAt" ? op.subject : null))).toEqual([
      { kind: "registrant", id: "r1" },
      { kind: "registrant", id: "r2" },
      { kind: "volunteer", id: "v1" },
    ])
  })

  it("leaves an event the person never arrived on alone", () => {
    const ops = planClusterCheckinRemoval([oneTime], [row({ checkedIn: false })])
    expect(ops).toEqual([
      {
        kind: "skip",
        eventId: "e-onetime",
        eventName: "Youth Night",
        reason: "notIn",
      },
    ])
  })

  // Not a skip and not an op — an event this person holds no row on is simply
  // not part of the question, and reporting it would put every other event of
  // the day in the toast.
  it("says nothing about an event the person isn't on", () => {
    expect(planClusterCheckinRemoval([oneTime, recurring], [row()])).toHaveLength(1)
  })

  // A dateless day reads every session's attendance, so it can't name the one
  // sitting to undo — and clearing them all would erase history nobody asked
  // about. Sent to the session's own screen instead.
  it("refuses a session event whose day names no session", () => {
    const ops = planClusterCheckinRemoval(
      [{ ...recurring, occurrenceId: null }],
      [row({ eventId: "e-recurring" })]
    )
    expect(ops).toEqual([
      {
        kind: "skip",
        eventId: "e-recurring",
        eventName: "Sunday Service",
        reason: "noSession",
      },
    ])
  })

  // A OneTime event records on the row itself, so it never needed one.
  it("needs no session for a OneTime event", () => {
    const ops = planClusterCheckinRemoval([oneTime], [row()])
    expect(ops[0].kind).toBe("attendedAt")
  })

  it("plans nothing for a person with no rows", () => {
    expect(planClusterCheckinRemoval([oneTime, recurring], [])).toEqual([])
  })
})

describe("clusterCheckinRemovalEvents", () => {
  // What the confirm dialog and the toast name. Two rows on one event are one
  // event to the person reading it.
  it("names each event once and leaves the skips out", () => {
    const ops = planClusterCheckinRemoval(
      [oneTime, recurring],
      [
        row({ id: "r1" }),
        row({ id: "r2" }),
        row({ id: "r3", eventId: "e-recurring", checkedIn: false }),
      ]
    )
    expect(clusterCheckinRemovalEvents(ops)).toEqual([
      { eventId: "e-onetime", eventName: "Youth Night" },
    ])
  })
})

describe("clusterCheckinRemovalSkipHint", () => {
  it("says why, in words an admin can act on", () => {
    expect(clusterCheckinRemovalSkipHint("notIn")).toContain("no arrival")
    expect(clusterCheckinRemovalSkipHint("noSession")).toContain("session")
  })
})
