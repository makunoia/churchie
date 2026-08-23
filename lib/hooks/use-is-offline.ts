"use client"

import * as React from "react"

/**
 * Whether the browser knows it has no network.
 *
 * ## Only the negative is trustworthy
 *
 * `navigator.onLine === false` means the browser has no route to anywhere — a
 * dropped venue wifi, a tablet that wandered out of range. It is reliable, and
 * it is the only thing this hook reports.
 *
 * `navigator.onLine === true` means only that *a* network interface exists. It
 * says nothing about whether the app's server is reachable — a captive portal at
 * a venue is `true` all day. So this hook is deliberately one-directional: it
 * can tell you the door is definitely offline, never that it is definitely fine.
 *
 * Which is why callers should use it to **explain**, not to block. A false
 * negative here would disable a door that actually works, and a staffer who
 * cannot register anyone is worse off than one whose submit fails with an error
 * they can read.
 *
 * ## Why it starts as online
 *
 * `navigator` does not exist during the server render, and reading it in the
 * first client render would hydrate a different tree than the server sent. The
 * initial state is therefore always "online" and the real value arrives in an
 * effect — one frame late, which for a banner nobody is waiting on is free.
 */
export function useIsOffline(): boolean {
  const [offline, setOffline] = React.useState(false)

  React.useEffect(() => {
    const sync = () => setOffline(!navigator.onLine)
    // Catch the case where the connection dropped before this mounted — the
    // listeners below only fire on a *change*.
    sync()
    window.addEventListener("online", sync)
    window.addEventListener("offline", sync)
    return () => {
      window.removeEventListener("online", sync)
      window.removeEventListener("offline", sync)
    }
  }, [])

  return offline
}
