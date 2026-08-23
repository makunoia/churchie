import { describe, expect, it } from "vitest"
import {
  belongsOnClusterList,
  buildClusterRoster,
  isOnClusterDay,
  personTypeFor,
  standingFor,
  volunteerIsOnClusterDay,
  type ClusterDayScope,
} from "@/lib/clusters/roster"
import type { EventType } from "@/app/generated/prisma/client"

/**
 * A cluster is one day; a Recurring/MultiDay event's registrations are not.
 * `isOnClusterDay` is the rule that keeps the day's figures about the day.
 */

const scope: ClusterDayScope = {
  kind: "Parallel",
  clusterId: "cluster-1",
  date: new Date("2026-08-02T00:00:00Z"),
}

/** Well clear of the scope date, so a row only counts on evidence we set. */
const LONG_BEFORE = new Date("2026-06-01T00:00:00Z")

function row(
  eventType: EventType,
  overrides: {
    checkedIn?: boolean
    registrationClusterId?: string | null
    hasLinkedSession?: boolean
    registeredAt?: Date
  } = {}
) {
  return {
    eventType,
    checkedIn: overrides.checkedIn ?? false,
    registrationClusterId: overrides.registrationClusterId ?? null,
    hasLinkedSession: overrides.hasLinkedSession ?? false,
    registeredAt: overrides.registeredAt ?? LONG_BEFORE,
  }
}

describe("isOnClusterDay", () => {
  it("counts every registration for a OneTime event — they are the day", () => {
    expect(isOnClusterDay(row("OneTime"), scope)).toBe(true)
  })

  it("counts a session registrant who checked in on the day", () => {
    expect(isOnClusterDay(row("Recurring", { checkedIn: true }), scope)).toBe(true)
    expect(isOnClusterDay(row("MultiDay", { checkedIn: true }), scope)).toBe(true)
  })

  it("counts a session registrant who signed up through this day's link", () => {
    expect(
      isOnClusterDay(row("Recurring", { registrationClusterId: "cluster-1" }), scope)
    ).toBe(true)
  })

  it("excludes a standing series registrant with no evidence for the day", () => {
    // The whole point: someone who registered for the weekly service months ago
    // and isn't here today is not part of today's figures.
    expect(isOnClusterDay(row("Recurring"), scope)).toBe(false)
  })

  it("excludes a registration stamped by a different cluster", () => {
    expect(
      isOnClusterDay(row("Recurring", { registrationClusterId: "cluster-2" }), scope)
    ).toBe(false)
  })

  it("counts everything when the cluster has no date to scope to", () => {
    const dateless: ClusterDayScope = { clusterId: "cluster-1", date: null, kind: "Parallel" }
    expect(isOnClusterDay(row("Recurring"), dateless)).toBe(true)
    expect(isOnClusterDay(row("Recurring"), null)).toBe(true)
  })

  it("scopes by the linked session even when the cluster has no date", () => {
    // Picking a session is itself a scope: the admin said which session this day
    // is, so a standing registrant with no attendance is not part of it.
    const dateless: ClusterDayScope = { clusterId: "cluster-1", date: null, kind: "Parallel" }
    expect(isOnClusterDay(row("Recurring", { hasLinkedSession: true }), dateless)).toBe(
      false
    )
    expect(
      isOnClusterDay(
        row("Recurring", { hasLinkedSession: true, checkedIn: true }),
        dateless
      )
    ).toBe(true)
  })

  // ── Registering on the day is evidence too ──
  //
  // Only the cluster's shared form stamps `registrationClusterId`, so someone
  // signing up on the day through an individual event's own link had no way to
  // carry it. Before this clause they were dropped from the roster entirely —
  // rendered as "not registered" while the add-registrant screen refused to add
  // them again, because the registration was already there.

  it("counts a session registrant who signed up on the cluster's day", () => {
    expect(
      isOnClusterDay(
        // 12:31pm Manila on the day — the shape of the production report.
        row("Recurring", { registeredAt: new Date("2026-08-02T04:31:00Z") }),
        scope
      )
    ).toBe(true)
  })

  it("reads the day in Manila time, not UTC", () => {
    // 00:30 Manila on 2 Aug is 1 Aug 16:30 UTC. A raw-UTC window would put the
    // day eight hours early and miss everyone who registered before 8am local.
    expect(
      isOnClusterDay(
        row("Recurring", { registeredAt: new Date("2026-08-01T16:30:00Z") }),
        scope
      )
    ).toBe(true)
    // 11pm Manila the evening BEFORE — outside the day at the other edge.
    expect(
      isOnClusterDay(
        row("Recurring", { registeredAt: new Date("2026-08-01T15:00:00Z") }),
        scope
      )
    ).toBe(false)
  })

  it("excludes a sign-up made the day after in Manila", () => {
    // 00:30 Manila on 3 Aug.
    expect(
      isOnClusterDay(
        row("Recurring", { registeredAt: new Date("2026-08-02T16:30:00Z") }),
        scope
      )
    ).toBe(false)
  })

  it("does not let the timestamp rescue a dateless cluster's linked session", () => {
    // No date means no window to test against; the linked session is the scope.
    const dateless: ClusterDayScope = { clusterId: "cluster-1", date: null, kind: "Parallel" }
    expect(
      isOnClusterDay(
        row("Recurring", {
          hasLinkedSession: true,
          registeredAt: new Date("2026-08-02T04:31:00Z"),
        }),
        dateless
      )
    ).toBe(false)
  })

  it("cannot grow later — the evidence is a fixed timestamp", () => {
    // The alternative (counting a linked session's whole series) would sweep in
    // people retroactively as new occurrences appear, silently moving figures
    // for days already reported. A registration date never moves.
    const registeredAt = new Date("2026-08-02T04:31:00Z")
    const before = isOnClusterDay(row("Recurring", { registeredAt }), scope)
    const after = isOnClusterDay(
      row("Recurring", { registeredAt, hasLinkedSession: true }),
      scope
    )
    expect(before).toBe(true)
    expect(after).toBe(true)
  })
})

describe("standingFor", () => {
  it("names the three states a cell can be in", () => {
    expect(standingFor({ kind: "Registrant" as const, registrantId: "r1", checkedIn: true, checkedInAt: null, onClusterDay: true })).toBe(
      "CheckedIn"
    )
    expect(
      standingFor({ kind: "Registrant" as const, registrantId: "r1", checkedIn: false, checkedInAt: null, onClusterDay: true })
    ).toBe("OnDay")
    expect(
      standingFor({ kind: "Registrant" as const, registrantId: "r1", checkedIn: false, checkedInAt: null, onClusterDay: false })
    ).toBe("SeriesOnly")
  })
})

describe("buildClusterRoster — day scoping is a flag, not a filter", () => {
  const events = [{ id: "e1", name: "PAG", type: "Recurring" as const }]
  const base = {
    kind: "Registrant" as const,
    eventId: "e1",
    eventType: "Recurring" as const,
    memberId: "m1",
    guestId: null,
    firstName: "Mark",
    lastName: "Noya",
    phone: null,
    isMember: true,
    gender: null,
    checkedInAt: null,
    hasLinkedSession: true,
    registrationClusterId: null,
    registeredAt: LONG_BEFORE,
  }

  it("keeps a series-only registrant on the roster with the flag down", () => {
    // The bug this replaces: the row was dropped, so the dashboard rendered "—"
    // ("not registered") for someone who was registered — and unaddable.
    const roster = buildClusterRoster(events, [
      { ...base, id: "r1", checkedIn: false, onClusterDay: false },
    ])
    expect(roster.rows).toHaveLength(1)
    expect(roster.rows[0].perEvent.e1).toEqual({
      registrantId: "r1",
      kind: "Registrant",
      checkedIn: false,
      checkedInAt: null,
      onClusterDay: false,
    })
    expect(standingFor(roster.rows[0].perEvent.e1!)).toBe("SeriesOnly")
  })

  it("keeps the strongest of two registrations on the same event", () => {
    const roster = buildClusterRoster(events, [
      { ...base, id: "r1", checkedIn: true, onClusterDay: true },
      { ...base, id: "r2", checkedIn: false, onClusterDay: false },
    ])
    expect(roster.rows[0].perEvent.e1?.registrantId).toBe("r1")
    // …in either arrival order — the rule is rank, not last-write-wins.
    const reversed = buildClusterRoster(events, [
      { ...base, id: "r2", checkedIn: false, onClusterDay: false },
      { ...base, id: "r1", checkedIn: true, onClusterDay: true },
    ])
    expect(reversed.rows[0].perEvent.e1?.registrantId).toBe("r1")
  })
})

// ─── A Collab day owns its list ──────────────────────────────────────────────
//
// The reported bug: a Collab cluster built from two ministries' existing events
// opened with both of their registrant lists already in it, so the day could not
// be used to track its own sign-ups. The day's rule is therefore stricter than a
// Parallel day's — nothing is inherited, and every "of course it's ours"
// shortcut is dropped.

describe("isOnClusterDay on a Collab day", () => {
  const collab: ClusterDayScope = { ...scope, kind: "Collab" }

  it("excludes a OneTime member event's pre-existing registrations", () => {
    // The Parallel reading — "a OneTime event's registrations are inherently the
    // day's" — is exactly the inheritance a collab must not have: the event
    // existed, with its own list, before the day was created around it.
    expect(isOnClusterDay(row("OneTime"), collab)).toBe(false)
    expect(isOnClusterDay(row("OneTime"), scope)).toBe(true)
  })

  it("excludes a standing series registrant of either ministry", () => {
    expect(isOnClusterDay(row("Recurring"), collab)).toBe(false)
  })

  it("counts a sign-up made through this day's shared form", () => {
    expect(
      isOnClusterDay(row("Recurring", { registrationClusterId: "cluster-1" }), collab)
    ).toBe(true)
    expect(
      isOnClusterDay(row("OneTime", { registrationClusterId: "cluster-1" }), collab)
    ).toBe(true)
  })

  it("counts someone who checked in — being here is evidence of the day", () => {
    expect(isOnClusterDay(row("Recurring", { checkedIn: true }), collab)).toBe(true)
    expect(isOnClusterDay(row("OneTime", { checkedIn: true }), collab)).toBe(true)
  })

  it("counts a registration made on the day itself, in Manila time", () => {
    expect(
      isOnClusterDay(
        row("Recurring", { registeredAt: new Date("2026-08-02T04:31:00Z") }),
        collab
      )
    ).toBe(true)
  })

  it("inherits nothing when the cluster has no date", () => {
    // A dateless Parallel day counts everything (nothing to scope to); a collab
    // still owns its list, so only the stamp and attendance speak for it.
    const dateless: ClusterDayScope = { clusterId: "cluster-1", date: null, kind: "Collab" }
    expect(isOnClusterDay(row("OneTime"), dateless)).toBe(false)
    expect(isOnClusterDay(row("Recurring"), dateless)).toBe(false)
    expect(
      isOnClusterDay(row("Recurring", { registrationClusterId: "cluster-1" }), dateless)
    ).toBe(true)
  })
})

describe("belongsOnClusterList", () => {
  const collab: ClusterDayScope = { ...scope, kind: "Collab" }

  it("keeps a Parallel day's series-only row so it can be shown as such", () => {
    expect(belongsOnClusterList({ onClusterDay: false }, scope)).toBe(true)
    expect(belongsOnClusterList({ onClusterDay: false }, null)).toBe(true)
  })

  it("drops it on a Collab day — the day's list is its own", () => {
    expect(belongsOnClusterList({ onClusterDay: false }, collab)).toBe(false)
    expect(belongsOnClusterList({ onClusterDay: true }, collab)).toBe(true)
  })
})

// ─── Volunteers are the day's people too ─────────────────────────────────────
//
// Somebody serving holds a `Volunteer` row and never an `EventRegistrant` one —
// the two are mutually exclusive by design — so a day roster built from
// registrations alone leaves the serving team out of the room it describes.

describe("volunteerIsOnClusterDay", () => {
  const collab: ClusterDayScope = { ...scope, kind: "Collab" }

  function volunteer(
    overrides: {
      checkedIn?: boolean
      registrationClusterId?: string | null
      registeredAt?: Date
    } = {}
  ) {
    return {
      checkedIn: overrides.checkedIn ?? false,
      registrationClusterId: overrides.registrationClusterId ?? null,
      registeredAt: overrides.registeredAt ?? LONG_BEFORE,
    }
  }

  it("counts a sign-up made through the day's volunteer form", () => {
    expect(
      volunteerIsOnClusterDay(volunteer({ registrationClusterId: "cluster-1" }), scope)
    ).toBe(true)
  })

  it("counts someone who checked in for the day", () => {
    expect(volunteerIsOnClusterDay(volunteer({ checkedIn: true }), scope)).toBe(true)
  })

  it("counts a sign-up made on the day itself", () => {
    expect(
      volunteerIsOnClusterDay(
        volunteer({ registeredAt: new Date("2026-08-02T04:31:00Z") }),
        scope
      )
    ).toBe(true)
  })

  it("leaves a ministry's standing serving team off the day", () => {
    // The rule is strict on BOTH kinds of day, unlike the registrant one: a
    // Volunteer row is not a registration for a date, so a Parallel day has no
    // more claim on months-old sign-ups than a Collab does.
    expect(volunteerIsOnClusterDay(volunteer(), scope)).toBe(false)
    expect(volunteerIsOnClusterDay(volunteer(), collab)).toBe(false)
  })

  it("attributes nothing when there is no day to attribute it to", () => {
    expect(volunteerIsOnClusterDay(volunteer({ checkedIn: true }), null)).toBe(false)
  })
})

describe("the roster's person type", () => {
  const events = [{ id: "e1", name: "PAG", type: "Recurring" as const }]
  const base = {
    eventId: "e1",
    eventType: "Recurring" as const,
    memberId: "m1",
    guestId: null,
    firstName: "Mark",
    lastName: "Noya",
    phone: null,
    isMember: true,
    gender: null,
    checkedInAt: null,
    hasLinkedSession: true,
    registrationClusterId: null,
    registeredAt: LONG_BEFORE,
    checkedIn: false,
    onClusterDay: true,
  }

  it("names a volunteer a Volunteer, not a Member", () => {
    const roster = buildClusterRoster(events, [
      { ...base, id: "v1", kind: "Volunteer" as const },
    ])
    expect(roster.rows[0].isVolunteer).toBe(true)
    expect(personTypeFor(roster.rows[0])).toBe("Volunteer")
    expect(roster.rows[0].perEvent.e1?.kind).toBe("Volunteer")
  })

  it("still names Member and Guest for everyone else", () => {
    expect(personTypeFor({ isVolunteer: false, isMember: true })).toBe("Member")
    expect(personTypeFor({ isVolunteer: false, isMember: false })).toBe("Guest")
  })

  it("lets serving win the cell when someone holds both records on one event", () => {
    // The same precedence the check-in kiosk applies: serving is the canonical
    // presence record, so the cell links to the sign-up an admin would edit.
    const roster = buildClusterRoster(events, [
      { ...base, id: "r1", kind: "Registrant" as const },
      { ...base, id: "v1", kind: "Volunteer" as const },
    ])
    expect(roster.rows[0].perEvent.e1?.registrantId).toBe("v1")
    // …in either arrival order.
    const reversed = buildClusterRoster(events, [
      { ...base, id: "v1", kind: "Volunteer" as const },
      { ...base, id: "r1", kind: "Registrant" as const },
    ])
    expect(reversed.rows[0].perEvent.e1?.registrantId).toBe("v1")
  })
})
