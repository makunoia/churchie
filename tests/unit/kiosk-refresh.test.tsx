// @vitest-environment jsdom
/**
 * `useKioskRefresh` — how a long-lived kiosk page stops showing yesterday's data.
 *
 * The door and the check-in boards are opened once on a tablet and left running,
 * and everything they were server-rendered with ages underneath them: the
 * breakout candidates (whose set is *gated* on which facilitators have checked
 * in, so it is designed to change through the morning), their headcounts, and
 * the form config itself. `revalidatePath` cannot reach a React tree already
 * mounted in someone else's browser; only the client can ask again.
 *
 *  - unit:       polls while idle, never while something is in progress
 *  - edge case:  a hidden tab is never polled, and catches up when it returns
 *  - regression: the listener and timer are both torn down, so a board that
 *                leaves the idle step stops refreshing instead of refreshing
 *                forever
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { useKioskRefresh } from "@/lib/hooks/use-kiosk-refresh"

function Kiosk({ idle }: { idle: boolean }) {
  useKioskRefresh(idle, 1000)
  return null
}

/** `visibilityState` is a getter on the prototype — stub it, don't assign it. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  })
}

/** Same for `navigator.onLine`, which jsdom hard-codes to true. */
function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => online,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  refresh.mockClear()
  setVisibility("visible")
  setOnline(true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("while the kiosk is idle", () => {
  it("re-reads the server's data on every interval", () => {
    render(<Kiosk idle />)

    expect(refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(3000)
    expect(refresh).toHaveBeenCalledTimes(3)
  })
})

describe("while something is in progress", () => {
  it("never refreshes", () => {
    // The whole reason the hook takes a flag. A refresh mid-form would swap
    // `config` — and with it which questions render — out from under someone
    // answering them.
    render(<Kiosk idle={false} />)

    vi.advanceTimersByTime(5000)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("stops refreshing as soon as the kiosk leaves the idle step", () => {
    // Regression: an interval that outlives the idle state keeps refreshing for
    // the life of the page, which is the disruption above on a timer.
    const view = render(<Kiosk idle />)
    vi.advanceTimersByTime(1000)
    expect(refresh).toHaveBeenCalledTimes(1)

    view.rerender(<Kiosk idle={false} />)
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe("a backgrounded tab", () => {
  it("is not polled", () => {
    setVisibility("hidden")
    render(<Kiosk idle />)

    vi.advanceTimersByTime(5000)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("catches up the moment it comes back", () => {
    // The other shape of the same gap: a staffer switches to the admin board to
    // add a table, then switches back. Waiting out the interval would show them
    // the old list on the screen they just changed.
    setVisibility("hidden")
    render(<Kiosk idle />)
    vi.advanceTimersByTime(5000)
    expect(refresh).not.toHaveBeenCalled()

    setVisibility("visible")
    document.dispatchEvent(new Event("visibilitychange"))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("stops listening once unmounted", () => {
    const view = render(<Kiosk idle />)
    view.unmount()

    document.dispatchEvent(new Event("visibilitychange"))
    vi.advanceTimersByTime(5000)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("a kiosk with no network", () => {
  it("is not polled", () => {
    // The request cannot leave, and firing it every minute only fills the
    // console with failures a staffer can do nothing about.
    setOnline(false)
    render(<Kiosk idle />)

    vi.advanceTimersByTime(5000)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("catches up the instant the connection returns", () => {
    // The valuable half. Venue wifi dropping is the ordinary case; without this
    // edge the door shows whatever it held at the moment of the drop until the
    // next interval happens to land.
    setOnline(false)
    render(<Kiosk idle />)
    vi.advanceTimersByTime(5000)
    expect(refresh).not.toHaveBeenCalled()

    setOnline(true)
    window.dispatchEvent(new Event("online"))
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

// ─── The wiring ──────────────────────────────────────────────────────────────

/**
 * Source assertions, in the shape `checkin-search-dedupe.test.ts` already uses.
 *
 * The hook being correct is worth nothing if a surface forgets to call it, and
 * these three are the surfaces the staleness was actually reported on. Rendering
 * `RegistrationForm` for real would need the whole config, candidate and profile
 * apparatus around it; what matters here is only that each kiosk refreshes
 * between people and that the door polls while it waits.
 */
describe("the surfaces that use it", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

  it("refreshes the walk-in door between people, and polls at its idle gate", () => {
    const form = read("app/events/[id]/register/registration-form.tsx")
    // Between people: the other half of `handleReset`, which until now reset
    // client state only and left the server's props frozen at page load.
    expect(form).toMatch(/function handleReset\(\)[\s\S]{0,900}?router\.refresh\(\)/)
    // While waiting: the identify gate only — never `"form"`, which is a step
    // someone may be part-way through answering.
    expect(form).toContain('useKioskRefresh(!!walkIn && step === "identify")')
    // Every step returns through `FormShell`, so one mount covers a connection
    // that drops mid-form as well as one that was down when the door opened.
    expect(form).toMatch(/function FormShell\([\s\S]{0,600}?<OfflineNotice \/>/)
  })

  it("refreshes the event check-in kiosk", () => {
    const board = read("app/events/[id]/checkin/checkin-board.tsx")
    expect(board).toMatch(/function reset\(\)[\s\S]{0,400}?router\.refresh\(\)/)
    expect(board).toContain('useKioskRefresh(step === "lookup")')
    expect(board).toContain("<OfflineNotice />")
  })

  it("refreshes the collab day's check-in kiosk", () => {
    const board = read("app/register/c/[token]/check-in/cluster-checkin-board.tsx")
    expect(board).toMatch(/const reset = React\.useCallback\([\s\S]{0,400}?router\.refresh\(\)/)
    expect(board).toContain('useKioskRefresh(step === "lookup")')
    expect(board).toContain("<OfflineNotice />")
  })
})
