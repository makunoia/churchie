"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

/**
 * Keep a long-lived kiosk page's SERVER data current without anyone reloading it.
 *
 * The door and the check-in boards are opened once on a tablet and left running
 * for the length of an event, and the props they were rendered with go out of
 * date underneath them while they sit there:
 *
 *  - **Breakout candidates and their counts.** The walk-in door's picker is fed
 *    by `fetchBreakoutAvailability(..., requireCheckedIn: true)`, whose whole job
 *    is to hide tables whose facilitator has not arrived — so the set it returns
 *    is *designed* to change through the first half hour. Seatings move the
 *    counts, `isFull` and `fillLevel` with them. `RegistrationForm` takes all of
 *    that as a prop and re-ranks from it on every keystroke, so it re-ranks
 *    faithfully over a list frozen at page load.
 *  - **The form's own config.** `sectionBreakout`, `autoAssignBreakout` and the
 *    door's open/closed state are read on the server and passed down. An admin
 *    switching the Breakout step on mid-event changed nothing an open kiosk
 *    could see.
 *
 * `revalidatePath` cannot fix this and never could: it clears a server cache,
 * and the stale copy is a React tree already mounted in a browser somewhere else
 * entirely. Only the client can ask again, which is what `router.refresh()` does
 * — it re-runs the server component and hands down new props, leaving client
 * state (a half-typed form, the step someone is on) untouched.
 *
 * ## Why it only fires while `idle`
 *
 * A refresh mid-form would swap `config` out from under someone answering
 * questions, and swap the candidate list out from under a picker they are
 * looking at. `idle` is the caller's "nothing is in progress" — the lookup
 * screen a door sits on between people — where there is nothing to disturb and
 * a refresh is invisible. Callers should *also* refresh at the moment they reset
 * for the next person; this hook covers the gap that reset can't: the tablet
 * opened at 8am whose first walk-in arrives at 9, long after the facilitators
 * checked in.
 *
 * Visibility and connectivity are both honoured on their two edges — never work
 * that cannot succeed, and catch up the instant it can:
 *
 *  - **Hidden tab**: not polled, and refreshed the moment it is foregrounded.
 *    That is the other shape of the same gap — a staffer switching to the admin
 *    board to add a table, then switching back to the screen they just changed.
 *  - **Offline**: not polled, and refreshed the moment the network returns. A
 *    venue's wifi dropping is the ordinary case this exists for; without the
 *    `online` edge the door would show whatever it had at the moment of the drop
 *    until the next interval happened to land.
 */
export function useKioskRefresh(idle: boolean, intervalMs = 60_000) {
  const router = useRouter()

  React.useEffect(() => {
    if (!idle) return

    function refreshIfReachable() {
      // `router.refresh()` on a hidden tab would queue work the browser then
      // throttles anyway, and would land the moment it is foregrounded — which
      // is exactly what the visibility listener below does deliberately.
      if (document.visibilityState !== "visible") return
      // Only the negative is trustworthy here (see `useIsOffline`), which is all
      // this needs: skip the request the browser already knows cannot leave.
      if (!navigator.onLine) return
      router.refresh()
    }

    const timer = window.setInterval(refreshIfReachable, intervalMs)
    document.addEventListener("visibilitychange", refreshIfReachable)
    window.addEventListener("online", refreshIfReachable)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", refreshIfReachable)
      window.removeEventListener("online", refreshIfReachable)
    }
  }, [idle, intervalMs, router])
}
