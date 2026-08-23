"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { type ColumnDef } from "@tanstack/react-table"
import { IconCheck } from "@tabler/icons-react"
import { XIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/ui/data-table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { removeClusterCheckin } from "@/app/(dashboard)/events/cluster-actions"
import { phoneColumn } from "@/lib/tables/columns/contact"
import {
  clusterCheckinPersonHref,
  clusterCheckinStatusFor,
  filterClusterCheckinPeople,
  sortClusterCheckinPeople,
  type ClusterCheckinPerson,
  type ClusterCheckinSortDirection,
  type ClusterCheckinStatus,
  type ClusterCheckinStatusFilter,
  type ClusterCheckinTypeFilter,
} from "@/lib/clusters/checkin-board"
import { clusterCheckinRemovalSkipHint } from "@/lib/clusters/checkin-removal"
import { cn } from "@/lib/utils"

/**
 * Monitoring board — live check-in status for the day's events: one-time events,
 * and recurring events through the session this day is linked to. Check-in
 * itself happens on the links in the Shortcuts section above (and on the Forms
 * page); this list just shows who's arrived.
 *
 * Built the way the session detail screen is, because it answers the same
 * question about the same kind of gathering: stat tiles (owned by the page, so
 * they sit above Shortcuts), a filter strip, then cards below `xl` and a
 * `DataTable` above it. The hand-rolled row list this replaced could not be
 * filtered, sorted, searched by anything but name, or given a column an admin
 * chose — and it dead-ended, offering no route from a name on the board to the
 * record behind it.
 *
 * `showEventBreakdown` is off on a Collab day. There a person holds exactly one
 * of the day's events — their ministry's — so the badge column is one badge
 * repeating the same word down the whole list, and the day is built to stop
 * naming the split in the first place. The event filter goes with it: a filter
 * whose every option selects everyone is a control with nothing to do.
 */

const STATUS_LABEL: Record<ClusterCheckinStatus, string> = {
  CheckedIn: "Checked in",
  Partial: "Partly in",
  NotIn: "Not in yet",
}

/**
 * The state in words, always — never colour alone, and never only an icon. The
 * board is read across a room at a registration desk, and "is this row green"
 * is not a question a glance answers reliably.
 */
function StatusBadge({ person }: { person: ClusterCheckinPerson }) {
  const status = clusterCheckinStatusFor(person)
  if (status === "NotIn") {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        {STATUS_LABEL.NotIn}
      </Badge>
    )
  }
  return (
    <Badge variant={status === "CheckedIn" ? "default" : "secondary"}>
      {status === "CheckedIn" && <IconCheck className="size-3" />}
      {STATUS_LABEL[status]}
    </Badge>
  )
}

/** Member / Guest / Volunteer — one badge, same three cases in the card and the table. */
function TypeBadge({ person }: { person: ClusterCheckinPerson }) {
  if (person.isVolunteer) {
    return (
      <Badge variant="outline" className="border-amber-400 text-amber-600">
        Volunteer
      </Badge>
    )
  }
  if (person.isMember) return <Badge variant="secondary">Member</Badge>
  return <Badge variant="outline">Guest</Badge>
}

function EventBadges({ person }: { person: ClusterCheckinPerson }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {person.events.map((e) => (
        <Link key={e.eventId} href={clusterCheckinPersonHref(e)}>
          <Badge
            variant={e.checkedIn ? "default" : "outline"}
            className={cn(
              "font-normal transition-colors",
              e.checkedIn ? "hover:bg-primary/85" : "hover:bg-muted",
            )}
          >
            {e.checkedIn && <IconCheck className="size-3" />}
            {e.eventName}
          </Badge>
        </Link>
      ))}
    </div>
  )
}

function personHref(person: ClusterCheckinPerson): string | null {
  const first = person.events[0]
  return first ? clusterCheckinPersonHref(first) : null
}

function PersonName({ person }: { person: ClusterCheckinPerson }) {
  const href = personHref(person)
  const label = person.name || (
    <span className="text-muted-foreground italic">No name</span>
  )
  if (!href) return <span className="font-medium">{label}</span>
  return (
    <Link
      href={href}
      className="font-medium underline decoration-dashed underline-offset-2 decoration-foreground/50 hover:decoration-foreground transition-colors"
    >
      {label}
    </Link>
  )
}

/**
 * Undo an arrival — the board's answer to the session screen's "Remove from
 * session", and deliberately the same control in the same place, because it is
 * the same correction: someone was tapped in by mistake, or tapped in twice on
 * two devices, and the room's count is now wrong.
 *
 * Hidden rather than disabled for a person who hasn't arrived. A disabled button
 * on every un-arrived row is a column of dead controls down the list the board
 * exists to show, and there is nothing here to explain — the arrival it would
 * undo does not exist.
 */
function RemoveCheckinButton({ onSelect }: { onSelect: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={onSelect}
        >
          <XIcon className="size-4" />
          <span className="sr-only">Undo check-in</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Undo check-in</TooltipContent>
    </Tooltip>
  )
}

function buildColumns({
  showEventBreakdown,
  statusSortDirection,
  onToggleStatusSort,
  canEdit,
  onRemove,
}: {
  showEventBreakdown: boolean
  statusSortDirection: ClusterCheckinSortDirection
  onToggleStatusSort: () => void
  canEdit: boolean
  onRemove: (person: ClusterCheckinPerson) => void
}): ColumnDef<ClusterCheckinPerson>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      meta: { label: "Name", width: "name", locked: true },
      cell: ({ row }) => <PersonName person={row.original} />,
    },
    {
      id: "status",
      // The sort is the caller's (it reorders the row set), so the header stays
      // a custom control rather than TanStack's own sorting — same arrangement
      // as the session attendees table.
      meta: { label: "Status", width: "status" },
      header: () => (
        <button
          type="button"
          onClick={onToggleStatusSort}
          aria-label={`Sort status ${statusSortDirection === "asc" ? "descending" : "ascending"}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          )}
        >
          <span>Status</span>
          <span className="text-xs">{statusSortDirection === "asc" ? "↑" : "↓"}</span>
        </button>
      ),
      cell: ({ row }) => <StatusBadge person={row.original} />,
    },
    {
      id: "type",
      header: "Type",
      meta: { label: "Type", width: "status" },
      cell: ({ row }) => <TypeBadge person={row.original} />,
    },
    ...(showEventBreakdown
      ? [
          {
            id: "events",
            accessorFn: (row: ClusterCheckinPerson) =>
              row.events.map((e) => e.eventName).join(", "),
            header: "Events",
            // A wrapping row of badges lays itself out; truncating would clip
            // the second chip rather than shortening any text.
            meta: { label: "Events", width: "wide", noTruncate: true },
            cell: ({ row }) => <EventBadges person={row.original} />,
          } satisfies ColumnDef<ClusterCheckinPerson>,
        ]
      : []),
    {
      accessorKey: "checkedInAtFormatted",
      header: "Checked in at",
      meta: { label: "Checked in at", width: "date" },
      cell: ({ row }) => (
        <span className="text-muted-foreground tabular-nums">
          {row.original.checkedInAtFormatted ?? "—"}
        </span>
      ),
    },
    // Carried on the row for the search box; shown only when an admin asks.
    phoneColumn<ClusterCheckinPerson>((row) => row.phone, { optIn: true }),
    ...(canEdit
      ? [
          {
            id: "actions",
            // `actions` (52px), never `micro`: a 32px icon trigger inside a
            // 44px cell overflows its own cell and loses the right edge of its
            // hit area against the card border.
            meta: { width: "actions", locked: true },
            cell: ({ row }: { row: { original: ClusterCheckinPerson } }) =>
              clusterCheckinStatusFor(row.original) === "NotIn" ? null : (
                <RemoveCheckinButton onSelect={() => onRemove(row.original)} />
              ),
          } satisfies ColumnDef<ClusterCheckinPerson>,
        ]
      : []),
  ]
}

export function ClusterCheckinClient({
  clusterId,
  people,
  events,
  hasCheckinEvents,
  showEventBreakdown = true,
  canEdit = false,
}: {
  clusterId: string
  people: ClusterCheckinPerson[]
  /** The day's events, for the event filter. Empty on a Collab day. */
  events: { id: string; name: string }[]
  hasCheckinEvents: boolean
  showEventBreakdown?: boolean
  /** Write access to the day — the undo control is hidden without it. */
  canEdit?: boolean
}) {
  const router = useRouter()
  const [search, setSearch] = React.useState("")
  const [typeFilter, setTypeFilter] = React.useState<ClusterCheckinTypeFilter>("all")
  const [statusFilter, setStatusFilter] = React.useState<ClusterCheckinStatusFilter>("all")
  const [eventFilter, setEventFilter] = React.useState("all")
  const [statusSortDirection, setStatusSortDirection] =
    React.useState<ClusterCheckinSortDirection>("asc")
  const [personToClear, setPersonToClear] = React.useState<ClusterCheckinPerson | null>(
    null,
  )
  const [clearing, setClearing] = React.useState(false)

  /**
   * The row is cleared on screen before the server answers and put back if the
   * write fails — the same optimistic shape the session screen's remove uses,
   * and for the same reason: this is run at a desk with a queue in front of it.
   *
   * Local rather than a bare `router.refresh()` so the tiles above (which the
   * page owns) and the row below don't disagree for a round trip. The refresh
   * still follows, to catch up everything this component doesn't own.
   */
  const [cleared, setCleared] = React.useState<Record<string, true>>({})

  async function handleRemoveCheckin() {
    const target = personToClear
    if (!target) return

    setClearing(true)
    const result = await removeClusterCheckin(clusterId, target.key)
    setClearing(false)
    setPersonToClear(null)

    if (!result.success) {
      toast.error(result.error)
      return
    }
    const { removed, skipped } = result.data
    if (removed.length === 0) {
      // Every event refused. Say which and why rather than a bare success — the
      // row is about to come back checked in on the refresh.
      toast.error(
        skipped.length > 0
          ? `Nothing to undo — ${skipped[0].eventName} ${clusterCheckinRemovalSkipHint(skipped[0].reason)}.`
          : "Nothing to undo.",
      )
      router.refresh()
      return
    }
    setCleared((current) => ({ ...current, [target.key]: true }))
    toast.success(
      removed.length === 1
        ? `Check-in undone for ${removed[0].eventName}`
        : `Check-in undone across ${removed.length} events`,
    )
    router.refresh()
  }

  // Applied before every filter and count, so the status filter, the sort and
  // the row the admin just cleared all agree within the same render.
  const visible = React.useMemo(
    () =>
      people.map((person) =>
        cleared[person.key]
          ? {
              ...person,
              events: person.events.map((e) => ({ ...e, checkedIn: false })),
              checkedInAtFormatted: null,
            }
          : person,
      ),
    [people, cleared],
  )

  const filtered = React.useMemo(
    () =>
      filterClusterCheckinPeople(visible, {
        type: typeFilter,
        status: statusFilter,
        eventId: showEventBreakdown ? eventFilter : "all",
        search,
      }),
    [visible, typeFilter, statusFilter, eventFilter, search, showEventBreakdown],
  )

  const sorted = React.useMemo(
    () => sortClusterCheckinPeople(filtered, statusSortDirection),
    [filtered, statusSortDirection],
  )

  const columns = React.useMemo(
    () =>
      buildColumns({
        showEventBreakdown,
        statusSortDirection,
        onToggleStatusSort: () =>
          setStatusSortDirection((current) => (current === "asc" ? "desc" : "asc")),
        canEdit,
        onRemove: setPersonToClear,
      }),
    [showEventBreakdown, statusSortDirection, canEdit],
  )

  if (!hasCheckinEvents) {
    return (
      <div className="space-y-2">
        <h3 className="type-label text-muted-foreground">Arrivals</h3>
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          Nothing to monitor yet. One-time events appear here automatically;
          a recurring event appears once its cluster link names a session.
        </div>
      </div>
    )
  }

  const isFiltered =
    search !== "" || typeFilter !== "all" || statusFilter !== "all" || eventFilter !== "all"

  return (
    <div className="space-y-3">
      <h3 className="type-label text-muted-foreground">Arrivals</h3>

      {/* Wraps rather than scrolls sideways: a filter you have to swipe to
          discover is a filter nobody uses. Controls are finger-sized below `xl`
          and only shrink to the compact desktop height above it — this board is
          run from a tablet at a registration desk. Inline rather than in the
          FilterBar drawer for the same reason: mid-event, "show me who isn't
          here yet" has to be one tap, not two plus a drawer. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or mobile…"
          className="h-9 w-full text-xs sm:w-52 xl:h-7"
        />

        <ToggleGroup
          type="single"
          value={statusFilter}
          onValueChange={(v) => setStatusFilter((v || "all") as ClusterCheckinStatusFilter)}
          className="flex-wrap gap-1"
        >
          <ToggleGroupItem value="all" className="h-9 px-3 text-xs xl:h-7">
            Everyone
          </ToggleGroupItem>
          <ToggleGroupItem value="in" className="h-9 px-3 text-xs xl:h-7">
            Checked in
          </ToggleGroupItem>
          <ToggleGroupItem value="out" className="h-9 px-3 text-xs xl:h-7">
            Not in yet
          </ToggleGroupItem>
        </ToggleGroup>

        <ToggleGroup
          type="single"
          value={typeFilter}
          onValueChange={(v) => setTypeFilter((v || "all") as ClusterCheckinTypeFilter)}
          className="flex-wrap gap-1"
        >
          <ToggleGroupItem value="all" className="h-9 px-3 text-xs xl:h-7">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="member" className="h-9 px-3 text-xs xl:h-7">
            Members
          </ToggleGroupItem>
          <ToggleGroupItem value="guest" className="h-9 px-3 text-xs xl:h-7">
            Guests
          </ToggleGroupItem>
          <ToggleGroupItem value="volunteer" className="h-9 px-3 text-xs xl:h-7">
            Volunteers
          </ToggleGroupItem>
        </ToggleGroup>

        {/* A Collab day's people hold exactly one event each, so every option
            here would select the whole list. */}
        {showEventBreakdown && events.length > 1 && (
          <Select value={eventFilter} onValueChange={setEventFilter}>
            <SelectTrigger className="h-9 w-full text-xs sm:w-44 xl:h-7 xl:w-40">
              <SelectValue placeholder="Event" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {events.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {people.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No one is on this day yet.
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {isFiltered ? "No one matches the current filters." : "No one is on this day yet."}
        </div>
      ) : (
        <>
          {/* Phone + tablet card list. `auto-fill` rather than a viewport
              breakpoint: the workspace sidebar is expanded at tablet widths, so
              a `sm:grid-cols-2` would split a ~460px column into two 200px cards
              and truncate every name. */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-2 xl:hidden">
            {sorted.map((person) => (
              <div key={person.key} className="rounded-lg border px-3 py-2.5">
                <div className="flex items-start gap-2">
                  {/* `block` is load-bearing: `truncate` sets overflow, which an
                      inline anchor ignores — a long name would push the status
                      badge off the card instead of clipping. */}
                  <span className="block min-w-0 flex-1 truncate text-sm">
                    <PersonName person={person} />
                  </span>
                  {/* Status and undo sit on the name's baseline row rather than
                      in their own stacked column, so they stay aligned with each
                      other however the meta line below wraps. */}
                  <div className="flex shrink-0 items-center gap-1">
                    <StatusBadge person={person} />
                    {canEdit && clusterCheckinStatusFor(person) !== "NotIn" && (
                      <RemoveCheckinButton onSelect={() => setPersonToClear(person)} />
                    )}
                  </div>
                </div>
                {/* One meta line, so every card is exactly two lines and the
                    arrival times line up down the right edge like a column.
                    The events are text here rather than the table's badges: a
                    wrapping row of chips inside a truncating cell clips the
                    second chip instead of shortening anything, and a card that
                    grows a line per event stops the times lining up at all. */}
                <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <TypeBadge person={person} />
                  <span className="min-w-0 flex-1 truncate">
                    {showEventBreakdown
                      ? person.events.map((e, i) => (
                          <span key={e.eventId} className={cn(!e.checkedIn && "opacity-60")}>
                            {i > 0 && " · "}
                            {e.checkedIn && (
                              <>
                                <IconCheck className="inline size-3" />
                                <span className="sr-only">Checked in for </span>
                              </>
                            )}
                            {e.eventName}
                          </span>
                        ))
                      : (person.phone ?? "")}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {person.checkedInAtFormatted && (
                      <>
                        <span className="sr-only">Checked in at </span>
                        {person.checkedInAtFormatted}
                      </>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {/* Desktop table — the column set needs the width a sidebar-less
              viewport gives. */}
          <div className="hidden xl:flex xl:flex-1 xl:flex-col">
            <DataTable
              tableKey="cluster.checkin"
              rowLabel={{ one: "person", many: "people" }}
              columns={columns}
              data={sorted}
            />
          </div>
        </>
      )}

      <Dialog
        open={personToClear !== null}
        onOpenChange={(open) => {
          if (!open && !clearing) setPersonToClear(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Undo check-in</DialogTitle>
            <DialogDescription>
              {personToClear ? (
                <>
                  Mark{" "}
                  <span className="font-medium">
                    {personToClear.name || "this person"}
                  </span>{" "}
                  as not yet arrived
                  {/* A Parallel day can hold several arrivals behind one row, so
                      the dialog names them rather than letting one click clear
                      an unstated number of events. A Collab person holds exactly
                      one, and naming it there would be noise. */}
                  {showEventBreakdown && personToClear.events.length > 1 ? (
                    <>
                      {" "}
                      on{" "}
                      <span className="font-medium">
                        {personToClear.events
                          .filter((e) => e.checkedIn)
                          .map((e) => e.eventName)
                          .join(", ")}
                      </span>
                    </>
                  ) : null}
                  ? Their registration is untouched and they can be checked in
                  again at the kiosk — though a series registrant whose only tie
                  to this day was the arrival will drop off the board with it.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={clearing}
              onClick={() => setPersonToClear(null)}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={clearing} onClick={handleRemoveCheckin}>
              {clearing ? "Undoing…" : "Undo check-in"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
