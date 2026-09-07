import Link from "next/link"
import { IconArrowMerge, IconCalendar, IconCheck, IconClock, IconMessageCircle, IconPencil, IconUserCheck, IconX } from "@tabler/icons-react"
import { TimelineEntry } from "@/components/ui/timeline-entry"
import { memberLogLabel } from "@/lib/member-log"
import { MERGE_LOG_ACTION } from "@/lib/people/merge-fields"
import {
  logActorName,
  SMALL_GROUP_LOG_LABEL,
  SMALL_GROUP_LOG_TONE,
} from "@/lib/small-group-log"
import type { SmallGroupLogAction } from "@/app/generated/prisma/client"

type SmallGroupLogEntry = {
  kind: "smallGroupLog"
  id: string
  action: SmallGroupLogAction
  description: string | null
  createdAt: Date
  smallGroup: {
    id: string
    name: string
  }
  performedByUser: {
    name: string | null
  } | null
  performedByMember: { firstName: string; lastName: string } | null
}

type EventRegistrationEntry = {
  kind: "eventRegistration"
  id: string
  event: { id: string; name: string }
  createdAt: Date
}

type GuestOriginEntry = {
  kind: "guestOrigin"
  guestId: string
  createdAt: Date
}

type CatchMechCommentEntry = {
  kind: "catchMechComment"
  id: string
  text: string
  createdAt: Date
  author: { name: string | null }
  event: { id: string; name: string } | null
}

type MemberLogEntry = {
  kind: "memberLog"
  id: string
  /** Free-string `MemberLog.action`; `memberLogLabel` handles unknown values. */
  action: string
  description: string | null
  event: { id: string; name: string } | null
  createdAt: Date
}

export type MemberActivityEntry =
  | SmallGroupLogEntry
  | EventRegistrationEntry
  | GuestOriginEntry
  | CatchMechCommentEntry
  | MemberLogEntry


function iconForSmallGroupAction(action: SmallGroupLogEntry["action"]) {
  const tone = SMALL_GROUP_LOG_TONE[action]

  if (tone === "negative") {
    return (
      <span className="inline-flex size-5 items-center justify-center rounded-full bg-destructive/10">
        <IconX className="size-3 text-destructive" />
      </span>
    )
  }

  if (tone === "positive") {
    return (
      <span className="inline-flex size-5 items-center justify-center rounded-full bg-emerald-50">
        <IconCheck className="size-3 text-emerald-700" />
      </span>
    )
  }

  return (
    <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted">
      <IconClock className="size-3 text-muted-foreground" />
    </span>
  )
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
}

export function MemberActivityLog({ entries }: { entries: MemberActivityEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No activity yet
      </p>
    )
  }

  return (
    <div>
      {entries.map((entry, i) => {
        const isLast = i === entries.length - 1

        if (entry.kind === "guestOrigin") {
          return (
            <TimelineEntry
              key={`guest-origin-${entry.guestId}`}
              icon={
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-green-100">
                  <IconUserCheck className="size-3 text-green-700" />
                </span>
              }
              isLast={isLast}
            >
              <p className="text-sm font-medium">Promoted from guest</p>
              <p className="text-xs text-muted-foreground">
                <Link
                  href={`/guests/${entry.guestId}`}
                  className="font-medium underline decoration-dashed underline-offset-2 decoration-foreground/50 hover:decoration-foreground transition-colors"
                >
                  View guest record
                </Link>
                {" · "}
                {formatDate(entry.createdAt)}
              </p>
            </TimelineEntry>
          )
        }

        if (entry.kind === "eventRegistration") {
          return (
            <TimelineEntry
              key={`reg-${entry.id}`}
              icon={
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-blue-100">
                  <IconCalendar className="size-3 text-blue-700" />
                </span>
              }
              isLast={isLast}
            >
              <p className="text-sm font-medium">Registered for event</p>
              <p className="text-xs text-muted-foreground">
                <Link
                  href={`/event/${entry.event.id}`}
                  className="font-medium underline decoration-dashed underline-offset-2 decoration-foreground/50 hover:decoration-foreground transition-colors"
                >
                  {entry.event.name}
                </Link>
                {" · "}
                {formatDate(entry.createdAt)}
              </p>
            </TimelineEntry>
          )
        }

        if (entry.kind === "catchMechComment") {
          return (
            <TimelineEntry
              key={`cm-comment-${entry.id}`}
              icon={
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-blue-100">
                  <IconMessageCircle className="size-3 text-blue-700" />
                </span>
              }
              isLast={isLast}
            >
              <p className="text-sm">{entry.text}</p>
              <p className="text-xs text-muted-foreground">
                {entry.author.name ?? "Unknown"}
                {entry.event && (
                  <>
                    {" · "}
                    <Link
                      href={`/event/${entry.event.id}/catch-mech`}
                      className="font-medium underline decoration-dashed underline-offset-2 decoration-foreground/50 hover:decoration-foreground transition-colors"
                    >
                      {entry.event.name}
                    </Link>
                  </>
                )}
                {" · "}
                {formatDate(entry.createdAt)}
              </p>
            </TimelineEntry>
          )
        }

        if (entry.kind === "memberLog") {
          const isMerge = entry.action === MERGE_LOG_ACTION
          return (
            <TimelineEntry
              key={`member-log-${entry.id}`}
              icon={
                isMerge ? (
                  <span className="inline-flex size-5 items-center justify-center rounded-full bg-amber-100">
                    <IconArrowMerge className="size-3 text-amber-700" />
                  </span>
                ) : (
                  <span className="inline-flex size-5 items-center justify-center rounded-full bg-violet-100">
                    <IconPencil className="size-3 text-violet-700" />
                  </span>
                )
              }
              isLast={isLast}
            >
              <p className="text-sm font-medium">{memberLogLabel(entry.action)}</p>
              <p className="text-xs text-muted-foreground">
                {entry.event && (
                  <>
                    <Link
                      href={`/event/${entry.event.id}`}
                      className="font-medium underline decoration-dashed underline-offset-2 decoration-foreground/50 hover:decoration-foreground transition-colors"
                    >
                      {entry.event.name}
                    </Link>
                    {" · "}
                  </>
                )}
                {formatDate(entry.createdAt)}
              </p>
              {entry.description && (
                // A merge report is multi-line — what was carried, what was folded, and
                // every conflicting value it had to discard. Collapsing that to one line
                // would hide the only surviving record of the deleted profile.
                <p className="text-xs text-muted-foreground mt-0.5 whitespace-pre-line">
                  {entry.description}
                </p>
              )}
            </TimelineEntry>
          )
        }

        // SmallGroupLog entry
        return (
          <TimelineEntry
            key={entry.id}
            icon={iconForSmallGroupAction(entry.action)}
            isLast={isLast}
          >
            {logActorName(entry) && (
              <p className="text-xs text-muted-foreground">Action by {logActorName(entry)}</p>
            )}
            <p className="text-sm font-medium">
              {entry.description ?? SMALL_GROUP_LOG_LABEL[entry.action]}
            </p>
            <p className="text-xs text-muted-foreground">
              <Link
                href={`/small-groups/${entry.smallGroup.id}`}
                className="font-medium underline decoration-dashed underline-offset-2 decoration-foreground/50 hover:decoration-foreground transition-colors"
              >
                {entry.smallGroup.name}
              </Link>
              {" · "}
              {formatDate(entry.createdAt)}
            </p>
          </TimelineEntry>
        )
      })}
    </div>
  )
}
