"use client"

import { IconWifiOff } from "@tabler/icons-react"

import { useIsOffline } from "@/lib/hooks/use-is-offline"

/**
 * Tells a kiosk operator the connection is down, before they find out by losing
 * someone's registration.
 *
 * The app is a PWA, and `@ducanh2912/next-pwa` serves page documents
 * `NetworkFirst` with a 24-hour cache. That is the right trade for a tablet on
 * venue wifi — a brief drop doesn't blank the screen — but it has a sharp edge:
 * offline, the door renders perfectly from cache, showing tables and headcounts
 * from whenever it was last reached, and gives no sign that a submit is going
 * nowhere. A form that looks like it works is worse than one that plainly
 * doesn't.
 *
 * **Advisory, never a block.** Nothing here disables a button. Only the offline
 * signal is trustworthy, not the online one (see {@link useIsOffline}), and a
 * false negative that greys out a working door is a worse failure than a submit
 * that fails with a message someone can read. `useKioskRefresh` refreshes the
 * moment the network is back, so this clears itself along with the stale data
 * behind it.
 */
export function OfflineNotice() {
  const offline = useIsOffline()
  if (!offline) return null

  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <IconWifiOff className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
      <div className="space-y-0.5">
        <p className="font-medium">No connection</p>
        <p className="text-muted-foreground">
          What&apos;s on screen may be out of date, and anything submitted now
          won&apos;t save. This clears on its own once the connection is back.
        </p>
      </div>
    </div>
  )
}
