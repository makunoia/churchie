"use client"

import * as React from "react"
import Link from "next/link"
import { IconCheck, IconLoader2, IconUserQuestion } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PhonePHInput } from "@/components/ui/phone-ph-input"
import {
  checkInToCluster,
  lookupClusterCheckin,
  searchClusterCheckinByName,
  type ClusterCheckinOutcome,
} from "@/app/(dashboard)/events/cluster-actions"
import {
  getCheckinBreakoutChoices,
  pickCheckinBreakout,
} from "@/app/(dashboard)/events/breakout-actions"
import { BreakoutPicker } from "@/components/breakouts/breakout-picker"
import type { CheckinBreakoutChoices } from "@/lib/breakouts/checkin-choices"
import {
  clusterCheckinCellNote,
  recordableCells,
  skipReasonFor,
  type ClusterCheckinEventCell,
  type ClusterCheckinPerson,
} from "@/lib/clusters/checkin-person"

/**
 * The cluster day's check-in kiosk.
 *
 * A deliberately lean sibling of the per-event `CheckinBoard`, not a reuse of
 * it: that component is built around one event and one occurrence, and carries
 * the DGroup prompt, the profile form and household check-in on top. The same
 * lookup feel — name type-ahead, mobile fallback, confirm, reset — over a
 * different unit of work: one person, every event of the day.
 *
 * The screen never creates a registration. An event the person didn't sign up
 * for shows as "Not registered" and points at the walk-in door, which is the one
 * surface allowed to register someone at the door.
 *
 * ## Collab days say nothing about events (CCF-148)
 *
 * On a `Parallel` day the per-event breakdown is the whole value: someone attending
 * two of three events needs to see which two, and which one they're missing.
 *
 * On a `Collab` day it is worse than noise. The day is one event to everyone
 * attending, and a registrant belongs to exactly one member event — their
 * ministry's. Listing every member event beside them would re-expose the split the
 * day exists to hide, and would do it in the most alarming way available: the
 * partner ministry's event, which they were never meant to join, renders as "Not
 * registered" next to their name.
 *
 * So a collab check-in is name → tap → confirm → welcome, and which event the
 * attendance landed on is the system's business. Nothing about the write changes;
 * `checkInToCluster` records the same cells either way.
 */

const NAME_DEBOUNCE_MS = 300

type Step = "lookup" | "disambiguate" | "confirm" | "breakout" | "success" | "not-found"

export function ClusterCheckinBoard({
  token,
  kind,
  walkInHref,
  offerBreakout = false,
}: {
  token: string
  /** Which shape of day this is — see the Collab note above. */
  kind: "Parallel" | "Collab"
  /** The day's door, or null while it's closed — a link that dead-ends is worse than none. */
  walkInHref: string | null
  /**
   * Whether the day's check-in form offers the breakout step (Collab only — a
   * Parallel day owns no tables). Resolved on the server from the cluster's
   * `CheckIn` form config, so the switch is an admin's, not a shape the board
   * infers.
   *
   * The step itself says nothing about events. A cluster-owned table belongs to
   * the *day*, so naming the member event behind the seat would re-expose exactly
   * the split this board exists to hide.
   */
  offerBreakout?: boolean
}) {
  /** A collab never names the day's events; a parallel day always does. */
  const showEvents = kind !== "Collab"
  const [step, setStep] = React.useState<Step>("lookup")
  const [query, setQuery] = React.useState("")
  const [nameQuery, setNameQuery] = React.useState("")
  const [nameResults, setNameResults] = React.useState<ClusterCheckinPerson[]>([])
  const [nameSearchLoading, setNameSearchLoading] = React.useState(false)
  const [candidates, setCandidates] = React.useState<ClusterCheckinPerson[]>([])
  const [person, setPerson] = React.useState<ClusterCheckinPerson | null>(null)
  const [recordedCount, setRecordedCount] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [breakoutSubject, setBreakoutSubject] =
    React.useState<ClusterCheckinOutcome["breakoutSubject"]>(null)
  const [breakoutChoices, setBreakoutChoices] =
    React.useState<CheckinBreakoutChoices | null>(null)
  const [rawSelectedBreakoutId, setSelectedBreakoutId] = React.useState("")

  const inputRef = React.useRef<HTMLInputElement>(null)
  const nameDebounceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const reset = React.useCallback(() => {
    if (nameDebounceTimer.current) clearTimeout(nameDebounceTimer.current)
    setStep("lookup")
    setQuery("")
    setNameQuery("")
    setNameResults([])
    setNameSearchLoading(false)
    setCandidates([])
    setPerson(null)
    setRecordedCount(0)
    setBreakoutSubject(null)
    setBreakoutChoices(null)
    setSelectedBreakoutId("")
    setLoading(false)
    setError(null)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  React.useEffect(() => {
    inputRef.current?.focus()
    return () => {
      if (nameDebounceTimer.current) clearTimeout(nameDebounceTimer.current)
    }
  }, [])

  // Debounced name search — fires 300ms after the last keystroke.
  function handleNameQueryChange(value: string) {
    setNameQuery(value)
    setError(null)
    if (nameDebounceTimer.current) clearTimeout(nameDebounceTimer.current)
    if (value.trim().length < 2) {
      setNameResults([])
      setNameSearchLoading(false)
      return
    }
    setNameSearchLoading(true)
    nameDebounceTimer.current = setTimeout(async () => {
      const result = await searchClusterCheckinByName(token, value)
      setNameSearchLoading(false)
      if (!result.success) {
        setError(result.error)
        setNameResults([])
        return
      }
      setNameResults(result.data)
    }, NAME_DEBOUNCE_MS)
  }

  function select(candidate: ClusterCheckinPerson) {
    setPerson(candidate)
    setStep("confirm")
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    const result = await lookupClusterCheckin(token, query)
    setLoading(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    if (result.data === null) {
      setStep("not-found")
      return
    }
    if (result.data.matchType === "ambiguous") {
      setCandidates(result.data.candidates)
      setStep("disambiguate")
      return
    }
    select(result.data.person)
  }

  async function handleConfirm() {
    if (!person) return
    setLoading(true)
    setError(null)
    const result = await checkInToCluster(token, person.key)
    setLoading(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    setPerson(result.data.person)
    setRecordedCount(result.data.recorded.length)

    // The attendance is written either way — the breakout step is an extra
    // question on the way out, never a condition of being checked in. Any failure
    // to load it falls straight through to the welcome screen.
    const subject = result.data.breakoutSubject
    if (offerBreakout && subject) {
      setLoading(true)
      const choices = await getCheckinBreakoutChoices(
        subject.registrantId,
        subject.eventId,
        subject.occurrenceId,
        // The day's tables, not the member event's standing set. Both are in play
        // for this person; the kiosk they are standing at is what decides.
        "cluster"
      )
      setLoading(false)
      if (choices.success && choices.data && !choices.data.seatedGroupName) {
        setBreakoutSubject(subject)
        setBreakoutChoices(choices.data)
        setSelectedBreakoutId("")
        setStep("breakout")
        return
      }
    }

    setStep("success")
  }

  // Fixed for the life of the step — the profile behind the ranking was resolved
  // server-side and nothing here can change it. Derived rather than reset in an
  // effect, so a stale id is never live.
  const selectedBreakoutId = breakoutChoices?.options.some((g) => g.id === rawSelectedBreakoutId)
    ? rawSelectedBreakoutId
    : ""

  /** Skip and Continue-with-nothing-picked are the same act: leave them unseated. */
  async function handleBreakoutContinue() {
    if (!breakoutSubject || !selectedBreakoutId) {
      setStep("success")
      return
    }
    setLoading(true)
    const result = await pickCheckinBreakout(
      breakoutSubject.registrantId,
      breakoutSubject.eventId,
      breakoutSubject.occurrenceId,
      selectedBreakoutId,
      "cluster"
    )
    setLoading(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    setStep("success")
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────
  if (step === "lookup") {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-6">
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="cluster-checkin-name">Search by name</Label>
              <Input
                id="cluster-checkin-name"
                ref={inputRef}
                value={nameQuery}
                onChange={(e) => handleNameQueryChange(e.target.value)}
                placeholder="e.g. Juan dela Cruz"
                autoComplete="off"
              />
            </div>

            {nameSearchLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <IconLoader2 className="size-4 animate-spin" />
                Searching…
              </div>
            )}

            {!nameSearchLoading && nameResults.length > 0 && (
              <div className="flex flex-col gap-2">
                {nameResults.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => select(c)}
                    className="w-full rounded-xl border bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted"
                  >
                    <p className="font-medium">
                      {c.name}
                      {c.nickname && (
                        <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                          ({c.nickname})
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {subtitleFor(c, showEvents)}
                    </p>
                  </button>
                ))}
              </div>
            )}

            {!nameSearchLoading &&
              nameQuery.trim().length >= 2 &&
              nameResults.length === 0 && (
                <p className="text-center text-sm text-muted-foreground">
                  No results for &ldquo;{nameQuery.trim()}&rdquo;. Try your mobile number below
                  {walkInHref ? (
                    <>
                      , or{" "}
                      <Link
                        href={walkInHref}
                        className="underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground"
                      >
                        register as a walk-in
                      </Link>
                      .
                    </>
                  ) : (
                    "."
                  )}
                </p>
              )}
          </div>

          <div className="relative flex items-center gap-3">
            <div className="flex-1 border-t" />
            <span className="text-xs text-muted-foreground">or look up by</span>
            <div className="flex-1 border-t" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cluster-checkin-query">Mobile number</Label>
              <PhonePHInput
                id="cluster-checkin-query"
                value={query}
                onChange={(v) => {
                  setQuery(v)
                  setError(null)
                }}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={loading || !query.trim()}>
              {loading ? (
                <>
                  <IconLoader2 className="mr-2 size-4 animate-spin" />
                  Looking up…
                </>
              ) : (
                "Find me"
              )}
            </Button>
          </form>
        </div>
      </div>
    )
  }

  // ── Disambiguate ───────────────────────────────────────────────────────────
  if (step === "disambiguate") {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-6">
          <div className="space-y-1 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">Multiple profiles found</h2>
            <p className="text-sm text-muted-foreground">
              We found more than one registration matching{" "}
              <span className="font-medium">{query}</span>. Select the one that&apos;s you.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            {candidates.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => select(c)}
                className="w-full rounded-xl border bg-background px-6 py-4 text-left transition-colors hover:bg-muted/50"
              >
                <p className="text-lg font-semibold">{c.name}</p>
                {c.nickname && (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    &ldquo;{c.nickname}&rdquo;
                  </p>
                )}
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {subtitleFor(c, showEvents)}
                </p>
              </button>
            ))}
            <Button variant="ghost" className="w-full" onClick={reset}>
              That&apos;s not me
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ── Confirm ────────────────────────────────────────────────────────────────
  // On a parallel day, the whole day at a glance before anything is written: what
  // will be recorded, and why each of the rest won't be. On a collab, just the
  // name and a button.
  if (step === "confirm" && person) {
    const pending = recordableCells(person)
    const alreadyIn = person.events.some((c) => c.alreadyCheckedIn)
    const hasRegistration = person.events.some((c) => c.subject !== null)
    // Already checked in still leads somewhere: the write is idempotent and the
    // welcome screen tells them so. Only a genuine dead end — nothing registered,
    // or their event not taking check-ins — blocks the button, and then the reason
    // has to be said out loud, because a collab shows no cell list to infer it from.
    const canCheckIn = pending.length > 0 || alreadyIn
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-8">
          <div className="space-y-3 text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Is this you?
            </p>
            <div>
              <p className="text-3xl font-bold tracking-tight">{person.name}</p>
              {person.nickname && (
                <p className="mt-1 text-sm text-muted-foreground">
                  &ldquo;{person.nickname}&rdquo;
                </p>
              )}
            </div>
          </div>

          {showEvents && <EventCellList cells={person.events} walkInHref={walkInHref} />}

          {!showEvents && !canCheckIn && (
            <p className="text-center text-sm text-muted-foreground">
              {hasRegistration ? (
                "Check-in isn't open yet — please ask a staff member for help."
              ) : walkInHref ? (
                <>
                  We don&apos;t have a registration for you today.{" "}
                  <Link
                    href={walkInHref}
                    className="underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground"
                  >
                    Register now
                  </Link>
                  .
                </>
              ) : (
                "We don't have a registration for you today — please ask a staff member for help."
              )}
            </p>
          )}

          {error && <p className="text-center text-sm text-destructive">{error}</p>}

          <div className="flex flex-col gap-3">
            <Button
              className="w-full"
              onClick={handleConfirm}
              disabled={loading || !canCheckIn}
            >
              {loading ? (
                <>
                  <IconLoader2 className="mr-2 size-4 animate-spin" />
                  Checking in…
                </>
              ) : !canCheckIn ? (
                "Nothing to check in"
              ) : showEvents ? (
                `Yes, check me in (${pending.length})`
              ) : (
                // No count: on a collab there is only ever their own event, and a
                // number here would be a fact about the split.
                "Check me in"
              )}
            </Button>
            <Button variant="ghost" className="w-full" onClick={reset} disabled={loading}>
              That&apos;s not me
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ── Breakout Group ─────────────────────────────────────────────────────────
  // Collab only, and it names no events for the same reason nothing else here
  // does: the table belongs to the day, not to whichever ministry's event holds
  // the registration behind it.
  if (step === "breakout" && person && breakoutChoices) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-6">
          <div className="space-y-1 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">
              You&apos;re checked in
            </h2>
            <p className="text-sm text-muted-foreground">
              One last thing — which group would you like to join?
            </p>
          </div>

          <div className="space-y-4">
            <BreakoutPicker
              suggested={breakoutChoices.suggested}
              options={breakoutChoices.options}
              hasCandidates={breakoutChoices.hasCandidates}
              notice={breakoutChoices.notice}
              value={selectedBreakoutId}
              onChange={setSelectedBreakoutId}
              intro="Pick a group for today — optional."
              noticeReassurance="You're already checked in — a staff member will place you in a group."
            />
          </div>

          {error && <p className="text-center text-sm text-destructive">{error}</p>}

          <div className="flex flex-col gap-3">
            <Button className="w-full" onClick={handleBreakoutContinue} disabled={loading}>
              {loading ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : selectedBreakoutId ? (
                "Join this group"
              ) : (
                "Continue"
              )}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => setStep("success")}
              disabled={loading}
            >
              Skip for now
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (step === "success" && person) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-6 text-center">
          <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-green-100">
            <IconCheck className="size-10 text-green-600" />
          </div>
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold tracking-tight">
              Welcome, {person.nickname ?? person.name.split(" ")[0]}!
            </h2>
            <p className="text-sm text-muted-foreground">
              {recordedCount === 0
                ? "You were already checked in."
                : showEvents
                  ? `You're checked in for ${recordedCount} ${
                      recordedCount === 1 ? "event" : "events"
                    }.`
                  : // The count is the split again. They checked in; that's the news.
                    "You're all set — enjoy the day!"}
            </p>
          </div>

          {showEvents && <EventCellList cells={person.events} walkInHref={walkInHref} />}

          <Button className="w-full" onClick={reset}>
            Check in someone else
          </Button>
        </div>
      </div>
    )
  }

  // ── Not found ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center justify-center px-6 py-8">
      <div className="w-full space-y-6 text-center">
        <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-muted">
          <IconUserQuestion className="size-10 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Not found</h2>
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t find a registration for{" "}
            <span className="font-medium">{query}</span>.{" "}
            {walkInHref
              ? "You can register now or try a different lookup."
              : "Please ask a staff member for help."}
          </p>
        </div>
        <div className="flex flex-col gap-3">
          {walkInHref && (
            <Button className="w-full" asChild>
              <Link href={walkInHref}>Register now</Link>
            </Button>
          )}
          <Button variant="outline" className="w-full" onClick={reset}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  )
}

/** One line per event of the day, in cluster order. */
function EventCellList({
  cells,
  walkInHref,
}: {
  cells: ClusterCheckinEventCell[]
  walkInHref: string | null
}) {
  if (cells.length === 0) return null
  return (
    <ul className="divide-y rounded-xl border bg-muted/30 text-left">
      {cells.map((cell) => {
        const reason = skipReasonFor(cell)
        const done = cell.alreadyCheckedIn
        return (
          <li
            key={cell.eventId}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <span className={done || reason === null ? "font-medium" : "text-muted-foreground"}>
              {cell.eventName}
            </span>
            {reason === null ? (
              <span className="shrink-0 text-sm font-medium text-foreground">
                Checking in
              </span>
            ) : done ? (
              <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-green-600">
                <IconCheck className="size-4" />
                Checked in
              </span>
            ) : reason === "notRegistered" && walkInHref ? (
              <Link
                href={walkInHref}
                className="shrink-0 text-sm underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground"
              >
                Not registered
              </Link>
            ) : (
              <span className="shrink-0 text-sm text-muted-foreground">
                {clusterCheckinCellNote(reason)}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The line under a candidate's name, there to tell two same-name people apart.
 *
 * A parallel day leads with "2 of 3 events", which is the most distinguishing
 * thing available and useful in its own right. A collab has nothing to say there
 * — everyone is registered to exactly one member event, so the count would be
 * identical for every candidate *and* would name the split — so the masked
 * contact hint does the whole job.
 */
function subtitleFor(person: ClusterCheckinPerson, showEvents: boolean): string {
  const hint = person.contactHint ?? ""
  if (!showEvents) return hint
  const registered = person.events.filter((c) => c.subject !== null).length
  const summary =
    person.events.length === 0
      ? "No events today"
      : `${registered} of ${person.events.length} ${
          person.events.length === 1 ? "event" : "events"
        }`
  return hint ? `${summary} · ${hint}` : summary
}
