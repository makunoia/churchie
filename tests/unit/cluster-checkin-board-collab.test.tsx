// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { ClusterCheckinClient } from "@/app/(event)/cluster/[id]/checkin/checkin-client"
import { ClusterCheckinShortcuts } from "@/app/(event)/cluster/[id]/checkin/checkin-shortcuts"
import type { ClusterCheckinShortcut } from "@/lib/clusters/checkin-shortcuts"
import type { ClusterCheckinPerson } from "@/lib/clusters/checkin-board"

// The board is a client component that refreshes after an undo, and reaches the
// server action to do it. Neither exists in jsdom.
const { removeClusterCheckin } = vi.hoisted(() => ({
  removeClusterCheckin: vi.fn(async () => ({
    success: true as const,
    data: { removed: [{ eventId: "e-youth", eventName: "Youth Night" }], skipped: [] },
  })),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock("@/app/(dashboard)/events/cluster-actions", () => ({ removeClusterCheckin }))

/**
 * The ADMIN check-in board on a Collab day.
 *
 * Its public counterpart (`cluster-checkin-collab.test.tsx`) already pins that the
 * kiosk names no events. This file pins the same rule one screen back: the board a
 * staffer keeps up all day must not re-expose the split either — no per-event door
 * to a room that is half the day, and no badge column repeating one ministry's
 * event name down every row.
 *
 * The page decides which mode to render via `clusterOffersPerEventCheckin`; these
 * assertions are about what each mode actually puts on screen.
 */

function shortcut(overrides: Partial<ClusterCheckinShortcut> = {}): ClusterCheckinShortcut {
  return {
    eventId: "e-youth",
    eventName: "Youth Night",
    eventType: "Recurring",
    href: "/events/e-youth/checkin/occ-1",
    sessionDate: new Date("2026-08-09T00:00:00.000Z"),
    status: "open",
    manageHref: "/event/e-youth/sessions",
    ...overrides,
  }
}

function renderShortcuts(shortcuts: ClusterCheckinShortcut[]) {
  return render(
    <ClusterCheckinShortcuts
      shortcuts={shortcuts}
      checkInHref="/register/c/tok-1/check-in"
      checkInSettingsHref={null}
      walkInHref="/register/c/tok-1/walk-in"
      walkInSettingsHref={null}
      canConfigure
    />
  )
}

const person = (
  overrides: Partial<ClusterCheckinPerson> = {}
): ClusterCheckinPerson => ({
  key: "member:m1",
  name: "Maria Cruz",
  phone: "+63 917 111 2222",
  isMember: true,
  isVolunteer: false,
  gender: null,
  events: [
    {
      eventId: "e-youth",
      eventName: "Youth Night",
      registrantId: "r1",
      kind: "Registrant",
      checkedIn: false,
    },
  ],
  checkedInAtFormatted: null,
  ...overrides,
})

/**
 * The board renders its card list and its table together — CSS hides one at a
 * time, and jsdom applies no CSS — so every row's text is on screen twice.
 * Asserting on presence rather than count is what keeps these tests about the
 * board's rules instead of its breakpoints.
 */
function renderBoard(props: Partial<React.ComponentProps<typeof ClusterCheckinClient>> = {}) {
  // `app/layout.tsx` mounts the provider for the whole app, so the board uses a
  // bare `Tooltip` the way every other screen does; the test supplies what the
  // layout would.
  return render(
    <TooltipProvider>
      <ClusterCheckinClient
        clusterId="c1"
        people={[person()]}
        events={[{ id: "e-youth", name: "Youth Night" }]}
        hasCheckinEvents
        {...props}
      />
    </TooltipProvider>
  )
}

/**
 * Undoing an arrival — the board's answer to the session screen's "Remove from
 * session". The write itself is pinned in the integration test; what matters
 * here is who is offered the control at all.
 */
describe("collab admin board — undoing a check-in", () => {
  const arrived = person({
    events: [
      {
        eventId: "e-youth",
        eventName: "Youth Night",
        registrantId: "r1",
        kind: "Registrant",
        checkedIn: true,
      },
    ],
    checkedInAtFormatted: "09:14 AM",
  })

  it("offers it on an arrival when the staffer may write", () => {
    renderBoard({ people: [arrived], canEdit: true })
    expect(screen.getAllByRole("button", { name: "Undo check-in" }).length).toBeGreaterThan(0)
  })

  // Read-only staff monitor the day; they don't correct it.
  it("withholds it without write access", () => {
    renderBoard({ people: [arrived] })
    expect(screen.queryByRole("button", { name: "Undo check-in" })).toBeNull()
  })

  // Hidden, not disabled: a column of dead controls down every un-arrived row
  // is noise on the list the board exists to show, and there is no arrival to
  // explain away.
  it("withholds it from someone who never arrived", () => {
    renderBoard({ people: [person()], canEdit: true })
    expect(screen.queryByRole("button", { name: "Undo check-in" })).toBeNull()
  })

  // A Parallel registrant part-way through the day still has something to undo.
  it("offers it on a partial arrival", () => {
    renderBoard({
      canEdit: true,
      events: [
        { id: "e-youth", name: "Youth Night" },
        { id: "e-kids", name: "Kids Church" },
      ],
      people: [
        person({
          events: [
            {
              eventId: "e-youth",
              eventName: "Youth Night",
              registrantId: "r1",
              kind: "Registrant",
              checkedIn: true,
            },
            {
              eventId: "e-kids",
              eventName: "Kids Church",
              registrantId: "r2",
              kind: "Registrant",
              checkedIn: false,
            },
          ],
        }),
      ],
    })
    expect(screen.getAllByRole("button", { name: "Undo check-in" }).length).toBeGreaterThan(0)
  })
})

describe("collab admin board — Shortcuts", () => {
  // The page passes `shortcuts={[]}` on a Collab day; the section must still be
  // the day's two doors rather than disappearing with them.
  it("keeps both day-wide doors when there are no per-event ones", () => {
    renderShortcuts([])
    expect(screen.getByRole("link", { name: /^Open Day check-in/ })).toBeTruthy()
    expect(screen.getByRole("link", { name: /^Open Walk-in registration/ })).toBeTruthy()
  })

  it("names no member event", () => {
    renderShortcuts([])
    expect(screen.queryByText("Youth Night")).toBeNull()
    expect(screen.queryByRole("link", { name: /^Check-in/ })).toBeNull()
  })

  it("still offers the per-event door on a parallel day", () => {
    renderShortcuts([shortcut()])
    expect(screen.getByText("Youth Night")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: /^Check-in/ }).getAttribute("href")
    ).toBe("/events/e-youth/checkin/occ-1")
  })
})

describe("collab admin board — Arrivals", () => {
  it("drops the per-event badge from every row", () => {
    renderBoard({ events: [], showEventBreakdown: false })
    expect(screen.getAllByText("Maria Cruz").length).toBeGreaterThan(0)
    expect(screen.queryByText("Youth Night")).toBeNull()
  })

  // The badges were what said "not here yet". Collapsed, the row has to say it.
  it("says in words whether each person is in", () => {
    renderBoard({
      events: [],
      showEventBreakdown: false,
      people: [
        person(),
        person({
          key: "member:m2",
          name: "Jon Reyes",
          events: [
            {
              eventId: "e-youth",
              eventName: "Youth Night",
              registrantId: "r2",
              kind: "Registrant",
              checkedIn: true,
            },
          ],
        }),
      ],
    })
    expect(screen.getAllByText("Not in yet").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Checked in").length).toBeGreaterThan(0)
  })

  // The event filter is a Collab-day control with nothing to do: everyone holds
  // the one event, so every option selects the whole list.
  it("offers no event filter on a collab day", () => {
    renderBoard({ events: [], showEventBreakdown: false })
    expect(screen.queryByText("All events")).toBeNull()
  })

  // On a Parallel day the two say different things: the badges name WHICH
  // events someone is in for, the status column says where they stand on the
  // day as a whole — which is the only place "Partly in" can be said at all.
  it("keeps the badges and states the whole-day status beside them", () => {
    renderBoard({
      people: [
        person({
          events: [
            {
              eventId: "e-youth",
              eventName: "Youth Night",
              registrantId: "r1",
              kind: "Registrant",
              checkedIn: true,
            },
            {
              eventId: "e-kids",
              eventName: "Kids Church",
              registrantId: "r2",
              kind: "Registrant",
              checkedIn: false,
            },
          ],
        }),
      ],
      events: [
        { id: "e-youth", name: "Youth Night" },
        { id: "e-kids", name: "Kids Church" },
      ],
    })
    expect(screen.getAllByText("Youth Night").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Kids Church").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Partly in").length).toBeGreaterThan(0)
  })

  // The board dead-ended before: a name on it was plain text, so the record
  // behind an arrival could only be found by leaving for another screen.
  it("routes each name to the record behind it", () => {
    renderBoard({
      people: [
        person({
          isVolunteer: true,
          events: [
            {
              eventId: "e-youth",
              eventName: "Youth Night",
              registrantId: "v9",
              kind: "Volunteer",
              checkedIn: true,
            },
          ],
        }),
      ],
    })
    const links = screen.getAllByRole("link", { name: "Maria Cruz" })
    expect(links.length).toBeGreaterThan(0)
    // A volunteer's record lives on the volunteers screen — `/registrants/v9`
    // would 404 on an id that table has never held.
    expect(links[0].getAttribute("href")).toBe("/event/e-youth/volunteers/v9")
  })
})
