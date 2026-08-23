"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { IconCheck, IconLoader2, IconUserQuestion, IconArrowLeft } from "@tabler/icons-react"
import { useKioskRefresh } from "@/lib/hooks/use-kiosk-refresh"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScheduleInput } from "@/components/ui/schedule-input"
import { Label } from "@/components/ui/label"
import { PhonePHInput } from "@/components/ui/phone-ph-input"
import { MultiSelect } from "@/components/ui/multi-select"
import { PrivacyPolicyCheckbox } from "@/components/ui/privacy-policy-checkbox"
import {
  BARE_EVENT_FORM_CONFIG,
  fieldsForContext,
  type EventFormConfigData,
} from "@/lib/forms/context-config"
import {
  missingRequiredFields,
  requiredFieldsMessage,
} from "@/lib/forms/registration-payload"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  lookupCheckinRegistrant,
  searchCheckinByName,
  markCheckinAttendance,
  checkInToOccurrence,
  lookupHouseholdForCheckin,
  checkInHousehold,
  addHouseholdMemberAtCheckin,
  recordSmallGroupInterestAtCheckin,
  saveCheckinMatchingProfile,
  saveCheckinClaimedGroup,
  type CheckinPerson,
  type HouseholdCheckin,
} from "@/app/(dashboard)/events/actions"
import {
  autoAssignRegistrantToBreakout,
  getRegistrantBreakoutGroupName,
  getCheckinBreakoutChoices,
  pickCheckinBreakout,
} from "@/app/(dashboard)/events/breakout-actions"
import { BreakoutPicker } from "@/components/breakouts/breakout-picker"
import type { CheckinBreakoutChoices } from "@/lib/breakouts/checkin-choices"
import { searchMembersForLeaderLookup } from "@/app/(dashboard)/guests/actions"
import type { MatchingProfileInput } from "@/lib/validations/matching-profile"
import { LANGUAGE_OPTIONS, CITY_OPTIONS } from "@/lib/constants/group-options"
import { WALK_IN_CLOSED_MESSAGE } from "@/lib/events/walk-in-access"
import { FAMILY_ROLES, FAMILY_ROLE_LABELS, type FamilyRoleValue } from "@/lib/validations/family"
import { cn } from "@/lib/utils"

type LifeStage = { id: string; name: string }
type AgeRangeBucket = { id: string; label: string }
type LeaderResult = { id: string; firstName: string; lastName: string; ledGroups: { id: string; name: string }[] }

type SmallGroupPrompt = {
  person: CheckinPerson
  existingProfile: {
    lifeStageId: string | null
    gender: "Male" | "Female" | null
    language: string[]
    meetingPreference: "Online" | "Hybrid" | "InPerson" | null
    workCity: string | null
    scheduleDayOfWeek: number | null
    scheduleTimeStart: string | null
    scheduleTimeEnd: string | null
    ageRangeBucketId: string | null
  }
}

type Step =
  | "lookup"
  | "confirm"
  | "disambiguate"
  | "already-in"
  | "success"
  | "not-found-prompt"
  | "sg-prompt"
  | "sg-profile"
  | "sg-leader-search"
  | "household"
  // Last before success, and deliberately after the DGroup steps: `sg-profile` is
  // where someone can supply gender and life stage for the first time, and those
  // are the two answers the suggestion turns on. Ranking before it would rank
  // against a profile we are about to improve.
  | "breakout"

type CheckinSubjectKind = "registrant" | "volunteer"

type DisambiguateCandidate = {
  kind: CheckinSubjectKind
  subjectId: string
  name: string
  nickname: string | null
  alreadyCheckedIn: boolean
  contactHint: string | null
  smallGroupPrompt: SmallGroupPrompt | null
}

type CheckinRegistrantResult = DisambiguateCandidate

type MatchedState = {
  kind: CheckinSubjectKind
  subjectId: string
  name: string
  nickname: string | null
  smallGroupPrompt: SmallGroupPrompt | null
  // Breakout group the registrant belongs to, resolved after check-in.
  // Null for volunteers, walk-ins with no match, or unassigned registrants.
  breakoutGroupName: string | null
}

type Props = {
  eventId: string
  occurrenceId: string | null
  lifeStages?: LifeStage[]
  ageRanges?: AgeRangeBucket[]
  defaultLifeStageId?: string
  autoAssignBreakout?: boolean
  /**
   * Which sections and fields the Check-in context collects (CCF-119/120).
   * Omitted → bare, so nothing optional is asked.
   */
  config?: Partial<EventFormConfigData>
  /**
   * Whether the walk-in form is reachable (CCF-133). Resolved on the server by
   * `resolveWalkInAccess` so this board and the walk-in page agree. Defaults to
   * false: a link that dead-ends is worse than no link.
   */
  walkInOpen?: boolean
}

export function CheckinBoard({ eventId, occurrenceId, lifeStages = [], ageRanges = [], defaultLifeStageId = "", autoAssignBreakout = false, config, walkInOpen = false }: Props) {
  const cfg = React.useMemo<EventFormConfigData>(
    () => ({ ...BARE_EVENT_FORM_CONFIG, ...config }),
    [config]
  )
  const [step, setStep] = React.useState<Step>("lookup")
  const router = useRouter()

  /**
   * The kiosk sitting on its search box between arrivals.
   *
   * The per-person data here is already fresh — every tap calls a server action.
   * What is frozen is the CONFIG this board was rendered with (`config`,
   * `autoAssignBreakout`, `walkInOpen`), so an admin switching the Breakout step
   * on mid-event, or opening the door, changed nothing the tablet could see.
   * See `useKioskRefresh`.
   */
  useKioskRefresh(step === "lookup")
  const [query, setQuery] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [matched, setMatched] = React.useState<MatchedState | null>(null)
  const [disambiguateCandidates, setDisambiguateCandidates] = React.useState<DisambiguateCandidate[]>([])
  const [nameQuery, setNameQuery] = React.useState("")
  const [nameResults, setNameResults] = React.useState<CheckinRegistrantResult[]>([])
  const [nameSearchLoading, setNameSearchLoading] = React.useState(false)
  const [household, setHousehold] = React.useState<HouseholdCheckin | null>(null)
  const [householdSelection, setHouseholdSelection] = React.useState<Set<string>>(new Set())
  const [breakoutChoices, setBreakoutChoices] =
    React.useState<CheckinBreakoutChoices | null>(null)
  const [rawSelectedBreakoutId, setSelectedBreakoutId] = React.useState("")
  const [addingMember, setAddingMember] = React.useState(false)
  const [newMember, setNewMember] = React.useState({
    firstName: "",
    lastName: "",
    role: "Child" as FamilyRoleValue,
  })
  const inputRef = React.useRef<HTMLInputElement>(null)
  const phoneLookupRef = React.useRef<HTMLDivElement>(null)
  const nameDebounceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  function focusLookupInput() {
    setTimeout(() => {
      inputRef.current?.focus()
    }, 50)
  }

  function reset() {
    // Re-read the config this board was rendered with, for the next arrival —
    // the same half of the reset the walk-in door's own form does.
    router.refresh()
    if (nameDebounceTimer.current) clearTimeout(nameDebounceTimer.current)
    setStep("lookup")
    setQuery("")
    setError(null)
    setMatched(null)
    setDisambiguateCandidates([])
    setNameResults([])
    setNameQuery("")
    setHousehold(null)
    setHouseholdSelection(new Set())
    setBreakoutChoices(null)
    setSelectedBreakoutId("")
    setAddingMember(false)
    setNewMember({ firstName: "", lastName: "", role: "Child" })
    setLoading(false)
    focusLookupInput()
  }

  React.useEffect(() => {
    inputRef.current?.focus()
    return () => {
      if (nameDebounceTimer.current) clearTimeout(nameDebounceTimer.current)
    }
  }, [])

  // Debounced name search — fires 300ms after the last keystroke
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
      const result = await searchCheckinByName(eventId, value, occurrenceId)
      setNameSearchLoading(false)
      if (result.success) {
        setNameResults(result.data)
      }
    }, 300)
  }

  function handleCandidateSelect(c: CheckinRegistrantResult) {
    setMatched({
      kind: c.kind,
      subjectId: c.subjectId,
      name: c.name,
      nickname: c.nickname,
      smallGroupPrompt: c.smallGroupPrompt,
      breakoutGroupName: null,
    })
    if (c.alreadyCheckedIn) {
      setStep("already-in")
    } else {
      setStep("confirm")
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    if (!query.trim()) { setLoading(false); return }
    const result = await lookupCheckinRegistrant(eventId, query, occurrenceId)
    setLoading(false)

    if (!result.success) {
      setError(result.error)
      return
    }

    if (!result.data) {
      setStep("not-found-prompt")
      return
    }

    if ("matchType" in result.data && result.data.matchType === "ambiguous") {
      setDisambiguateCandidates(result.data.candidates)
      setStep("disambiguate")
      return
    }

    const checkinResult = result.data as CheckinRegistrantResult
    handleCandidateSelect(checkinResult)
  }

  /**
   * Whether this kiosk asks the person which table they want.
   *
   * The Check-in form's own toggle decides it, and nothing else does. It used to
   * also require auto-assign to be off, on the "replaces rather than sits beside"
   * rule the registration and walk-in forms apply — but at the kiosk that rule
   * points the other way. An event with auto-assign on had *no* way to ask,
   * however plainly the Check-in form said to: `handleConfirm` placed the person
   * a moment earlier, `getCheckinBreakoutChoices` then reported them already
   * seated, and the step was skipped. Turning the section on looked like it did
   * nothing.
   *
   * So at the door of the room the config wins and auto-assign is what steps
   * aside — see `handleConfirm`. This is the last moment anyone can ask, and the
   * person is standing right there; a silent placement is the weaker answer.
   * Registration and walk-in are unchanged, where nobody is waiting.
   */
  const offerBreakoutPicker = cfg.sectionBreakout

  async function handleConfirm() {
    if (!matched) return
    setLoading(true)

    const subject = { kind: matched.kind, id: matched.subjectId }
    const result =
      occurrenceId !== null
        ? await checkInToOccurrence(occurrenceId, subject)
        : await markCheckinAttendance(subject)

    if (!result.success) {
      setLoading(false)
      setError(result.error)
      return
    }

    // Resolve the registrant's breakout group so the success screen can show it.
    // Volunteers are not breakout participants, so they are never assigned or shown.
    if (matched.kind === "registrant") {
      // Auto-assign to the best breakout group first — only when the event opts in
      // AND this kiosk isn't about to ask. Otherwise the registrant either picked a
      // group at registration or stays unassigned by choice. We await so the
      // assignment exists before we read it.
      //
      // The `!offerBreakoutPicker` half is what keeps the two from racing: placing
      // someone here and then asking them would be offering a choice already made,
      // and the step would in fact never render — it skips anyone already seated.
      if (occurrenceId !== null && autoAssignBreakout && !offerBreakoutPicker) {
        await autoAssignRegistrantToBreakout(matched.subjectId, eventId)
      }
      const breakout = await getRegistrantBreakoutGroupName(matched.subjectId, eventId)
      if (breakout) {
        setMatched((prev) => (prev ? { ...prev, breakoutGroupName: breakout.name } : prev))
      }
    }

    setLoading(false)

    // Household step. Strictly opt-in: it appears only when Family mode is on
    // for this event's Check-in context. Belonging to a family is not consent to
    // be asked about it at the door — an event that hasn't turned the section on
    // checks everyone in individually, even a whole household walking in
    // together.
    if (matched.kind === "registrant" && cfg.sectionFamily) {
      const hh = await lookupHouseholdForCheckin(eventId, matched.subjectId, occurrenceId)
      if (hh.success) {
        setHousehold(
          hh.data ?? {
            familyId: "",
            familyName: "Your household",
            members: [
              {
                registrantId: matched.subjectId,
                name: matched.name,
                nickname: matched.nickname,
                role: "Other",
                alreadyCheckedIn: true,
                isSubject: true,
              },
            ],
          }
        )
        setHouseholdSelection(
          new Set(
            (hh.data?.members ?? [])
              .filter((m) => !m.alreadyCheckedIn)
              .map((m) => m.registrantId)
          )
        )
        setStep("household")
        return
      }
    }

    // If this guest should be asked about a small group, show prompt first.
    // The DGroup section must be enabled for this event's Check-in context —
    // otherwise check-in stays a pure attendance surface.
    if (cfg.sectionSmallGroup && matched.smallGroupPrompt !== null) {
      setStep("sg-prompt")
    } else {
      void goToSuccess()
    }
  }

  /**
   * The one way out to the success screen, from every branch above it.
   *
   * The breakout step lives here rather than at each of the five call sites
   * because "who gets asked" is one rule: someone checking in as a registrant
   * (never a volunteer — they're serving, not attending), on a form that offers
   * the step, who isn't already sitting somewhere. Anything else goes straight
   * through, including any failure to load the choices: a kiosk that can't reach
   * the breakout data must still tell the person they're checked in.
   */
  async function goToSuccess() {
    if (!offerBreakoutPicker || !matched || matched.kind !== "registrant") {
      setStep("success")
      return
    }
    setLoading(true)
    const result = await getCheckinBreakoutChoices(matched.subjectId, eventId, occurrenceId)
    setLoading(false)
    if (!result.success || result.data === null || result.data.seatedGroupName) {
      setStep("success")
      return
    }
    setBreakoutChoices(result.data)
    setSelectedBreakoutId("")
    setError(null)
    setStep("breakout")
  }

  /** Leaves the household step for whatever would have come next. */
  function afterHousehold() {
    if (cfg.sectionSmallGroup && matched?.smallGroupPrompt) {
      setStep("sg-prompt")
      return
    }
    void goToSuccess()
  }

  // The options are fixed for the life of the step — the profile behind them was
  // resolved server-side and nothing on this screen can change it — so this guard
  // can only fire if the choices are swapped underneath a selection. Derived
  // rather than reset in an effect, so there is never a render where a stale id is
  // live and submittable.
  const selectedBreakoutId = breakoutChoices?.options.some((g) => g.id === rawSelectedBreakoutId)
    ? rawSelectedBreakoutId
    : ""

  /** Skip and Continue-with-nothing-picked are the same act: leave them unseated. */
  async function handleBreakoutContinue() {
    if (!matched || !selectedBreakoutId) {
      setStep("success")
      return
    }
    setLoading(true)
    const result = await pickCheckinBreakout(
      matched.subjectId,
      eventId,
      occurrenceId,
      selectedBreakoutId
    )
    setLoading(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    // Names the table on the success screen through the card that was already
    // there for the auto-assign path.
    const name = result.data?.name ?? null
    setMatched((prev) => (prev ? { ...prev, breakoutGroupName: name } : prev))
    setStep("success")
  }

  async function handleAddMember() {
    if (!matched) return
    if (!newMember.firstName.trim() || !newMember.lastName.trim()) {
      setError("Enter a first and last name")
      return
    }
    setLoading(true)
    setError(null)
    const result = await addHouseholdMemberAtCheckin(
      eventId,
      matched.subjectId,
      {
        firstName: newMember.firstName,
        lastName: newMember.lastName,
        role: newMember.role,
      },
      occurrenceId
    )
    if (!result.success) {
      setLoading(false)
      setError(result.error)
      return
    }
    // Re-read so the new person appears with their real registrant id, and so a
    // lazily-created family shows its proper name.
    const refreshed = await lookupHouseholdForCheckin(eventId, matched.subjectId, occurrenceId)
    setLoading(false)
    if (refreshed.success && refreshed.data) setHousehold(refreshed.data)
    setAddingMember(false)
    setNewMember({ firstName: "", lastName: "", role: "Child" })
  }

  async function handleHouseholdCheckIn() {
    if (householdSelection.size === 0) {
      afterHousehold()
      return
    }
    setLoading(true)
    const result = await checkInHousehold(eventId, [...householdSelection], occurrenceId)
    setLoading(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    afterHousehold()
  }

  // Walk-ins go to the walk-in form rather than an embedded copy of this one —
  // one form, one set of rules, no drift. It registers + checks in on submit and
  // links back here when done. No occurrence in the link: the walk-in page reads
  // the session an admin configured, so the door can't be pointed somewhere else
  // by a stale URL (CCF-133).
  //
  // Null when walk-in is closed. Offering the link anyway would send someone who
  // already can't find themselves to a page that just tells them no.
  const walkInHref = walkInOpen
    ? `/events/${eventId}/walk-in${
        query.trim() ? `?mobile=${encodeURIComponent(query.trim())}` : ""
      }`
    : null

  // ── Lookup ───────────────────────────────────────────────────────────────
  if (step === "lookup") {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-6">
          {/* Name search */}
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="checkin-name">Search by name</Label>
              <Input
                id="checkin-name"
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
                    key={`${c.kind}-${c.subjectId}`}
                    type="button"
                    onClick={() => handleCandidateSelect(c)}
                    className="w-full rounded-xl border bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted"
                  >
                    <p className="font-medium">
                      {c.name}
                      {c.nickname && (
                        <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                          ({c.nickname})
                        </span>
                      )}
                      {c.alreadyCheckedIn && (
                        <span className="ml-2 text-xs font-normal text-green-600">✓ checked in</span>
                      )}
                    </p>
                    {c.contactHint && (
                      <p className="text-sm text-muted-foreground">{c.contactHint}</p>
                    )}
                  </button>
                ))}
              </div>
            )}

            {!nameSearchLoading && nameQuery.trim().length >= 2 && nameResults.length === 0 && (
              <p className="text-sm text-muted-foreground text-center">
                No results for &ldquo;{nameQuery.trim()}&rdquo;. Try your mobile number below
                {walkInHref ? (
                  <>
                    , or{" "}
                    <Link
                      href={walkInHref}
                      className="underline decoration-dashed underline-offset-2 hover:text-foreground transition-colors"
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

          {/* Mobile / Email lookup */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="checkin-query">Mobile number</Label>
              <div ref={phoneLookupRef}>
                <PhonePHInput
                  id="checkin-query"
                  value={query}
                  onChange={(v) => {
                    setQuery(v)
                    setError(null)
                  }}
                />
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              type="submit"
              className="w-full"
              disabled={loading || !query.trim()}
            >
              {loading ? (
                <>
                  <IconLoader2 className="mr-2 size-4 animate-spin" />
                  Looking up…
                </>
              ) : (
                "Find my registration"
              )}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              {walkInHref ? (
                <>
                  Can&apos;t find yourself?{" "}
                  <Link
                    href={walkInHref}
                    className="underline decoration-dashed underline-offset-2 hover:text-foreground transition-colors"
                  >
                    Register as a walk-in
                  </Link>
                </>
              ) : (
                WALK_IN_CLOSED_MESSAGE
              )}
            </p>
          </form>
        </div>
      </div>
    )
  }

  // `query` holds the mobile/email value for the disambiguate step copy
  const lookupLabel = query

  // ── Disambiguate ─────────────────────────────────────────────────────────
  if (step === "disambiguate") {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-6">
          <div className="space-y-1 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">Multiple profiles found</h2>
            <p className="text-sm text-muted-foreground">
              We found multiple registrations matching{" "}
              <span className="font-medium">{lookupLabel}</span>. Select the one that&apos;s you.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            {disambiguateCandidates.map((c) => (
              <button
                key={`${c.kind}-${c.subjectId}`}
                type="button"
                onClick={() => {
                  setMatched({
                    kind: c.kind,
                    subjectId: c.subjectId,
                    name: c.name,
                    nickname: c.nickname,
                    smallGroupPrompt: c.smallGroupPrompt,
                    breakoutGroupName: null,
                  })
                  if (c.alreadyCheckedIn) {
                    setStep("already-in")
                  } else {
                    setStep("confirm")
                  }
                }}
                className="w-full rounded-xl border bg-background px-6 py-4 text-left transition-colors hover:bg-muted/50"
              >
                <p className="text-lg font-semibold">{c.name}</p>
                {c.nickname && (
                  <p className="mt-0.5 text-sm text-muted-foreground">&ldquo;{c.nickname}&rdquo;</p>
                )}
                {c.contactHint && (
                  <p className="mt-0.5 text-sm text-muted-foreground">{c.contactHint}</p>
                )}
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

  // ── Confirm ──────────────────────────────────────────────────────────────
  if (step === "confirm" && matched) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-8">
          <div className="space-y-3 text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Is this you?</p>
            <div>
              <p className="text-3xl font-bold tracking-tight">{matched.name}</p>
              {matched.nickname && (
                <p className="mt-1 text-sm text-muted-foreground">&ldquo;{matched.nickname}&rdquo;</p>
              )}
            </div>
          </div>

          {error && <p className="text-sm text-destructive text-center">{error}</p>}

          <div className="flex flex-col gap-3">
            <Button
              className="w-full"
              onClick={handleConfirm}
              disabled={loading}
            >
              {loading ? (
                <>
                  <IconLoader2 className="mr-2 size-4 animate-spin" />
                  Checking in…
                </>
              ) : (
                "Yes, check me in"
              )}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={reset}
              disabled={loading}
            >
              That&apos;s not me
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ── Household Check-in ────────────────────────────────────────────────────
  // Only reachable when the Check-in form config enables Family check-in.
  // Households are otherwise formed at registration; the door reads an existing
  // Family and, on this step alone, may add to it (CCF-122).
  if (step === "household" && household) {
    const pending = household.members.filter((m) => !m.alreadyCheckedIn)
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-6">
          <div className="space-y-1 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">Anyone else with you?</h2>
            <p className="text-sm text-muted-foreground">
              We found {household.familyName}. Check in everyone who came along.
            </p>
          </div>

          <div className="space-y-2">
            {household.members.map((m) => {
              const selected = householdSelection.has(m.registrantId)
              return (
                <button
                  key={m.registrantId}
                  type="button"
                  disabled={m.alreadyCheckedIn}
                  onClick={() =>
                    setHouseholdSelection((prev) => {
                      const next = new Set(prev)
                      if (next.has(m.registrantId)) next.delete(m.registrantId)
                      else next.add(m.registrantId)
                      return next
                    })
                  }
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg border p-3 text-left text-sm transition-colors",
                    m.alreadyCheckedIn
                      ? "cursor-default border-border bg-muted/50 text-muted-foreground"
                      : selected
                        ? "border-primary bg-primary/5"
                        : "border-border bg-background hover:bg-muted"
                  )}
                >
                  <span className="min-w-0">
                    <span className="font-medium">
                      {m.nickname?.trim() || m.name}
                      {m.isSubject && (
                        <span className="ml-1 font-normal text-muted-foreground">(you)</span>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {FAMILY_ROLE_LABELS[m.role as FamilyRoleValue] ?? m.role}
                    </span>
                  </span>
                  {m.alreadyCheckedIn ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs">
                      <IconCheck className="size-3.5" /> Checked in
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full border",
                        selected ? "border-primary bg-primary text-primary-foreground" : "border-border"
                      )}
                    >
                      {selected && <IconCheck className="size-3.5" />}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {addingMember ? (
            <div className="space-y-3 rounded-lg border p-3">
              <p className="text-sm font-medium">Add someone</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="nm-first">First Name</Label>
                  <Input
                    id="nm-first"
                    value={newMember.firstName}
                    onChange={(e) =>
                      setNewMember((p) => ({ ...p, firstName: e.target.value }))
                    }
                    placeholder="Juan"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="nm-last">Last Name</Label>
                  <Input
                    id="nm-last"
                    value={newMember.lastName}
                    onChange={(e) => setNewMember((p) => ({ ...p, lastName: e.target.value }))}
                    placeholder="dela Cruz"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="nm-role">Relationship</Label>
                <Select
                  value={newMember.role}
                  onValueChange={(v) =>
                    setNewMember((p) => ({ ...p, role: v as FamilyRoleValue }))
                  }
                >
                  <SelectTrigger id="nm-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FAMILY_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {FAMILY_ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setAddingMember(false)
                    setError(null)
                  }}
                  disabled={loading}
                >
                  Cancel
                </Button>
                <Button className="flex-1" onClick={handleAddMember} disabled={loading}>
                  {loading ? (
                    <>
                      <IconLoader2 className="mr-2 size-4 animate-spin" />
                      Adding…
                    </>
                  ) : (
                    "Add & check in"
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setAddingMember(true)}
              disabled={loading}
            >
              + Add family member
            </Button>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex flex-col gap-3">
            <Button className="w-full" onClick={handleHouseholdCheckIn} disabled={loading}>
              {loading ? (
                <>
                  <IconLoader2 className="mr-2 size-4 animate-spin" />
                  Checking in…
                </>
              ) : householdSelection.size > 0 ? (
                `Check in ${householdSelection.size} ${householdSelection.size === 1 ? "person" : "people"}`
              ) : (
                "Continue"
              )}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={afterHousehold}
              disabled={loading}
            >
              {pending.length > 0 ? "Just me for now" : "Continue"}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ── Small Group Prompt ────────────────────────────────────────────────────
  if (step === "sg-prompt" && matched?.smallGroupPrompt) {
    const prompt = matched.smallGroupPrompt
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-6">
          <div className="space-y-1 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">One quick question</h2>
            <p className="text-sm text-muted-foreground">
              Are you interested in joining a DGroup?
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <Button
              className="w-full"
              onClick={() => {
                // Fire-and-forget: the request is admin bookkeeping, and making
                // someone at a kiosk wait on it (or blocking them if it fails)
                // would be worse than a missed row.
                void recordSmallGroupInterestAtCheckin(eventId, prompt.person)
                setStep("sg-profile")
              }}
            >
              Yes, I&apos;m interested
            </Button>
            {/* Offered to guests and members alike. A member's membership is
                still admin-owned — naming a leader raises a request for that
                leader to confirm, it does not place them. */}
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setStep("sg-leader-search")}
            >
              I&apos;m already in one
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={goToSuccess}
            >
              Not right now
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ── Small Group Profile Form ──────────────────────────────────────────────
  if (step === "sg-profile" && matched?.smallGroupPrompt) {
    return (
      <ProfileForm
        eventId={eventId}
        person={matched.smallGroupPrompt.person}
        existingProfile={matched.smallGroupPrompt.existingProfile}
        lifeStages={lifeStages}
        ageRanges={ageRanges}
        defaultLifeStageId={defaultLifeStageId}
        cfg={cfg}
        onSave={goToSuccess}
        onSkip={goToSuccess}
        onBack={() => setStep("sg-prompt")}
      />
    )
  }

  // ── Small Group Leader Search ─────────────────────────────────────────────
  const claimingPerson = matched?.smallGroupPrompt?.person
  if (step === "sg-leader-search" && claimingPerson) {
    return (
      <LeaderSearch
        eventId={eventId}
        person={claimingPerson}
        onSave={goToSuccess}
        onBack={() => setStep("sg-prompt")}
      />
    )
  }

  // ── Breakout Group ───────────────────────────────────────────────────────
  if (step === "breakout" && matched && breakoutChoices) {
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

          {error && <p className="text-sm text-destructive text-center">{error}</p>}

          <div className="flex flex-col gap-3">
            <Button
              className="w-full"
              onClick={handleBreakoutContinue}
              disabled={loading}
            >
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

  // ── Success ──────────────────────────────────────────────────────────────
  if (step === "success" && matched) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-6 text-center">
          <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-green-100">
            <IconCheck className="size-10 text-green-600" />
          </div>
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold tracking-tight">
              Welcome, {matched.nickname ?? matched.name.split(" ")[0]}!
            </h2>
            <p className="text-sm text-muted-foreground">You&apos;re checked in.</p>
          </div>
          {matched.breakoutGroupName && (
            <div className="mx-auto w-full max-w-xs rounded-xl border bg-muted/40 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Your group
              </p>
              <p className="mt-1 text-lg font-semibold tracking-tight">
                {matched.breakoutGroupName}
              </p>
            </div>
          )}
          <Button className="w-full" onClick={reset}>
            Check in someone else
          </Button>
        </div>
      </div>
    )
  }

  // ── Already checked in ───────────────────────────────────────────────────
  if (step === "already-in" && matched) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full space-y-6 text-center">
          <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-green-100">
            <IconCheck className="size-10 text-green-600" />
          </div>
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold tracking-tight">Already checked in</h2>
            <p className="text-sm text-muted-foreground">
              {matched.name} is already checked in for this session.
            </p>
          </div>
          <Button variant="outline" className="w-full" onClick={reset}>
            Done
          </Button>
        </div>
      </div>
    )
  }

  // ── Not found ────────────────────────────────────────────────────────────
  if (step === "not-found-prompt") {
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
              <span className="font-medium">{lookupLabel}</span>.{" "}
              {walkInHref
                ? "You can register now or try a different lookup."
                : WALK_IN_CLOSED_MESSAGE}
            </p>
          </div>
          <div className="flex flex-col gap-3">
            {walkInHref && (
              <Button className="w-full" asChild>
                <Link href={walkInHref}>Register now</Link>
              </Button>
            )}
            <Button
              variant={walkInHref ? "ghost" : "default"}
              className="w-full"
              onClick={reset}
            >
              Try again
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return null
}

// ── Profile Form Sub-component ────────────────────────────────────────────────
//
// The "Tell us about yourself" DGroup-matching screen. It appears only when ALL
// of the following hold, so it is skipped for anyone already accounted for:
//   1. The checked-in subject is a matched guest or member — including a member
//      checking in as a volunteer,
//   2. who is *not yet in a DGroup* — i.e. the lookup returned a `smallGroupPrompt`, and
//   3. who taps "Yes, I'm interested" on the preceding "Are you interested in
//      joining a DGroup?" prompt (`sg-prompt` step).
// Anyone already in a group, or already awaiting placement, never reaches this step.
//
// Fields mirror the public registration form (`registration-form.tsx`): shared
// MultiSelect for Language, Select for Meeting Preference / Life Stage / City —
// intentionally the same components so the two forms stay visually in sync.

/** The `*` on a required field's label — mirrors the registration form (CCF-142). */
function RequiredMark({ on }: { on: boolean }) {
  if (!on) return null
  return <span className="text-destructive">*</span>
}

type ProfileFormProps = {
  eventId: string
  person: CheckinPerson
  existingProfile: SmallGroupPrompt["existingProfile"]
  lifeStages: LifeStage[]
  ageRanges: AgeRangeBucket[]
  defaultLifeStageId?: string
  cfg: EventFormConfigData
  onSave: () => void
  onSkip: () => void
  onBack: () => void
}

function ProfileForm({ eventId, person, existingProfile, lifeStages, ageRanges, defaultLifeStageId = "", cfg, onSave, onSkip, onBack }: ProfileFormProps) {
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // This screen collects new personal data, so it needs the same consent the
  // public registration form takes before it writes anything (CCF-94).
  const [privacyAccepted, setPrivacyAccepted] = React.useState(false)
  const [form, setForm] = React.useState({
    lifeStageId: existingProfile.lifeStageId ?? defaultLifeStageId,
    ageRangeBucketId: existingProfile.ageRangeBucketId ?? "",
    gender: existingProfile.gender ?? "",
    language: existingProfile.language,
    meetingPreference: existingProfile.meetingPreference ?? "",
    workCity: existingProfile.workCity ?? "",
    scheduleDayOfWeek: existingProfile.scheduleDayOfWeek != null ? String(existingProfile.scheduleDayOfWeek) : "",
    scheduleTimeStart: existingProfile.scheduleTimeStart ?? "",
    scheduleTimeEnd: existingProfile.scheduleTimeEnd ?? "",
  })

  async function handleSave() {
    if (!privacyAccepted) {
      setError("Please agree to the CCF Privacy Policy to continue")
      return
    }
    setSaving(true)
    setError(null)
    // Every key below is sent, so a disabled field must pass through whatever the
    // person already had — sending null would wipe it. Form state is seeded from
    // `existingProfile`, so an unrendered field already holds the stored value.
    // The exception is lifeStageId, which is seeded from the event's ministry
    // default: when that field is off, fall back to the stored value so the
    // default can't be written behind the person's back.
    const data: MatchingProfileInput = {
      lifeStageId: cfg.fieldLifeStage
        ? form.lifeStageId || null
        : existingProfile.lifeStageId,
      ageRangeBucketId: cfg.fieldAgeRange
        ? form.ageRangeBucketId || null
        : existingProfile.ageRangeBucketId,
      gender: (form.gender || null) as "Male" | "Female" | null,
      language: form.language,
      meetingPreference: (form.meetingPreference || null) as "Online" | "Hybrid" | "InPerson" | null,
      workCity: form.workCity || null,
      scheduleDayOfWeek: form.scheduleDayOfWeek !== "" ? parseInt(form.scheduleDayOfWeek, 10) : null,
      scheduleTimeStart: form.scheduleTimeStart || null,
      scheduleTimeEnd: form.scheduleTimeEnd || null,
    }
    // The same check the server runs, so a required field fails while its input
    // is still on screen rather than as an error banner after the save.
    const missing = missingRequiredFields(cfg, data, fieldsForContext("CheckIn"))
    if (missing.length > 0) {
      setSaving(false)
      setError(requiredFieldsMessage(missing))
      return
    }
    const result = await saveCheckinMatchingProfile(eventId, person, data)
    setSaving(false)
    if (result.success) {
      onSave()
    } else {
      setError(result.error)
    }
  }

  return (
    <div className="flex flex-col px-6 py-8">
      <div className="w-full space-y-6">
        {/* Header matches the sibling check-in screens (sg-prompt, confirm) so the
            step-to-step transition doesn't change type scale or alignment. */}
        <div className="space-y-1 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">Tell us about yourself</h2>
          <p className="text-sm text-muted-foreground">
            {/* Can't promise "optional" any more — an admin can mark any of these
                required (CCF-142), and the required ones carry their own `*`. */}
            These details help us find the right DGroup for you.
          </p>
        </div>

        {/* space-y-4 + the same shared inputs as registration-form.tsx */}
        <div className="space-y-4">
          {/* Life Stage */}
          {cfg.fieldLifeStage && lifeStages.length > 0 && (
            <div className="space-y-2">
              <Label>
                Life Stage <RequiredMark on={cfg.fieldLifeStageRequired} />
              </Label>
              <Select
                value={form.lifeStageId}
                onValueChange={(v) => setForm((p) => ({ ...p, lifeStageId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select life stage" />
                </SelectTrigger>
                <SelectContent>
                  {/* No opt-out item (CCF-143). It read "No preference" here
                      rather than "Prefer not to say", but it was the same escape
                      hatch — and a life stage is a fact about someone, not a
                      preference. Unanswered is the placeholder state. */}
                  {lifeStages.map((ls) => (
                    <SelectItem key={ls.id} value={ls.id}>{ls.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Gender */}
          {cfg.fieldGender && (
          <div className="space-y-2">
            <Label>
              Gender <RequiredMark on={cfg.fieldGenderRequired} />
            </Label>
            <div className="flex gap-3">
              {["Male", "Female"].map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, gender: p.gender === g ? "" : g }))}
                  className={`flex-1 rounded-lg border py-2.5 text-sm font-medium transition-colors ${
                    form.gender === g
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-muted"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
          )}

          {/* Age Range — configurable buckets (CCF-123) */}
          {cfg.fieldAgeRange && ageRanges.length > 0 && (
          <div className="space-y-2">
            <Label htmlFor="ageRange">
              Age Range <RequiredMark on={cfg.fieldAgeRangeRequired} />
            </Label>
            <Select
              value={form.ageRangeBucketId}
              onValueChange={(v) => setForm((p) => ({ ...p, ageRangeBucketId: v }))}
            >
              <SelectTrigger id="ageRange">
                <SelectValue placeholder="Select age range" />
              </SelectTrigger>
              <SelectContent>
                {/* No opt-out item — see the Life Stage select above. */}
                {ageRanges.map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          )}

          {/* Language — shared MultiSelect, matching the registration & small-group forms */}
          {cfg.fieldLanguage && (
          <div className="space-y-2">
            <Label>
              Primary Language <RequiredMark on={cfg.fieldLanguageRequired} />
            </Label>
            <MultiSelect
              options={LANGUAGE_OPTIONS}
              value={form.language}
              onChange={(v) => setForm((p) => ({ ...p, language: v }))}
              placeholder="Select language(s)"
            />
          </div>
          )}

          {/* Meeting Preference */}
          {cfg.fieldMeetingPreference && (
          <div className="space-y-2">
            <Label>
              Meeting Preference <RequiredMark on={cfg.fieldMeetingPreferenceRequired} />
            </Label>
            <Select
              value={form.meetingPreference}
              onValueChange={(v) => setForm((p) => ({ ...p, meetingPreference: v === "none" ? "" : v }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select preference" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No preference</SelectItem>
                <SelectItem value="Online">Online</SelectItem>
                <SelectItem value="Hybrid">Hybrid</SelectItem>
                <SelectItem value="InPerson">In Person</SelectItem>
              </SelectContent>
            </Select>
          </div>
          )}

          {/* Schedule */}
          {cfg.fieldSchedule && (
          <div className="space-y-2">
            <Label>
              Best time to meet <RequiredMark on={cfg.fieldScheduleRequired} />
            </Label>
            <ScheduleInput
              allowAny
              dayOfWeek={form.scheduleDayOfWeek}
              timeStart={form.scheduleTimeStart}
              timeEnd={form.scheduleTimeEnd}
              onDayChange={(v) => setForm((p) => ({ ...p, scheduleDayOfWeek: v }))}
              onTimeStartChange={(v) => setForm((p) => ({ ...p, scheduleTimeStart: v }))}
              onTimeEndChange={(v) => setForm((p) => ({ ...p, scheduleTimeEnd: v }))}
            />
          </div>
          )}

          {/* City */}
          {cfg.fieldWorkCity && (
          <div className="space-y-2">
            <Label>
              Work / Home City <RequiredMark on={cfg.fieldWorkCityRequired} />
            </Label>
            <Select
              value={form.workCity}
              onValueChange={(v) => setForm((p) => ({ ...p, workCity: v === "_none" ? "" : v }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select city" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">No preference</SelectItem>
                {CITY_OPTIONS.map((city) => (
                  <SelectItem key={city} value={city}>{city}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          )}

          <PrivacyPolicyCheckbox
            checked={privacyAccepted}
            onCheckedChange={(v) => {
              setPrivacyAccepted(v)
              if (v) setError(null)
            }}
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-col gap-3 pt-2">
          <Button className="w-full" onClick={handleSave} disabled={saving || !privacyAccepted}>
            {saving ? <><IconLoader2 className="mr-2 size-4 animate-spin" />Saving…</> : "Save & Done"}
          </Button>
          <Button variant="ghost" className="w-full" onClick={onSkip} disabled={saving}>
            Skip for now
          </Button>
        </div>

        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <IconArrowLeft className="size-4" /> Back
        </button>
      </div>
    </div>
  )
}

// ── Leader Search Sub-component ───────────────────────────────────────────────

type LeaderSearchProps = {
  eventId: string
  /**
   * Guest or member — the action stores the answer differently for each (a
   * guest's `claimedSmallGroupId`, a member's Pending join request), but the
   * search and the picking are identical, so the screen doesn't care which.
   */
  person: CheckinPerson
  onSave: () => void
  onBack: () => void
}

function LeaderSearch({ eventId, person, onSave, onBack }: LeaderSearchProps) {
  const [query, setQuery] = React.useState("")
  const [results, setResults] = React.useState<LeaderResult[]>([])
  const [searching, setSearching] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleQueryChange(value: string) {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      if (value.trim().length < 2) {
        setResults([])
        return
      }
      setSearching(true)
      const res = await searchMembersForLeaderLookup(value.trim())
      setSearching(false)
      if (res.success) {
        setResults(res.data)
      }
    }, 300)
  }

  async function handleSelectGroup(smallGroupId: string) {
    setSaving(true)
    setError(null)
    const res = await saveCheckinClaimedGroup(eventId, person, smallGroupId)
    setSaving(false)
    if (res.success) {
      onSave()
    } else {
      setError(res.error)
    }
  }

  React.useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  return (
    <div className="flex flex-col px-6 py-8">
      <div className="w-full space-y-6">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Find your leader</h2>
          <p className="text-sm text-muted-foreground">
            Search by your DGroup leader&apos;s name.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="leader-search">Leader&apos;s name</Label>
          <Input
            id="leader-search"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="e.g. Juan dela Cruz"
            autoComplete="off"
          />
        </div>

        {searching && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <IconLoader2 className="size-4 animate-spin" />
            Searching…
          </div>
        )}

        {!searching && results.length > 0 && (
          <div className="space-y-2">
            {results.map((member) =>
              member.ledGroups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  disabled={saving}
                  onClick={() => handleSelectGroup(group.id)}
                  className="w-full rounded-lg border bg-background px-4 py-3 text-left hover:bg-muted disabled:opacity-50"
                >
                  <p className="text-sm font-medium">{group.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Led by {member.firstName} {member.lastName}
                  </p>
                </button>
              ))
            )}
          </div>
        )}

        {!searching && query.trim().length >= 2 && results.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No leaders found for &ldquo;{query}&rdquo;.
          </p>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <IconArrowLeft className="size-4" /> Back
        </button>
      </div>
    </div>
  )
}
