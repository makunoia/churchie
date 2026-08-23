import Link from "next/link"
import { IconInfoCircle } from "@tabler/icons-react"

/**
 * Shown on a member event's own breakouts page when the event belongs to a Collab
 * cluster (CCF-148).
 *
 * Two sets of tables exist on a collab day and **both are real**: the day runs on
 * the cluster's own fresh set, and the event keeps the standing tables below for
 * its own registration, its own check-in and its own Catch Mech. Orientation
 * rather than a warning — an earlier version of this notice said the groups below
 * "are not used on the day", which was true while a collab *substituted* its
 * tables for the event's on every event-side surface. It no longer does, so the
 * only thing left to say is where the other set lives.
 */
export function ClusterBreakoutsNotice({
  clusterId,
  clusterName,
}: {
  clusterId: string
  clusterName: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
      <IconInfoCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-1">
        <p className="font-medium">{clusterName} runs its own breakout groups</p>
        <p className="text-muted-foreground">
          This event is part of a collab, and the collab day is set up with a fresh
          set of tables of its own. The groups below are this event&apos;s standing
          tables — they stay in play for this event&apos;s own registration,
          check-in and Catch Mech.
        </p>
        <Link
          href={`/cluster/${clusterId}/breakouts`}
          className="inline-block font-medium underline decoration-dashed underline-offset-2 decoration-foreground/50 hover:decoration-foreground transition-colors"
        >
          Go to {clusterName} breakouts
        </Link>
      </div>
    </div>
  )
}
