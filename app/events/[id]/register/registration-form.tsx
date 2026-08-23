"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { IconCheck } from "@tabler/icons-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { useKioskRefresh } from "@/lib/hooks/use-kiosk-refresh"
import {
  BARE_EVENT_FORM_CONFIG,
  formLayoutFor,
  isRequirableSection,
  parentSectionFor,
  resolveSuccessMessage,
  type EventFormConfigData,
  type FormFieldKey,
  type FormSectionKey,
  type RequirableKey,
} from "@/lib/forms/context-config"
import {
  askedFieldsFor,
  missingRequiredFields,
  requiredFieldLabels,
  requiredFieldsMessage,
} from "@/lib/forms/registration-payload"
import type { FormContext } from "@/app/generated/prisma/client"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScheduleInput } from "@/components/ui/schedule-input"
import { Label } from "@/components/ui/label"
import { MultiSelect } from "@/components/ui/multi-select"
import { OptionalEmailInput } from "@/components/ui/optional-email-input"
import { OptionalPhonePHInput } from "@/components/ui/optional-phone-ph-input"
import { PhonePHInput } from "@/components/ui/phone-ph-input"
import { BirthMonthYearInput } from "@/components/ui/birth-month-year-input"
import { PrivacyPolicyCheckbox } from "@/components/ui/privacy-policy-checkbox"
import { PersonCombobox } from "@/components/ui/person-combobox"
import { EXTERNAL_SATELLITES_BY_REGION } from "@/lib/constants/ccf-satellites"
import { birthYearMessage, isValidBirthYear } from "@/lib/validations/birth-date"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  createRegistrant,
  createHouseholdRegistration,
  lookupMemberForRegistration,
} from "@/app/(dashboard)/events/actions"
import {
  lookupProfileByMobile,
  revealProfileForRegistration,
  type MaskedProfileCandidate,
} from "@/app/(dashboard)/events/registration-lookup-actions"
import {
  fieldsStillNeeded,
  mergedAnswersFor,
  prefillFromProfile,
  profileSummaryRows,
  type RegistrationProfileSnapshot,
} from "@/lib/forms/profile-prefill"
import type { AssignedBreakout } from "@/lib/events/registration-core"
import {
  registerForCluster,
  type ClusterEventRegistrationResult,
} from "@/app/(dashboard)/events/cluster-actions"
import { searchMembersForLeaderLookup } from "@/app/(dashboard)/guests/actions"
import { clampFormStep } from "@/lib/forms/step-navigation"
import { LANGUAGE_OPTIONS, CITY_OPTIONS } from "@/lib/constants/group-options"
import { FAMILY_ROLES, FAMILY_ROLE_LABELS, type FamilyRoleValue } from "@/lib/validations/family"
import {
  MAX_HOUSEHOLD_MEMBERS,
  defaultHouseholdMember,
  type HouseholdFormMember,
} from "@/lib/validations/household"
import {
  suggestBreakoutGroup,
  breakoutPickerOptions,
  type BreakoutCandidate,
  type BreakoutNoticeKind,
} from "@/lib/breakout-suggestion"
import { BreakoutPicker } from "@/components/breakouts/breakout-picker"
import { MINISTRY_REQUIRED_ERROR } from "@/lib/clusters/copy"
import { MinistryAvatar } from "@/components/ministry-avatar"

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]
const MEETING_FORMAT_LABEL: Record<"Online" | "Hybrid" | "InPerson", string> = {
  Online: "Online",
  Hybrid: "Hybrid",
  InPerson: "In Person",
}

function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return time
  const period = h >= 12 ? "PM" : "AM"
  const display = h % 12 || 12
  return `${display}:${m.toString().padStart(2, "0")} ${period}`
}

/**
 * `identify*` are the CCF-147 step-0 gate, which runs *before* the form. The
 * review screen is deliberately not a step of its own: accepting a match lands
 * on `"form"` with a profile attached, so the shortened flow inherits every
 * downstream step (cluster events, DGroup, breakout, dietary, payment, privacy)
 * instead of forking a second copy of them that could drift.
 */
type Step =
  | "identify"
  | "identify-confirm"
  | "identify-ambiguous"
  | "form"
  | "confirm"
  | "disambiguate"
  | "early-confirm"
  | "early-disambiguate"
  | "done"
  | "volunteer-blocked"
  | "already-registered"

type LifeStage = { id: string; name: string }
type AgeRangeBucket = { id: string; label: string }

type DietaryValue =
  | ""
  | "Vegetarian"
  | "Vegan"
  | "Halal"
  | "Kosher"
  | "GlutenFree"
  | "DairyFree"
  | "NutFree"
  | "Pescatarian"
  | "Other"

type FormValues = {
  firstName: string
  lastName: string
  nickname: string
  email: string
  mobileNumber: string
  birthMonth: string
  birthYear: string
  ageRangeBucketId: string
  lifeStageId: string
  gender: string
  language: string[]
  meetingPreference: string
  workCity: string
  scheduleDayOfWeek: string
  scheduleTimeStart: string
  scheduleTimeEnd: string
  dietaryPreference: DietaryValue
  dietaryOther: string
  paymentReference: string
}

type MatchedMember = {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  matchedBy: "mobile" | "email" | "nameBirthday"
  recordType: "member" | "guest"
  isVolunteer?: boolean
  // Member-only extended fields (present when recordType === "member" and early lookup was used)
  smallGroupId?: string | null
  groupStatus?: string | null
  lifeStageId?: string | null
  language?: string[]
  meetingPreference?: string | null
  workCity?: string | null
  schedulePreferences?: { dayOfWeek: number; timeStart: string }[]
}

type AmbiguousCandidate = {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  recordType: "member" | "guest"
  isVolunteer?: boolean
  smallGroupId?: string | null
  groupStatus?: string | null
  lifeStageId?: string | null
  language?: string[]
  meetingPreference?: string | null
  workCity?: string | null
  schedulePreferences?: { dayOfWeek: number; timeStart: string }[]
}

const defaultForm: FormValues = {
  firstName: "",
  lastName: "",
  nickname: "",
  email: "",
  mobileNumber: "",
  birthMonth: "",
  birthYear: "",
  ageRangeBucketId: "",
  lifeStageId: "",
  gender: "",
  language: [],
  meetingPreference: "",
  workCity: "",
  scheduleDayOfWeek: "",
  scheduleTimeStart: "",
  scheduleTimeEnd: "",
  dietaryPreference: "",
  dietaryOther: "",
  paymentReference: "",
}

const DIETARY_OPTIONS: { value: Exclude<DietaryValue, "">; label: string }[] = [
  { value: "Vegetarian", label: "Vegetarian" },
  { value: "Vegan", label: "Vegan" },
  { value: "Halal", label: "Halal" },
  { value: "Kosher", label: "Kosher" },
  { value: "GlutenFree", label: "Gluten-Free" },
  { value: "DairyFree", label: "Dairy-Free" },
  { value: "NutFree", label: "Nut-Free" },
  { value: "Pescatarian", label: "Pescatarian" },
  { value: "Other", label: "Other" },
]


// Walk-in mode (check-in kiosk): the check-in board sends people here when a
// lookup finds no registration, so the registration page itself is the single
// source of truth for the form. Same steps as public registration — the person
// is registered via createRegistrant(..., walkIn) and checked in immediately.
type WalkInConfig = {
  occurrenceId: string | null
  prefill: {
    mobileNumber?: string
    email?: string
    firstName?: string
    lastName?: string
    birthMonth?: string
    birthYear?: string
  }
  /**
   * Where "Back" / "Done" returns to — the check-in board this walk-in came from.
   * Always a public route: the door is reachable without a session, so pointing it
   * at an admin screen bounces whoever is standing at it to /login. Omitted when
   * there is no public board to return to, and the way back is simply not offered.
   */
  backHref?: string
}

// Cluster mode (CCF-132): the shared "Event Day" form. Identity + profile are
// collected once and submission fans out one registration per event.
//
// What the middle step asks depends on the day's kind (CCF-148). Either way it is
// exactly one step, and both send back event ids — the difference is the question:
//  - `Parallel` — several events sharing a day. "Which are you joining?", any number.
//  - `Collab` — two ministries co-running ONE event. "Which ministry are you part
//    of?", exactly one. Nobody attending a collab thinks of it as two events, but
//    they do know which ministry they belong to, and that answer is what routes the
//    registration to that ministry's event.
//
// `ministry` is null when the event has no single ministry — a misconfigured day
// the Settings guard should have caught. The step falls back to the event's own
// name there rather than dead-ending someone at the door.
type ClusterConfig = {
  token: string
  kind: "Parallel" | "Collab"
  name: string
  events: {
    id: string
    name: string
    meta?: string | null
    ministry?: { id: string; name: string; logoUrl: string | null } | null
  }[]
}

type Props = {
  eventId?: string
  eventName?: string
  /**
   * Which sections and fields this context collects (CCF-119/120). Omitted →
   * bare: only the mandatory identity fields.
   */
  config?: Partial<EventFormConfigData>
  /**
   * Admin-configured success screen sub copy (CCF-130). Null/omitted falls back
   * to the built-in default for this context.
   */
  successMessage?: string | null
  lifeStages?: LifeStage[]
  /** Configurable age brackets (CCF-123), shown when the Age Range field is on. */
  ageRanges?: AgeRangeBucket[]
  defaultLifeStageId?: string
  breakoutCandidates?: BreakoutCandidate[]
  /**
   * Why the breakout list is empty, when that is worth saying out loud. The step
   * renders with an explanation instead of disappearing — see `BreakoutNotice`.
   */
  breakoutNotice?: BreakoutNoticeKind | null
  // "plain" drops the Card chrome so the form can be embedded inside another
  // container (e.g. the check-in board's card).
  frame?: "card" | "plain"
  walkIn?: WalkInConfig
  /** Cluster shared form — exactly one of eventId / cluster is provided. */
  cluster?: ClusterConfig
}

// Card wrapper that can render chrome-less for embedding. Defined at module
// level so its identity is stable across renders (inputs keep focus).
function FormShell({
  plain,
  className,
  ...props
}: React.ComponentProps<typeof Card> & { plain?: boolean }) {
  if (plain) {
    return <div className={cn("flex flex-col gap-6 py-6", className)} {...props} />
  }
  return <Card className={className} {...props} />
}

/**
 * The `*` next to a required field's label (CCF-142), matching how First and
 * Last Name have always marked themselves. Renders nothing when the field is
 * optional, so an all-optional form looks exactly as it did before.
 */
function RequiredMark({ on }: { on: boolean }) {
  if (!on) return null
  return <span className="text-destructive">*</span>
}

/**
 * What a finished submission offers next.
 *
 * The door is a queue: the staffer who just registered a walk-in has the next one
 * standing in front of them. Sending them back to the check-in board — the only
 * thing this screen used to offer — meant re-opening the form for every single
 * person, so a blank form is the primary action here, exactly as it is on the
 * public form. The way back is still on screen, one rung quieter, for the end of
 * the queue.
 */
/**
 * Which of this form's steps a field is rendered in.
 *
 * `parentSectionFor` answers in the config's vocabulary (`sectionSmallGroup`),
 * while the step list uses short keys. This is the single place the two meet, and
 * it is derived from the layout rather than restating it — move a field between
 * sections in `formLayoutFor` and amend mode follows it without another edit.
 */
const STEP_KEY_BY_SECTION: Record<FormSectionKey, string> = {
  sectionSmallGroup: "smallgroup",
  sectionBreakout: "breakout",
  sectionFamily: "household",
  sectionDietary: "dietary",
  sectionPayment: "payment",
}

function stepKeyForField(key: RequirableKey, context: FormContext): string {
  // A requirable section names its own step; a field names the step it sits in.
  if (isRequirableSection(key)) return STEP_KEY_BY_SECTION[key]
  const parent = parentSectionFor(key, context)
  return parent ? STEP_KEY_BY_SECTION[parent] : "personal"
}

function DoneActions({
  walkIn,
  onReset,
  variant,
}: {
  walkIn?: WalkInConfig
  onReset: () => void
  variant?: React.ComponentProps<typeof Button>["variant"]
}) {
  return (
    <div className="w-full space-y-2">
      <Button className="w-full" variant={variant} onClick={onReset}>
        {walkIn ? "Register another walk-in" : "Register another person"}
      </Button>
      {walkIn?.backHref && (
        <Button className="w-full" variant="ghost" asChild>
          <Link href={walkIn.backHref}>Back to check-in</Link>
        </Button>
      )}
    </div>
  )
}

export function RegistrationForm({
  eventId,
  eventName = "",
  config,
  successMessage = null,
  lifeStages = [],
  ageRanges = [],
  defaultLifeStageId = "",
  breakoutCandidates = [],
  breakoutNotice = null,
  frame = "card",
  walkIn,
  cluster,
}: Props) {
  const plain = frame === "plain"
  const cfg = React.useMemo<EventFormConfigData>(
    () => ({ ...BARE_EVENT_FORM_CONFIG, ...config }),
    [config]
  )
  const formContext: FormContext = walkIn ? "WalkIn" : "Register"
  const includeSmallGroup = cfg.sectionSmallGroup
  const includeDietary = cfg.sectionDietary
  const includePayment = cfg.sectionPayment
  /**
   * Whether the "Help us connect you" block has anything to show. Every field
   * under that heading is individually toggleable, so with all four off the
   * heading promised optional details and then rendered nothing under itself.
   */
  const hasMatchingFields =
    cfg.fieldLanguage || cfg.fieldMeetingPreference || cfg.fieldSchedule || cfg.fieldWorkCity
  /**
   * The mobile-first gate only makes sense on a form that collects a mobile
   * number. With the field off there is nothing to look anyone up by, so the
   * form opens exactly where it always did.
   */
  const identifyFirst = cfg.fieldMobile
  const [step, setStep] = React.useState<Step>(identifyFirst ? "identify" : "form")
  const router = useRouter()

  /**
   * A door tablet waiting for the next person.
   *
   * Only the walk-in surface polls. The public form is opened by one registrant
   * who fills it in and leaves, so there is no window for its data to age in —
   * whereas the door is opened once and left running, and its candidate list is
   * gated on which facilitators have checked in, which is *designed* to change
   * through the morning. See `useKioskRefresh`.
   *
   * The identify gate ONLY, and not `"form"` even though a door configured
   * without a mobile field rests there. `config` decides which sections render,
   * so a refresh landing on `"form"` would rearrange the questions under someone
   * already answering them — and on such a door there is no screen that means
   * "nobody is here yet". Those doors still refresh between people, in
   * `handleReset`; they just don't poll.
   */
  useKioskRefresh(!!walkIn && step === "identify")
  const [form, setForm] = React.useState<FormValues>({
    ...defaultForm,
    lifeStageId: defaultLifeStageId,
    // Walk-in mode: seed from the failed check-in lookup. Fields stay editable —
    // the person may be fixing the typo that caused the miss.
    mobileNumber: walkIn?.prefill.mobileNumber ?? "",
    email: walkIn?.prefill.email ?? "",
    firstName: walkIn?.prefill.firstName ?? "",
    lastName: walkIn?.prefill.lastName ?? "",
    birthMonth: walkIn?.prefill.birthMonth ?? "",
    birthYear: walkIn?.prefill.birthYear ?? "",
  })
  // A field this form doesn't collect starts out as "they don't have one", so the
  // member-lookup branches below (which read `!noMobile && form.mobileNumber`)
  // degrade to the identifier that *is* being asked for, rather than looking up
  // against a value nobody was given the chance to enter.
  const [noMobile, setNoMobile] = React.useState(!cfg.fieldMobile)
  const [noEmail, setNoEmail] = React.useState(!cfg.fieldEmail)
  const [smallGroupIntent, setSmallGroupIntent] = React.useState<null | "wants" | "already_in">(null)
  const [claimedSmallGroupId, setClaimedSmallGroupId] = React.useState("")
  // "…and my DGroup is at another CCF satellite" — swaps the leader search for a
  // satellite picker, since there's no local group to find.
  const [claimedElsewhere, setClaimedElsewhere] = React.useState(false)
  const [claimedSatellite, setClaimedSatellite] = React.useState("")
  const [claimedGroupQuery, setClaimedGroupQuery] = React.useState("")
  const [claimedGroupResults, setClaimedGroupResults] = React.useState<Array<{ id: string; name: string; leaderName: string }>>([])
  const [claimedGroupSearching, setClaimedGroupSearching] = React.useState(false)
  const claimedGroupDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Monotonic id so only the newest leader lookup is allowed to set state. */
  const claimedGroupRequestRef = React.useRef(0)
  const satelliteOptions = React.useMemo(
    () =>
      EXTERNAL_SATELLITES_BY_REGION.flatMap(({ region, satellites }) =>
        satellites.map((name) => ({ value: name, label: name, hint: region }))
      ),
    []
  )
  const [submitting, setSubmitting] = React.useState(false)
  // ── Step 0: pull an existing profile by mobile number (CCF-147) ────────────
  const [identifyMatch, setIdentifyMatch] = React.useState<MaskedProfileCandidate | null>(null)
  const [identifyCandidates, setIdentifyCandidates] = React.useState<MaskedProfileCandidate[] | null>(null)
  const [secondFactorMonth, setSecondFactorMonth] = React.useState("")
  const [secondFactorYear, setSecondFactorYear] = React.useState("")
  const [identifyError, setIdentifyError] = React.useState<string | null>(null)
  /** The profile the person confirmed. Non-null turns step 1 into the review screen. */
  const [profileSnapshot, setProfileSnapshot] = React.useState<RegistrationProfileSnapshot | null>(null)
  /**
   * Proof of ownership from the step-0 reveal, carried to submit so an edit to a
   * field that already has a value is honoured rather than quietly ignored.
   * Opaque to the client — it is minted and checked server-side.
   */
  const [identityGrant, setIdentityGrant] = React.useState<string | null>(null)
  /**
   * What the form still has to ask a person who is already registered, because the
   * admin enabled or required a field after they signed up. Empty means the
   * already-registered screen is a plain dead end; non-empty turns it into a
   * two-question detour. Null once amend mode is running on everything (the
   * "Update my details" opt-in), which is the whole non-payment form.
   */
  const [amendFields, setAmendFields] = React.useState<RequirableKey[]>([])
  /**
   * Whether this run of the form is amending an existing registration rather than
   * creating one, and how much of it to show.
   *
   * `"needed"` narrows to the steps that hold `amendFields` — the person is here
   * because the admin required something new, so making them walk the whole form
   * again would be the very thing this change set out to stop. `"all"` is the
   * voluntary "Update my details" path, where they came back to change something
   * and we don't know what.
   */
  const [amending, setAmending] = React.useState<"needed" | "all" | null>(null)
  const [editingProfile, setEditingProfile] = React.useState(false)
  /**
   * Payload keys the person edited on the review screen. Only these overwrite the
   * stored profile server-side — everything else keeps fill-if-empty, so a value
   * they merely looked at is never rewritten. See `lib/events/profile-merge.ts`.
   */
  const [touchedFields, setTouchedFields] = React.useState<string[]>([])
  /**
   * The record the person said "not me" to. Kept so neither the later lookups nor
   * the server-side dedup ladder can put them back on it.
   */
  const [rejectedRecordId, setRejectedRecordId] = React.useState<string | null>(null)
  const [matchedMember, setMatchedMember] = React.useState<MatchedMember | null>(null)
  const [confirmedMember, setConfirmedMember] = React.useState<MatchedMember | null>(null)
  const [skipSmallGroup, setSkipSmallGroup] = React.useState(false)
  const [candidates, setCandidates] = React.useState<{
    matchedBy: "mobile" | "email"
    items: AmbiguousCandidate[]
  } | null>(null)
  // Read `selectedBreakoutId` (derived below), not this — a group can stop being
  // offered after the fact, when the registrant goes back and changes gender.
  const [rawSelectedBreakoutId, setSelectedBreakoutId] = React.useState<string>("")
  const [assignedBreakout, setAssignedBreakout] = React.useState<AssignedBreakout | null>(null)
  // Cluster mode: which of the day's events the person is attending — from the
  // Events tickboxes on a Parallel day, or the single ministry choice on a Collab
  // one. Plus the per-event outcomes shown on the success screen (partial success).
  //
  // Deliberately NOT seeded from props for a Collab. It briefly was, which made it
  // derived data living in state: `handleReset` clears it and the lazy initializer
  // never runs again, so any reset left the form permanently unsubmittable against
  // a guard for a question it no longer asked. It is a real answer now.
  const [selectedEventIds, setSelectedEventIds] = React.useState<string[]>([])
  const [clusterResults, setClusterResults] = React.useState<ClusterEventRegistrationResult[] | null>(null)
  const [formStep, setFormStep] = React.useState(1)
  const [privacyAccepted, setPrivacyAccepted] = React.useState(false)
  const [primaryRole, setPrimaryRole] = React.useState<FamilyRoleValue>("FatherHusband")
  const [householdMembers, setHouseholdMembers] = React.useState<HouseholdFormMember[]>([])

  // Spouse-only mode keeps a single slot in `householdMembers` so the submit
  // path is identical to full-household mode. The spouse's role is the opposite
  // half of the couple rather than something the person picks.
  const spouseRole: FamilyRoleValue =
    primaryRole === "FatherHusband" ? "MotherWife" : "FatherHusband"
  const spouse = householdMembers[0] ?? defaultHouseholdMember
  function setSpouseField(field: keyof HouseholdFormMember, value: string) {
    setHouseholdMembers((prev) => {
      const current = prev[0] ?? { ...defaultHouseholdMember }
      return [{ ...current, [field]: value, role: spouseRole }]
    })
  }
  const cardRef = React.useRef<HTMLDivElement>(null)

  // A notice keeps the step on screen with nothing to pick. Silently dropping it
  // is what made the walk-in form look broken: the admin had switched Breakout
  // on, and the step still wasn't there.
  const hasBreakoutChoices = breakoutCandidates.length > 0
  const showBreakoutSection = hasBreakoutChoices || breakoutNotice !== null

  const suggestedBreakout = React.useMemo(() => {
    if (!hasBreakoutChoices) return null
    return suggestBreakoutGroup(breakoutCandidates, {
      gender: (form.gender || null) as "Male" | "Female" | null,
      birthYear: form.birthYear ? parseInt(form.birthYear, 10) : null,
      lifeStageId: form.lifeStageId || null,
    })
  }, [breakoutCandidates, form.gender, form.birthYear, form.lifeStageId, hasBreakoutChoices])

  // Filtered by gender and life stage once they're known — a men's group is not
  // something a woman can join, so listing it is a dead end. With either blank
  // (or not asked at all) that criterion filters nothing; see
  // `breakoutPickerOptions`. Ordered emptiest-first by the same rule that picks
  // the suggestion above, so the two can't disagree about which group has room.
  const browsableCandidates = React.useMemo(
    () =>
      breakoutPickerOptions(breakoutCandidates, {
        gender: (form.gender || null) as "Male" | "Female" | null,
        lifeStageId: form.lifeStageId || null,
      }),
    [breakoutCandidates, form.gender, form.lifeStageId]
  )

  // Going back and changing gender must not leave a now-hidden group selected —
  // it would still be submitted, and the registrant would have no way to see or
  // undo it. Derived rather than reset in an effect so there is never a render
  // where the stale id is live.
  const selectedBreakoutId = browsableCandidates.some((g) => g.id === rawSelectedBreakoutId)
    ? rawSelectedBreakoutId
    : ""

  // Occupancy travels only to staffed surfaces, so its presence — not the
  // `walkIn` prop — is what decides whether headcounts render and whether a full
  // group can be chosen anyway. The page that fetched the data made that call,
  // and `BreakoutPicker` reads it off the candidates rather than being told.

  React.useEffect(() => {
    return () => {
      if (claimedGroupDebounceRef.current) clearTimeout(claimedGroupDebounceRef.current)
      // Any reply still in flight belongs to a form that no longer exists.
      claimedGroupRequestRef.current += 1
    }
  }, [])

  function handleClaimedGroupQueryChange(value: string) {
    setClaimedGroupQuery(value)
    setClaimedSmallGroupId("")
    if (claimedGroupDebounceRef.current) clearTimeout(claimedGroupDebounceRef.current)
    // Debouncing alone doesn't order the replies: a slow lookup for an earlier
    // query can land after a fast one for the current query and overwrite it —
    // or clear the spinner the newer request is still using, which is what left
    // the step sitting on "Searching…" with results that didn't match the box.
    const requestId = (claimedGroupRequestRef.current += 1)
    claimedGroupDebounceRef.current = setTimeout(async () => {
      if (value.trim().length < 2) {
        setClaimedGroupResults([])
        return
      }
      setClaimedGroupSearching(true)
      const res = await searchMembersForLeaderLookup(value.trim())
      if (claimedGroupRequestRef.current !== requestId) return
      setClaimedGroupSearching(false)
      if (res.success) {
        setClaimedGroupResults(
          res.data.flatMap((m) =>
            m.ledGroups.map((g) => ({
              id: g.id,
              name: g.name,
              leaderName: `${m.firstName} ${m.lastName}`,
            }))
          )
        )
      }
    }, 300)
  }

  const allSections: { key: string; title: string }[] = [
    { key: "personal", title: "Personal Information" },
    ...(cluster
      ? cluster.kind === "Collab"
        ? [{ key: "ministry", title: "Your Ministry" }]
        : [{ key: "events", title: "Events" }]
      : []),
    ...(includeSmallGroup && !skipSmallGroup ? [{ key: "smallgroup", title: "DGroup Info" }] : []),
    ...(showBreakoutSection ? [{ key: "breakout", title: "Breakout Group" }] : []),
    ...(cfg.sectionFamily ? [{ key: "household", title: "Your Household" }] : []),
    ...(includeDietary ? [{ key: "dietary", title: "Dietary Preferences" }] : []),
    ...(includePayment ? [{ key: "payment", title: "Payment" }] : []),
  ]

  /**
   * Amending shows less of the form than registering does.
   *
   * Payment comes off both amend paths: this is a public form re-opening a
   * registration that already exists, and letting it rewrite a payment reference
   * is a different decision from letting it fill in a life stage. Payment stays
   * with the admin.
   *
   * `"needed"` narrows further, to just the steps holding the fields the event has
   * started demanding. Which step a field belongs to comes from `parentSectionFor`
   * — the layout stays the only thing that knows — rather than a second map here
   * that would drift the first time a field moves between steps.
   */
  const sections = React.useMemo(() => {
    if (!amending) return allSections
    const withoutPayment = allSections.filter((s) => s.key !== "payment")
    if (amending === "all") return withoutPayment

    const wanted = new Set(amendFields.map((f) => stepKeyForField(f, formContext)))
    const narrowed = withoutPayment.filter((s) => wanted.has(s.key))
    // A field whose step isn't on this form leaves nothing to show. Falling back
    // to Personal Information keeps the person on a real screen instead of an
    // empty one they can't get past.
    return narrowed.length > 0 ? narrowed : withoutPayment.slice(0, 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amending, amendFields, formContext, JSON.stringify(allSections)])
  /**
   * The stepped layout is the form's only layout. It used to switch to a
   * single-card design whenever `sections.length` fell to 1, which made the
   * layout a function of how many sections the admin happened to leave on —
   * an event with only Personal Information got one design, an event with
   * Dietary as well got another, and the same person could meet either. One
   * chrome also means a section can only ever render as the step it belongs to,
   * so a step dropped from `sections` can't leak back in inline.
   *
   * A handful of *behavioural* branches (not layout) still key off the form
   * being a single screen — validation that would otherwise live in `handleNext`,
   * and the native `required` attribute. Those use this instead.
   */
  const singleSection = sections.length === 1
  // `sections` is derived from config *and* from answers given along the way, so it
  // can shrink under the step we're standing on — confirming as a member who already
  // has a DGroup drops that step. Every read goes through the clamp, and the
  // navigation handlers below step relative to it, so a stale `formStep` heals on
  // the next move instead of throwing mid-render.
  const safeStep = clampFormStep(formStep, sections.length)
  const currentSectionKey = sections[safeStep - 1].key

  /** Whether this form actually asks the cluster's question — see the submit guard. */
  const clusterStepShown = sections.some(
    (sec) => sec.key === "events" || sec.key === "ministry"
  )

  /**
   * The current answers keyed the way the payload is, so the client can run the
   * same `missingRequiredFields` the server does instead of a parallel list of
   * checks that would drift from it.
   *
   * `noMobile`/`noEmail` collapse to empty here: someone who has ticked "I don't
   * have one" has not answered, whatever is still sitting in state.
   */
  const answers = React.useMemo(
    () => ({
      nickname: form.nickname,
      mobileNumber: noMobile ? "" : form.mobileNumber,
      email: noEmail ? "" : form.email,
      lifeStageId: form.lifeStageId,
      birthMonth: form.birthMonth,
      birthYear: form.birthYear,
      ageRangeBucketId: form.ageRangeBucketId,
      gender: form.gender,
      language: form.language,
      meetingPreference: form.meetingPreference,
      workCity: form.workCity,
      scheduleDayOfWeek: form.scheduleDayOfWeek,
      wantsSmallGroup: smallGroupIntent === "wants",
    }),
    [form, noMobile, noEmail, smallGroupIntent]
  )

  /**
   * What the fast path still has to ask.
   *
   * The profile is merged *under* the typed answers and handed to the same
   * `missingRequiredFields` the server runs — so the skip keys off profile nulls,
   * not off "we already showed them a screen". A Required field the profile can't
   * satisfy is still Required.
   */
  const stillNeeded = React.useMemo(
    () =>
      profileSnapshot
        ? fieldsStillNeeded(cfg, formContext, mergedAnswersFor(profileSnapshot, answers))
        : [],
    [profileSnapshot, cfg, formContext, answers]
  )

  /**
   * Whether a Personal Information field renders as an input.
   *
   * With no profile, or once they've asked to edit, the section is its normal
   * self. On the review screen it collapses to the summary card plus only the
   * questions the profile genuinely couldn't answer.
   */
  function showPersonalField(field: FormFieldKey): boolean {
    if (!cfg[field]) return false
    if (!profileSnapshot || editingProfile) return true
    return stillNeeded.includes(field)
  }

  /**
   * The subset of `stillNeeded` that actually renders on this screen. The DGroup
   * step owns the rest, and promising "a couple more things" for questions that
   * live two steps away would be a lie.
   */
  const stillNeededHere = React.useMemo(() => {
    const personal = formLayoutFor(formContext).find((sec) => sec.key === "personal")
    // A requirable section is a step of its own, never a row on this one.
    return stillNeeded.filter(
      (key) => !isRequirableSection(key) && personal?.fields.includes(key)
    )
  }, [stillNeeded, formContext])

  /** Name has no toggle — it is always collected — so it needs its own gate. */
  const showNameFields = !profileSnapshot || editingProfile

  /** Step 0 answered the "who is this?" question, either way. */
  const identityResolved = profileSnapshot !== null || rejectedRecordId !== null

  /** Required answers left blank in one step, in the order they're rendered. */
  function missingInSection(stepKey: string): RequirableKey[] {
    // Dietary and Payment are requirable *sections*: the section is itself the
    // answer, so it checks itself rather than a list of fields nested under it.
    if (stepKey === "dietary") return missingRequiredFields(cfg, answers, ["sectionDietary"])
    if (stepKey === "payment") return missingRequiredFields(cfg, answers, ["sectionPayment"])

    const layoutKey = stepKey === "personal" ? "personal" : "sectionSmallGroup"
    if (stepKey !== "personal" && stepKey !== "smallgroup") return []
    const section = formLayoutFor(formContext).find((s) => s.key === layoutKey)
    if (!section) return []
    return missingRequiredFields(
      cfg,
      answers,
      section.fields.filter((f) => askedFieldsFor(formContext, answers).includes(f))
    )
  }

  // Scrolling in the same tick as `setFormStep` measured the *outgoing* step's
  // geometry and then smooth-scrolled against a document whose height changed
  // underneath the animation. Do it after the commit instead — and never on first
  // paint, so the page doesn't scroll itself on load.
  const didMountRef = React.useRef(false)
  React.useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [formStep])

  function handleReset() {
    /**
     * Re-read the server's data for the next person.
     *
     * Everything below resets CLIENT state; this is the other half. The breakout
     * candidates, their counts and the form's own config arrive as props from a
     * server render, so without this the second walk-in of the morning is offered
     * the tables — and the headcounts — as they stood when the tablet was first
     * opened. `router.refresh()` re-runs the server component and leaves the
     * state reset below alone.
     */
    router.refresh()
    // Back to the gate, not to the form: the walk-in kiosk resets between
    // people, and leaving a resolved profile behind would register the next
    // person at the door as the previous one.
    setStep(identifyFirst ? "identify" : "form")
    setIdentifyMatch(null)
    setIdentifyCandidates(null)
    setSecondFactorMonth("")
    setSecondFactorYear("")
    setIdentifyError(null)
    setProfileSnapshot(null)
    setIdentityGrant(null)
    // Amend belongs to the registration it was opened for. Carrying it into the
    // next person at a walk-in door would file their answers onto someone else's.
    setAmending(null)
    setAmendFields([])
    setEditingProfile(false)
    setTouchedFields([])
    setRejectedRecordId(null)
    setForm({ ...defaultForm, lifeStageId: defaultLifeStageId })
    // Back to the same starting point as a fresh mount, not to false — a form
    // that doesn't collect mobile must not come back from a reset acting as
    // though the next person simply hasn't typed their number in yet.
    setNoMobile(!cfg.fieldMobile)
    setNoEmail(!cfg.fieldEmail)
    setSmallGroupIntent(null)
    setClaimedSmallGroupId("")
    // The satellite pair travels into the payload the same way `claimedSmallGroupId`
    // does, so leaving it behind would file the next person at the door under the
    // previous person's satellite.
    setClaimedElsewhere(false)
    setClaimedSatellite("")
    setClaimedGroupQuery("")
    setClaimedGroupResults([])
    setMatchedMember(null)
    setConfirmedMember(null)
    setSkipSmallGroup(false)
    setCandidates(null)
    setSelectedBreakoutId("")
    setAssignedBreakout(null)
    setSelectedEventIds([])
    setClusterResults(null)
    setPrimaryRole("FatherHusband")
    setHouseholdMembers([])
    setFormStep(1)
    setPrivacyAccepted(false)
  }

  /**
   * Open the form as an amendment to the registration this person already has.
   *
   * `fields` is what the event now demands and they haven't answered; null is the
   * voluntary path, where the whole form is fair game. Either way the submission
   * updates the existing registrant rather than creating a second one — see the
   * grant check in `createRegistrant`.
   */
  function startAmend(fields: RequirableKey[] | null) {
    setAmending(fields ? "needed" : "all")
    if (fields) setAmendFields(fields)
    setStep("form")
    setFormStep(1)
  }

  function toggleSelectedEvent(id: string) {
    setSelectedEventIds((prev) =>
      prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]
    )
  }

  /** The Collab step is single-choice: one ministry, so one event. */
  function selectOnlyEvent(id: string) {
    setSelectedEventIds([id])
  }

  function set(field: keyof FormValues, value: string | string[]) {
    setForm((prev) => ({ ...prev, [field]: value }))
    // Only meaningful against a pulled profile: with no profile there is nothing
    // to overwrite, and marking everything touched would hand the server a claim
    // it has no reason to act on.
    if (profileSnapshot) {
      setTouchedFields((prev) => (prev.includes(field) ? prev : [...prev, field]))
    }
  }

  // ── Step 0 handlers (CCF-147) ─────────────────────────────────────────────

  /** Fall through to the form the way it has always worked, number retained. */
  function goToManualForm() {
    setStep("form")
    setFormStep(1)
  }

  function openIdentifyConfirm(candidate: MaskedProfileCandidate) {
    setIdentifyMatch(candidate)
    setSecondFactorMonth("")
    setSecondFactorYear("")
    setIdentifyError(null)
    setStep("identify-confirm")
  }

  async function handleIdentifyLookup() {
    // No `noMobile` branch: this screen no longer offers the opt-out, and it is
    // only reachable when the form collects a mobile at all, so the flag cannot
    // be set by the time anyone gets here. "Start a new registration" is the exit.
    if (!form.mobileNumber.trim()) {
      setIdentifyError("Enter your mobile number, or choose to fill in the form manually.")
      return
    }
    setSubmitting(true)
    setIdentifyError(null)
    const result = await lookupProfileByMobile({
      mobileNumber: form.mobileNumber,
      // Cluster mode has no single event, so there is no volunteer record to check.
      eventId: cluster ? null : eventId,
    })
    setSubmitting(false)

    if (result.outcome === "rateLimited") {
      setIdentifyError(
        "Too many lookups from this connection. Wait a minute, or fill in the form manually."
      )
      return
    }
    if (result.outcome === "none") {
      goToManualForm()
      return
    }
    if (result.outcome === "ambiguous") {
      setIdentifyCandidates(result.candidates)
      setIdentifyError(null)
      setStep("identify-ambiguous")
      return
    }
    const { outcome: _outcome, ...candidate } = result
    openIdentifyConfirm(candidate)
  }

  /**
   * Attach a revealed profile and hand over to the ordinary form, which renders
   * step 1 as the review screen. Deliberately never auto-submits, even when the
   * profile answers everything: the person is being asked to *review*, and a
   * form that registered them the instant they proved their birthday would take
   * the review away.
   */
  function applyProfile(
    profile: RegistrationProfileSnapshot,
    grant: string | null,
    standing: { alreadyRegistered: boolean; fieldsStillNeeded: RequirableKey[] }
  ) {
    if (profile.isVolunteer) {
      setMatchedMember({
        id: profile.recordId,
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        phone: profile.phone,
        matchedBy: "mobile",
        recordType: profile.recordType,
        isVolunteer: true,
      })
      setStep("volunteer-blocked")
      return
    }

    setProfileSnapshot(profile)
    setIdentityGrant(grant)
    setEditingProfile(false)
    setTouchedFields([])
    setForm((prev) => ({ ...prev, ...prefillFromProfile(profile) }))
    // Drives the existing fast path in `handleSubmit`, so submission links to the
    // record we pulled instead of running the dedup ladder again.
    setConfirmedMember({
      id: profile.recordId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      phone: profile.phone,
      matchedBy: "mobile",
      recordType: profile.recordType,
      isVolunteer: false,
      smallGroupId: profile.smallGroupId,
    })

    // Someone already in a group isn't asked about one. A member *without* one
    // used to have "I want to join a DGroup" pre-ticked here, which made sense
    // when joining was the only thing they could say. Now that they can also say
    // they're already in one, pre-ticking answers a question on their behalf —
    // and a box nobody touched still submits `wantsSmallGroup`, raising a
    // placement request for someone who may well already have a leader.
    if (profile.recordType === "member" && profile.smallGroupId) setSkipSmallGroup(true)

    setIdentifyMatch(null)
    setIdentifyCandidates(null)

    /**
     * Someone already on the list learns it *here*, before the form, rather than
     * from a toast on the last step after filling in every one of them.
     *
     * The walk-in door is exempt for the same reason the server is: it reuses an
     * existing registration and checks the person in, so "you're already
     * registered" is not a refusal there, it's the normal case.
     */
    if (standing.alreadyRegistered && !walkIn) {
      // A field the admin turned on (or made required) since they signed up is
      // the one thing still worth asking for. `fieldsStillNeeded` is empty in the
      // ordinary case, which is a plain terminal screen.
      setAmendFields(standing.fieldsStillNeeded)
      setStep("already-registered")
      return
    }

    setStep("form")
    setFormStep(1)
  }

  async function handleIdentifyConfirm() {
    if (!identifyMatch) return

    if (identifyMatch.needsSecondFactor) {
      if (!secondFactorMonth || !secondFactorYear) {
        setIdentifyError("Enter your birth month and year to continue.")
        return
      }
      if (!isValidBirthYear(parseInt(secondFactorYear, 10))) {
        setIdentifyError(birthYearMessage())
        return
      }
    }

    setSubmitting(true)
    setIdentifyError(null)
    const result = await revealProfileForRegistration({
      recordId: identifyMatch.recordId,
      recordType: identifyMatch.recordType,
      birthMonth: secondFactorMonth ? parseInt(secondFactorMonth, 10) : null,
      birthYear: secondFactorYear ? parseInt(secondFactorYear, 10) : null,
      eventId: cluster ? null : eventId,
      // The door and the public form can collect different things, so "what does
      // this profile still not answer?" has to be asked of the right one.
      context: walkIn ? "WalkIn" : "Register",
    })
    setSubmitting(false)

    if (!result.ok) {
      setIdentifyError(
        result.reason === "rateLimited"
          ? "Too many attempts from this connection. Wait a minute and try again."
          : result.reason === "notFound"
            ? "We couldn't open that profile. Please fill in the form instead."
            : "That birth month and year don't match this profile."
      )
      return
    }
    applyProfile(result.profile, result.grant, {
      alreadyRegistered: result.alreadyRegistered,
      fieldsStillNeeded: result.fieldsStillNeeded,
    })
  }

  /**
   * "No, not me." The rejected record is remembered so the later lookups can't
   * quietly put them back on it — see `identityResolved` and `register`.
   */
  function handleIdentifyReject() {
    if (identifyMatch) setRejectedRecordId(identifyMatch.recordId)
    setIdentifyMatch(null)
    setIdentifyCandidates(null)
    setIdentifyError(null)
    goToManualForm()
  }

  async function handleNext() {
    // A half-filled household row would otherwise be silently dropped at submit,
    // leaving someone thinking they registered a family member who wasn't saved.
    if (currentSectionKey === "household") {
      const partial = householdMembers.some(
        (m) =>
          (m.firstName.trim() || m.lastName.trim()) &&
          !(m.firstName.trim() && m.lastName.trim())
      )
      if (partial) {
        toast.error("Give every household member both a first and last name, or remove them.")
        return
      }
      const badYear = householdMembers.find(
        (m) => m.birthYear && !isValidBirthYear(parseInt(m.birthYear, 10))
      )
      if (badYear) {
        const who = [badYear.firstName, badYear.lastName].filter(Boolean).join(" ").trim()
        toast.error(who ? `${who}: ${birthYearMessage()}` : birthYearMessage())
        return
      }
    }

    // Cluster mode: the day makes no sense with nothing chosen. Each kind's step
    // asks a different question, so each gets its own words back.
    if (currentSectionKey === "events" && selectedEventIds.length === 0) {
      toast.error("Select at least one event to register for.")
      return
    }
    if (currentSectionKey === "ministry" && selectedEventIds.length === 0) {
      toast.error(MINISTRY_REQUIRED_ERROR)
      return
    }

    // The DGroup step's matching fields (only reachable — and only checked — when
    // the person said they're looking for a group; `askedFieldsFor` drops them
    // otherwise), plus the two requirable sections. Caught here, while the input
    // is still on screen, rather than as a server error after the last step.
    if (["smallgroup", "dietary", "payment"].includes(currentSectionKey)) {
      const missingHere = missingInSection(currentSectionKey)
      if (missingHere.length > 0) {
        toast.error(requiredFieldsMessage(missingHere))
        return
      }
    }

    if (safeStep === 1) {
      if (!form.firstName.trim()) {
        toast.error("First name is required.")
        return
      }
      if (!form.lastName.trim()) {
        toast.error("Last name is required.")
        return
      }
      // Same check the server runs, so a required field fails here — while the
      // input is still on screen — rather than after the last step.
      const missingPersonal = missingInSection("personal")
      if (missingPersonal.length > 0) {
        toast.error(requiredFieldsMessage(missingPersonal))
        return
      }
      // A half-typed ("19") or implausible year is caught here, while the input
      // is still on screen — and before the member lookup below reads it.
      if (form.birthYear && !isValidBirthYear(parseInt(form.birthYear, 10))) {
        toast.error(birthYearMessage())
        return
      }

      // Early member lookup before the Small Group step so we can adapt the form.
      // Skipped once step 0 has settled who this is: asking "is this you?" a
      // second time — of someone who just proved their birthday, or who just said
      // "not me" — is noise, not a safety net. Someone who *skipped* step 0 or
      // whose number found nothing still gets it, since the email and
      // name+birthday rungs are the ones step 0 never tries.
      if (includeSmallGroup && !identityResolved) {
        const hasMobile = !noMobile && !!form.mobileNumber
        const hasEmail = !noEmail && !!form.email
        const hasBirthday = !!form.birthMonth && !!form.birthYear

        if (hasMobile || hasEmail || hasBirthday) {
          setSubmitting(true)
          const match = await lookupMemberForRegistration({
            mobileNumber: hasMobile ? form.mobileNumber : null,
            email: hasEmail ? form.email : null,
            lastName: hasBirthday ? form.lastName : null,
            birthMonth: hasBirthday ? parseInt(form.birthMonth, 10) : null,
            birthYear: hasBirthday ? parseInt(form.birthYear, 10) : null,
            // Cluster mode has no single event: volunteer conflicts are per-event
            // partial results at submit time, not an up-front block.
            eventId: cluster ? null : eventId,
          })
          setSubmitting(false)

          if (match) {
            if ("matchType" in match && match.matchType === "ambiguous") {
              setCandidates({ matchedBy: match.matchedBy, items: match.candidates })
              setStep("early-disambiguate")
              return
            }
            setMatchedMember(match as MatchedMember)
            setStep("early-confirm")
            return
          }
        }
      }
    }
    setFormStep(clampFormStep(safeStep + 1, sections.length))
  }

  function handleEarlyReject() {
    setMatchedMember(null)
    setCandidates(null)
    setStep("form")
    setFormStep(2)
  }

  /**
   * Deliberately does *not* check whether this person is already registered.
   *
   * It could: `lookupMemberForRegistration` already takes an `eventId` and already
   * reports `isVolunteer`, so an `alreadyRegistered` beside it would move the
   * discovery from the last step to this one. But that lookup answers an
   * unauthenticated caller with no second factor, so attendance status there would
   * let anyone who types a phone number learn whether that person is coming — the
   * same leak the step-0 gate withholds from `MaskedProfileCandidate` on purpose.
   *
   * Catching it a step earlier isn't worth buying with that, so this path keeps
   * the submit-side landing in `register()` instead: still a screen with somewhere
   * to go, just one step later for the people who skipped the gate.
   */
  function handleEarlyConfirm(match: MatchedMember) {
    if (match.isVolunteer) {
      setMatchedMember(match)
      setCandidates(null)
      setStep("volunteer-blocked")
      return
    }

    setConfirmedMember(match)

    // Pre-fill matching fields from member's existing data
    if (match.recordType === "member") {
      setForm((prev) => ({
        ...prev,
        lifeStageId: match.lifeStageId || prev.lifeStageId,
        language: match.language && match.language.length > 0 ? match.language : prev.language,
        meetingPreference: match.meetingPreference || prev.meetingPreference,
        workCity: match.workCity || prev.workCity,
        scheduleDayOfWeek:
          match.schedulePreferences && match.schedulePreferences.length > 0
            ? match.schedulePreferences[0].dayOfWeek.toString()
            : prev.scheduleDayOfWeek,
        scheduleTimeStart:
          match.schedulePreferences && match.schedulePreferences.length > 0
            ? match.schedulePreferences[0].timeStart
            : prev.scheduleTimeStart,
      }))
    }

    const willSkipSmallGroup = match.recordType === "member" && !!match.smallGroupId
    if (willSkipSmallGroup) {
      setSkipSmallGroup(true)
    }

    // No auto-check of "wants a DGroup" here either — see the identify path
    // above. A member with no group on file may be in one we never recorded,
    // and that is now something they can say.

    setMatchedMember(null)
    setStep("form")

    // Onto the step after Personal Information, which they have just filled in.
    //
    // This used to count the remaining steps and, if none were left, submit on
    // the spot — so confirming "yes, that's me" registered the person then and
    // there, with no form and no chance to change their mind. Whether that fired
    // was a question of which sections the admin had switched on: on an event
    // with Dietary or Payment the person got a form, and on one without they got
    // a submission, off the same click. `clampFormStep` already heals a step that
    // no longer exists, so the last remaining section is simply the one they land
    // on, with a Register button instead of Next.
    setFormStep(2)
  }

  function handleBack() {
    setFormStep(clampFormStep(safeStep - 1, sections.length))
  }

  /**
   * Out of the form and back to the mobile-number gate.
   *
   * A full reset rather than a step change. The form may be carrying a resolved
   * profile — its details, its DGroup, its answers — and someone backing out to
   * try a different number must not land on a form still filled in as the
   * previous person. Only the number itself survives, since correcting it is the
   * reason to come back here at all.
   */
  function handleBackToIdentify() {
    const typedMobile = form.mobileNumber
    handleReset()
    setForm((prev) => ({ ...prev, mobileNumber: typedMobile }))
  }

  async function handleSubmit(e?: React.FormEvent | React.MouseEvent) {
    e?.preventDefault()

    if (!privacyAccepted) {
      toast.error("Please agree to the CCF Privacy Policy to continue")
      return
    }

    // Gated on the step having actually been rendered, not on `cluster` alone.
    // A form must never block on an answer it did not ask for, and two paths reach
    // submit without the cluster step: amending narrows `sections` to the steps
    // holding the amend fields (`stepKeyForField` can never name a cluster step),
    // and a collab amend deliberately doesn't re-ask the ministry. The server
    // resolves the target from the registration being amended in both cases.
    if (cluster && clusterStepShown && selectedEventIds.length === 0) {
      toast.error(
        cluster.kind === "Collab"
          ? MINISTRY_REQUIRED_ERROR
          : "Select at least one event to register for."
      )
      return
    }

    // On a one-step form Register is the only button, so `handleNext` — where
    // this check normally lives — never runs.
    if (singleSection) {
      if (!form.firstName.trim() || !form.lastName.trim()) {
        toast.error("First and last name are required.")
        return
      }
    }

    // The last step never passes through `handleNext`, so its own required
    // answers would otherwise be caught only by the server — as a toast naming a
    // field on a screen the person is already looking at, after a round trip.
    const missingHere = missingInSection(currentSectionKey)
    if (missingHere.length > 0) {
      toast.error(requiredFieldsMessage(missingHere))
      return
    }

    setSubmitting(true)

    // Fast-path: member was already confirmed in the early lookup step
    if (confirmedMember) {
      await register(
        confirmedMember.recordType === "member" ? confirmedMember.id : null,
        confirmedMember.recordType === "guest" ? confirmedMember.id : null
      )
      return
    }

    const hasMobile = !noMobile && !!form.mobileNumber
    const hasEmail = !noEmail && !!form.email
    const hasBirthday = !!form.birthMonth && !!form.birthYear

    if ((hasMobile || hasEmail || hasBirthday) && !identityResolved) {
      const match = await lookupMemberForRegistration({
        mobileNumber: hasMobile ? form.mobileNumber : null,
        email: hasEmail ? form.email : null,
        lastName: hasBirthday ? form.lastName : null,
        birthMonth: hasBirthday ? parseInt(form.birthMonth, 10) : null,
        birthYear: hasBirthday ? parseInt(form.birthYear, 10) : null,
        eventId: cluster ? null : eventId,
      })
      setSubmitting(false)
      if (match) {
        if ("matchType" in match && match.matchType === "ambiguous") {
          setCandidates({ matchedBy: match.matchedBy, items: match.candidates })
          setStep("disambiguate")
          return
        }
        setMatchedMember(match as MatchedMember)
        setStep("confirm")
        return
      }
    } else {
      setSubmitting(false)
    }

    // A rejected guest match must not be re-matched by phone/email/name on the
    // server either — that ladder is exactly what they just said no to.
    await register(null, null, rejectedRecordId ? true : undefined)
  }

  async function register(
    confirmedMemberId: string | null,
    confirmedGuestId?: string | null,
    skipDeduplication?: boolean
  ) {
    setSubmitting(true)
    const includeMatching = includeSmallGroup && smallGroupIntent === "wants"
    const registrantPayload = {
        firstName: form.firstName,
        lastName: form.lastName,
        nickname: cfg.fieldNickname ? form.nickname : null,
        email: form.email,
        mobileNumber: form.mobileNumber,
        // A disabled field must never submit a value, even one seeded into state
        // (e.g. defaultLifeStageId) or left over from a since-hidden step.
        birthMonth: cfg.fieldBirthDate && form.birthMonth ? parseInt(form.birthMonth, 10) : null,
        birthYear: cfg.fieldBirthDate && form.birthYear ? parseInt(form.birthYear, 10) : null,
        ageRangeBucketId: cfg.fieldAgeRange ? form.ageRangeBucketId || null : null,
        // Life Stage lives in Personal Information now, so it is not conditional on
        // the DGroup step or on the person wanting a group.
        lifeStageId: cfg.fieldLifeStage ? form.lifeStageId || null : null,
        gender: (cfg.fieldGender ? form.gender || null : null) as "Male" | "Female" | null,
        language: includeMatching && cfg.fieldLanguage ? form.language : [],
        meetingPreference:
          includeMatching && cfg.fieldMeetingPreference
            ? ((form.meetingPreference || null) as "Online" | "Hybrid" | "InPerson" | null)
            : null,
        workCity: includeMatching && cfg.fieldWorkCity ? form.workCity || null : null,
        scheduleDayOfWeek:
          includeMatching && cfg.fieldSchedule && form.scheduleDayOfWeek !== ""
            ? parseInt(form.scheduleDayOfWeek, 10)
            : null,
        scheduleTimeStart:
          includeMatching && cfg.fieldSchedule ? form.scheduleTimeStart || null : null,
        scheduleTimeEnd:
          includeMatching && cfg.fieldSchedule ? form.scheduleTimeEnd || null : null,
        claimedSmallGroupId:
          includeSmallGroup && smallGroupIntent === "already_in" && !claimedElsewhere
            ? claimedSmallGroupId || null
            : null,
        claimedSatellite:
          includeSmallGroup && smallGroupIntent === "already_in" && claimedElsewhere
            ? claimedSatellite || null
            : null,
        // The intent itself is submitted now, not just used to reveal the
        // matching questions — the server turns it into a DGroup request (CCF-101).
        wantsSmallGroup: includeSmallGroup && smallGroupIntent === "wants",
        dietaryPreference: includeDietary
          ? form.dietaryPreference === ""
            ? null
            : form.dietaryPreference
          : null,
        dietaryOther:
          includeDietary && form.dietaryPreference === "Other" ? form.dietaryOther || null : null,
        paymentReference: includePayment ? form.paymentReference || null : null,
    }

    // Cluster mode resolves the person once server-side, then fans out one
    // registration per selected event — outcomes come back per event.
    if (cluster) {
      const result = await registerForCluster(
        cluster.token,
        registrantPayload,
        confirmedMemberId,
        confirmedGuestId,
        skipDeduplication,
        selectedEventIds,
        walkIn ? true : undefined,
        touchedFields,
        identityGrant,
        selectedBreakoutId || null
      )
      setSubmitting(false)
      if (result.success) {
        setClusterResults(result.data.results)
        setStep("done")
      } else {
        toast.error(result.error)
      }
      return
    }

    // Household mode registers everyone in one call and links them to a Family;
    // otherwise this is an ordinary single-person registration.
    const result = cfg.sectionFamily
      ? await createHouseholdRegistration(
          eventId!,
          registrantPayload,
          {
            primaryRole,
            familyName: null,
            members: householdMembers
              .filter((m) => m.firstName.trim() && m.lastName.trim())
              .map((m) => ({
                firstName: m.firstName,
                lastName: m.lastName,
                nickname: m.nickname || null,
                role: m.role,
                birthMonth: m.birthMonth ? parseInt(m.birthMonth, 10) : null,
                birthYear: m.birthYear ? parseInt(m.birthYear, 10) : null,
                gender: (m.gender || null) as "Male" | "Female" | null,
                ageRangeBucketId: m.ageRangeBucketId || null,
              })),
          },
          confirmedMemberId,
          confirmedGuestId,
          skipDeduplication,
          selectedBreakoutId || null,
          walkIn ? { occurrenceId: walkIn.occurrenceId } : undefined,
          touchedFields,
          identityGrant
        )
      : await createRegistrant(
          eventId!,
          registrantPayload,
          confirmedMemberId,
          confirmedGuestId,
          skipDeduplication,
          selectedBreakoutId || null,
          walkIn ? { occurrenceId: walkIn.occurrenceId } : undefined,
          touchedFields,
          identityGrant
        )
    setSubmitting(false)

    if (result.success) {
      setAssignedBreakout(result.data.breakoutGroup)
      // Household members who are serving as volunteers aren't registered as
      // attendees — say so rather than letting them silently vanish.
      const skipped: string[] =
        "skippedVolunteers" in result.data && Array.isArray(result.data.skippedVolunteers)
          ? result.data.skippedVolunteers
          : []
      if (skipped.length > 0) {
        toast.info(
          `${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} serving as a volunteer at this event and ${
            skipped.length === 1 ? "doesn't" : "don't"
          } need to register as an attendee.`
        )
      }
      setStep("done")
    } else if (result.reason === "alreadyRegistered") {
      /**
       * The backstop for the people step 0 can't catch: someone the dedup ladder
       * only resolved by email, or by last name plus birthday, at submit time.
       *
       * They still get a screen with somewhere to go rather than a toast that
       * fades off a form they just finished — but not the amend offer, because
       * nothing here proved the registration is theirs. Keyed off `reason` rather
       * than the message so rewording the copy can't silently drop them back onto
       * the dead end.
       *
       * Dropping the grant is what makes that true for the *other* way in here:
       * a grant that has aged past its TTL still reads as a held credential on
       * the client, but the server has already refused it — that refusal is why
       * an amend came back as a duplicate at all. Keeping it would re-offer
       * "Update my details", which would fail identically and land right back on
       * this screen, with no way out but a reload.
       */
      setIdentityGrant(null)
      setAmendFields([])
      setStep("already-registered")
    } else {
      toast.error(result.error)
    }
  }

  if (step === "done" && clusterResults) {
    // Cluster shared form: partial success is normal — show each event's outcome
    // rather than a single all-or-nothing message.
    const matchedSource = confirmedMember ?? matchedMember
    const displayName =
      form.nickname.trim() || form.firstName.trim() || matchedSource?.firstName.trim() || ""
    const anyRegistered = clusterResults.some(
      (r) => r.status === "registered" || r.status === "already"
    )
    /**
     * Someone serving at the event is on the list — they simply don't register as
     * an attendee, which is what the single-event form's own "You're already on
     * the list" screen says. Counting only registrations here told a volunteer
     * their submission had failed and to go ask the team, on the one outcome that
     * needed no action at all.
     */
    const anyVolunteer = clusterResults.some((r) => r.status === "volunteer")
    const anySucceeded = anyRegistered || anyVolunteer
    const statusLine = (r: ClusterEventRegistrationResult): string => {
      switch (r.status) {
        case "registered":
          return r.checkedIn ? "Registered · checked in" : "Registered"
        case "already":
          return r.checkedIn ? "Already registered · checked in" : "Already registered"
        case "closed":
          return "Registration for this event is closed"
        case "volunteer":
          return "You're serving as a volunteer — already included"
        case "failed":
          return "Couldn't register — please ask the team for help"
      }
    }
    const ok = (r: ClusterEventRegistrationResult) =>
      r.status === "registered" || r.status === "already" || r.status === "volunteer"

    /**
     * A Collab day is one event to the person in front of the screen, so the
     * per-event breakdown is exactly the structure this feature hides — being told
     * "Youth Night: registered / Singles Connect: registered" after never being
     * asked about either is confusing at best.
     *
     * Any event taking the registration counts as success. A partial fan-out is an
     * admin problem, and it is already visible to them: the cluster roster computes
     * a standing per person per event, so a missing half shows up there.
     */
    const collapsed = cluster?.kind === "Collab"
    const collapsedBreakout =
      collapsed ? clusterResults.find((r) => r.breakoutGroup)?.breakoutGroup ?? null : null
    const collapsedCheckedIn = collapsed && clusterResults.some((r) => r.checkedIn)

    return (
      <FormShell plain={plain}>
        <CardContent className="flex flex-col items-center gap-5 pt-10 pb-6">
          <div
            className={cn(
              "flex size-16 items-center justify-center rounded-full",
              anySucceeded ? "bg-green-100" : "bg-muted"
            )}
          >
            <IconCheck
              className={cn("size-8", anySucceeded ? "text-green-600" : "text-muted-foreground")}
            />
          </div>
          <div className="w-full text-center space-y-1.5">
            <p className="text-xl font-semibold">
              {anyRegistered
                ? `You're all set${displayName ? `, ${displayName}` : ""}!`
                : anyVolunteer
                  ? `You're already on the list${displayName ? `, ${displayName}` : ""}!`
                  : "Here's where things stand"}
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {/* A configured message replaces the stock line, but only when
                  something actually registered — the failure copy has to stay
                  accurate regardless of what the admin wrote. */}
              {anyRegistered
                ? (successMessage?.trim() ||
                  (collapsed
                    ? `We're so glad you're coming to ${cluster.name}.`
                    : "We're so glad you're coming — here's how each event went."))
                : anyVolunteer
                  ? "You're serving as a volunteer — you're already included and don't need to register as an attendee."
                  : collapsed
                    ? "We couldn't take your registration — the details are below."
                    : "None of the selected events could take your registration."}
            </p>
            {collapsed ? (
              <div className="mt-3 space-y-2 text-left">
                {/* Collapsed to the day's name, never the member events'. The
                    card renders whatever the outcome was — a refusal explains
                    itself here rather than leaving "ask the team" as the only
                    thing on screen. */}
                {clusterResults.length > 0 && (
                  <div className="rounded-xl border bg-muted/40 px-4 py-3 space-y-0.5">
                    <p className="text-sm font-semibold">{cluster.name}</p>
                    <p
                      className={cn(
                        "text-xs",
                        anySucceeded ? "text-muted-foreground" : "text-destructive"
                      )}
                    >
                      {anyRegistered
                        ? collapsedCheckedIn
                          ? "Registered · checked in"
                          : "Registered"
                        : statusLine(clusterResults[0])}
                    </p>
                    {collapsedBreakout && (
                      <p className="text-xs text-muted-foreground">
                        Breakout group: {collapsedBreakout.name}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
            <div className="mt-3 space-y-2 text-left">
              {clusterResults.map((r) => (
                <div key={r.eventId} className="rounded-xl border bg-muted/40 px-4 py-3 space-y-0.5">
                  <p className="text-sm font-semibold">{r.eventName}</p>
                  <p
                    className={cn(
                      "text-xs",
                      ok(r) ? "text-muted-foreground" : "text-destructive"
                    )}
                  >
                    {statusLine(r)}
                  </p>
                  {r.breakoutGroup && (
                    <p className="text-xs text-muted-foreground">
                      Breakout group: {r.breakoutGroup.name}
                    </p>
                  )}
                </div>
              ))}
            </div>
            )}
          </div>
          <DoneActions walkIn={walkIn} onReset={handleReset} />
        </CardContent>
      </FormShell>
    )
  }

  if (step === "done") {
    // A confirmed member/guest keeps their own name — the form fields stay blank
    // when the person was matched by mobile rather than typed in.
    const matchedSource = confirmedMember ?? matchedMember
    const displayName =
      form.nickname.trim() || form.firstName.trim() || matchedSource?.firstName.trim() || ""
    const displayBreakout: AssignedBreakout | null =
      assignedBreakout ??
      (selectedBreakoutId
        ? (() => {
            const candidate = breakoutCandidates.find((c) => c.id === selectedBreakoutId)
            return candidate
              ? { id: candidate.id, name: candidate.name, meetingFormat: null, locationCity: null, schedule: null }
              : null
          })()
        : null)
    const meta = displayBreakout
      ? [
          displayBreakout.schedule
            ? // The meeting time is optional — fall back to the day alone.
              [
                DAY_NAMES[displayBreakout.schedule.dayOfWeek],
                displayBreakout.schedule.timeStart
                  ? formatTime(displayBreakout.schedule.timeStart)
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : null,
          displayBreakout.meetingFormat
            ? MEETING_FORMAT_LABEL[displayBreakout.meetingFormat]
            : null,
          displayBreakout.locationCity,
        ].filter(Boolean)
      : []
    return (
      <FormShell plain={plain}>
        <CardContent className="flex flex-col items-center gap-5 pt-10 pb-6">
          <div className="flex size-16 items-center justify-center rounded-full bg-green-100">
            <IconCheck className="size-8 text-green-600" />
          </div>
          <div className="text-center space-y-1.5">
            <p className="text-xl font-semibold">
              Welcome{displayName ? `, ${displayName}` : ""}!
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {resolveSuccessMessage(successMessage, walkIn ? "WalkIn" : "Register", eventName)}
            </p>
            {displayBreakout && (
              <div className="mt-3 rounded-xl border bg-muted/40 px-4 py-3 text-left space-y-0.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Your breakout group
                </p>
                <p className="text-sm font-semibold">{displayBreakout.name}</p>
                {meta.length > 0 && (
                  <p className="text-xs text-muted-foreground">{meta.join(" · ")}</p>
                )}
              </div>
            )}
          </div>
          <DoneActions walkIn={walkIn} onReset={handleReset} />
        </CardContent>
      </FormShell>
    )
  }

  // ── Step 0: "What's your mobile number?" (CCF-147) ────────────────────────
  if (step === "identify") {
    return (
      <div className="space-y-4">
        <FormShell plain={plain}>
          <CardHeader>
            <CardTitle>What&apos;s your mobile number?</CardTitle>
            <CardDescription>
              If you&apos;ve registered with us before, we&apos;ll pull up your details so you
              don&apos;t have to type them again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="identifyMobile">Mobile Number</Label>
              {/* No "I don't have one" here, unlike the field on the form itself.
                  This screen asks for a number in order to *look one up*, and
                  opting out of the question is what the card below it does — an
                  escape hatch inside the input as well only gave the same exit
                  two different shapes. */}
              <PhonePHInput
                id="identifyMobile"
                value={form.mobileNumber}
                onChange={(v) => {
                  set("mobileNumber", v)
                  setIdentifyError(null)
                }}
              />
            </div>

            {identifyError && (
              <p className="text-sm text-destructive" role="alert">
                {identifyError}
              </p>
            )}

            <Button className="w-full" onClick={handleIdentifyLookup} disabled={submitting}>
              {submitting ? "Checking…" : "Continue"}
            </Button>
          </CardContent>
        </FormShell>

        {/* The other way through, as a card of its own. It used to be a quiet
            underlined line under the Continue button, which read as a way to
            dodge the form rather than the ordinary route for anyone we don't
            have on file yet. */}
        <FormShell plain={plain}>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">First time with us?</p>
              <p className="text-sm text-muted-foreground">
                No number on file yet — fill in your details and we&apos;ll set you up.
              </p>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={goToManualForm}
              disabled={submitting}
            >
              Start a new registration
            </Button>
          </CardContent>
        </FormShell>

        {/* Without this the door is a dead end: the gate is the first screen a
            walk-in sees, so the check-in board has to be reachable from it. */}
        {walkIn?.backHref && (
          <Button variant="ghost" className="w-full" asChild>
            <Link href={walkIn.backHref}>Back to check-in</Link>
          </Button>
        )}
      </div>
    )
  }

  // ── Step 0: "Is this you?" — masked identity + second factor ──────────────
  if (step === "identify-confirm" && identifyMatch) {
    return (
      <FormShell plain={plain}>
        <CardHeader>
          <CardTitle>Is this you?</CardTitle>
          <CardDescription>
            We found a profile with this mobile number.
            {identifyMatch.needsSecondFactor
              ? " Confirm your birth month and year to open it."
              : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Masked on purpose: anyone can type anyone's number into this form,
              so the card has to be safe to show a stranger. */}
          <div className="rounded-lg border p-4 text-sm space-y-1">
            <p className="font-medium tracking-wide">{identifyMatch.maskedName}</p>
            {identifyMatch.contactHint && (
              <p className="text-muted-foreground">{identifyMatch.contactHint}</p>
            )}
          </div>

          {identifyMatch.needsSecondFactor && (
            <BirthMonthYearInput
              id="secondFactor"
              label="Your birth month and year"
              required
              month={secondFactorMonth}
              year={secondFactorYear}
              onMonthChange={(v) => {
                setSecondFactorMonth(v)
                setIdentifyError(null)
              }}
              onYearChange={(v) => {
                setSecondFactorYear(v)
                setIdentifyError(null)
              }}
            />
          )}

          {identifyError && (
            <p className="text-sm text-destructive" role="alert">
              {identifyError}
            </p>
          )}

          <div className="flex gap-2">
            <Button className="flex-1" onClick={handleIdentifyConfirm} disabled={submitting}>
              {submitting ? "Please wait…" : "Yes, that's me"}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleIdentifyReject}
              disabled={submitting}
            >
              No, not me
            </Button>
          </div>
        </CardContent>
      </FormShell>
    )
  }

  // ── Step 0: one number, several profiles (shared family handsets) ─────────
  if (step === "identify-ambiguous" && identifyCandidates) {
    return (
      <FormShell plain={plain}>
        <CardHeader>
          <CardTitle>Which one is you?</CardTitle>
          <CardDescription>
            Several profiles share this mobile number. Pick yours, or choose &quot;None of
            these&quot;.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {identifyCandidates.map((c) => (
            <button
              key={c.recordId}
              type="button"
              onClick={() => openIdentifyConfirm(c)}
              className="w-full rounded-lg border p-4 text-left text-sm transition-colors hover:bg-muted/50"
            >
              <p className="font-medium tracking-wide">{c.maskedName}</p>
              {c.contactHint && <p className="text-muted-foreground">{c.contactHint}</p>}
            </button>
          ))}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              setIdentifyCandidates(null)
              goToManualForm()
            }}
            disabled={submitting}
          >
            None of these
          </Button>
        </CardContent>
      </FormShell>
    )
  }

  /**
   * Already on the list — said at step 0, before the form, rather than by a toast
   * on the last step of a form they just finished filling in.
   *
   * Two shapes, and the difference is whether the event still wants something from
   * them. Ordinarily this is a dead end and should read like good news. When the
   * admin has enabled or required a field since they signed up, it becomes a short
   * detour instead: the questions they haven't answered, and nothing else.
   */
  if (step === "already-registered") {
    // Reached two ways: from step 0 with a revealed profile, and from a failed
    // submit where the person typed everything in and the dedup ladder only
    // matched them at the end. The name has to come from whichever happened.
    const firstName =
      profileSnapshot?.firstName ||
      form.nickname.trim() ||
      form.firstName.trim() ||
      confirmedMember?.firstName.trim() ||
      ""
    const needs = amendFields.length > 0
    // Amending writes to an existing registration, so it is offered only where
    // ownership was actually proved. The late path has no grant and gets the
    // plain dead end — which is still a screen with somewhere to go.
    const canAmend = identityGrant !== null
    return (
      <FormShell plain={plain}>
        <CardContent className="flex flex-col items-center gap-5 pt-10 pb-6">
          <div className="flex size-16 items-center justify-center rounded-full bg-green-100">
            <IconCheck className="size-8 text-green-600" />
          </div>
          <div className="text-center space-y-1.5">
            <p className="text-xl font-semibold">
              You&apos;re already registered{firstName ? `, ${firstName}` : ""}!
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {needs && canAmend
                ? `We just need ${amendFields.length === 1 ? "one more thing" : `${amendFields.length} more things`} from you${eventName ? ` for ${eventName}` : ""}.`
                : resolveSuccessMessage(successMessage, "Register", eventName)}
            </p>
            {needs && canAmend && (
              <p className="text-sm text-muted-foreground">{requiredFieldLabels(amendFields)}</p>
            )}
          </div>
          {needs && canAmend ? (
            <div className="w-full space-y-2">
              <Button className="w-full" onClick={() => startAmend(amendFields)}>
                Continue
              </Button>
              <Button className="w-full" variant="ghost" onClick={handleReset}>
                {walkIn ? "Register another walk-in" : "Register another person"}
              </Button>
            </div>
          ) : (
            <div className="w-full space-y-2">
              {/* Nothing is being demanded, but someone who came back specifically
                  to change an answer shouldn't be turned away. */}
              {canAmend && (
                <Button className="w-full" variant="outline" onClick={() => startAmend(null)}>
                  Update my details
                </Button>
              )}
              <DoneActions walkIn={walkIn} onReset={handleReset} variant={canAmend ? "ghost" : undefined} />
            </div>
          )}
        </CardContent>
      </FormShell>
    )
  }

  if (step === "volunteer-blocked" && matchedMember) {
    const firstName = matchedMember.firstName
    return (
      <FormShell plain={plain}>
        <CardContent className="flex flex-col items-center gap-5 pt-10 pb-6">
          <div className="flex size-16 items-center justify-center rounded-full bg-primary/10">
            <IconCheck className="size-8 text-primary" />
          </div>
          <div className="text-center space-y-1.5">
            <p className="text-xl font-semibold">
              You&apos;re already on the list{firstName ? `, ${firstName}` : ""}!
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              You&apos;re serving as a volunteer at this event — you&apos;re already included and don&apos;t need to register as an attendee.
            </p>
          </div>
          <DoneActions walkIn={walkIn} onReset={handleReset} variant="outline" />
        </CardContent>
      </FormShell>
    )
  }

  if (step === "disambiguate" && candidates) {
    return (
      <FormShell plain={plain}>
        <CardHeader>
          <CardTitle>Multiple profiles found</CardTitle>
          <CardDescription>
            {candidates.matchedBy === "mobile"
              ? "We found multiple profiles with this mobile number."
              : "We found multiple profiles with this email address."}{" "}
            Select the one that&apos;s you, or choose &quot;That&apos;s not me&quot;.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {candidates.items.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setMatchedMember({ ...c, matchedBy: candidates.matchedBy })
                setStep("confirm")
              }}
              className="w-full rounded-lg border p-4 text-left text-sm transition-colors hover:bg-muted/50"
            >
              <p className="font-medium">
                {c.firstName} {c.lastName}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  ({c.recordType})
                </span>
              </p>
              {c.email && <p className="text-muted-foreground">{c.email}</p>}
              {c.phone && <p className="text-muted-foreground">{c.phone}</p>}
            </button>
          ))}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => register(null)}
            disabled={submitting}
          >
            {submitting ? "Registering…" : "That's not me"}
          </Button>
        </CardContent>
      </FormShell>
    )
  }

  if (step === "confirm" && matchedMember) {
    return (
      <FormShell plain={plain}>
        <CardHeader>
          <CardTitle>Is this you?</CardTitle>
          <CardDescription>
            {matchedMember.matchedBy === "mobile" &&
              "We found an existing record matching your mobile number."}
            {matchedMember.matchedBy === "email" &&
              "We found an existing record matching your email address."}
            {matchedMember.matchedBy === "nameBirthday" &&
              "We found an existing record matching your name and birthday."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-4 text-sm space-y-1">
            <p className="font-medium">
              {matchedMember.firstName} {matchedMember.lastName}
            </p>
            {matchedMember.email && (
              <p className="text-muted-foreground">{matchedMember.email}</p>
            )}
            {matchedMember.phone && (
              <p className="text-muted-foreground">{matchedMember.phone}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() => {
                if (matchedMember.isVolunteer) {
                  setStep("volunteer-blocked")
                  return
                }
                if (matchedMember.recordType === "guest") {
                  register(null, matchedMember.id)
                } else {
                  register(matchedMember.id)
                }
              }}
              disabled={submitting}
            >
              {submitting ? "Registering…" : "Yes, that's me"}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() =>
                matchedMember.recordType === "guest"
                  ? register(null, null, true)
                  : register(null)
              }
              disabled={submitting}
            >
              {submitting ? "Registering…" : "That's not me"}
            </Button>
          </div>
        </CardContent>
      </FormShell>
    )
  }

  if (step === "early-confirm" && matchedMember) {
    return (
      <FormShell plain={plain}>
        <CardHeader>
          <CardTitle>Is this you?</CardTitle>
          <CardDescription>
            {matchedMember.matchedBy === "mobile" &&
              "We found an existing record matching your mobile number."}
            {matchedMember.matchedBy === "email" &&
              "We found an existing record matching your email address."}
            {matchedMember.matchedBy === "nameBirthday" &&
              "We found an existing record matching your name and birthday."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-4 text-sm space-y-1">
            <p className="font-medium">
              {matchedMember.firstName} {matchedMember.lastName}
            </p>
            {matchedMember.email && (
              <p className="text-muted-foreground">{matchedMember.email}</p>
            )}
            {matchedMember.phone && (
              <p className="text-muted-foreground">{matchedMember.phone}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() => handleEarlyConfirm(matchedMember)}
              disabled={submitting}
            >
              {submitting ? "Please wait…" : "Yes, that's me"}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleEarlyReject}
              disabled={submitting}
            >
              That&apos;s not me
            </Button>
          </div>
        </CardContent>
      </FormShell>
    )
  }

  if (step === "early-disambiguate" && candidates) {
    return (
      <FormShell plain={plain}>
        <CardHeader>
          <CardTitle>Multiple profiles found</CardTitle>
          <CardDescription>
            {candidates.matchedBy === "mobile"
              ? "We found multiple profiles with this mobile number."
              : "We found multiple profiles with this email address."}{" "}
            Select the one that&apos;s you, or choose &quot;That&apos;s not me&quot;.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {candidates.items.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => handleEarlyConfirm({ ...c, matchedBy: candidates.matchedBy })}
              className="w-full rounded-lg border p-4 text-left text-sm transition-colors hover:bg-muted/50"
            >
              <p className="font-medium">
                {c.firstName} {c.lastName}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  ({c.recordType})
                </span>
              </p>
              {c.email && <p className="text-muted-foreground">{c.email}</p>}
              {c.phone && <p className="text-muted-foreground">{c.phone}</p>}
            </button>
          ))}
          <Button
            variant="outline"
            className="w-full"
            onClick={handleEarlyReject}
            disabled={submitting}
          >
            That&apos;s not me
          </Button>
        </CardContent>
      </FormShell>
    )
  }

  return (
    <FormShell plain={plain} ref={cardRef} className="pt-0">
      {/* No bottom padding here, and none on the CardContent below: the Card's own
          `gap-6` is the single spacer between the header and the fields. Both used
          to add their own padding on top of that gap, which read as a title crowded
          against the card's top edge and marooned from the first field — worst on a
          one-step form, where the progress row isn't there to fill the space. */}
      <div className="px-6 pt-6">
        {/* Step dots. A one-step form has no progress to report — a lone dot with
            no connector reads as a rendering fault — so the whole progress row
            drops out and the section title carries the header on its own. */}
        {!singleSection && (
          <>
            <div className="flex items-center gap-1.5 mb-4">
              {sections.map((s, i) => {
                const n = i + 1
                const done = n < safeStep
                const current = n === safeStep
                return (
                  <React.Fragment key={s.key}>
                    <div
                      className={cn(
                        "rounded-full shrink-0 transition-all duration-150",
                        done
                          ? "size-2 bg-primary/50"
                          : current
                            ? "size-2.5 bg-primary"
                            : "size-2 bg-muted-foreground/25"
                      )}
                    />
                    {i < sections.length - 1 && (
                      <div
                        className={cn(
                          "flex-1 h-px transition-colors",
                          done ? "bg-primary/40" : "bg-border"
                        )}
                      />
                    )}
                  </React.Fragment>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Step {safeStep} of {sections.length}
            </p>
          </>
        )}
        <p className={cn("text-lg font-semibold", !singleSection && "mt-0.5")}>
          {sections[safeStep - 1].title}
        </p>
      </div>

      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* ── Personal Information ── */}
          {currentSectionKey === "personal" && (
            <>
              {/* ── Review screen (CCF-147) ──
                  The profile we already hold, shown as a summary the person can
                  submit as-is. Below it, only the questions the profile couldn't
                  answer. "Edit details" swaps the whole thing back to the normal
                  inputs, already filled in. */}
              {profileSnapshot && !editingProfile && (
                <div className="space-y-4">
                  <div className="rounded-lg border p-4 text-sm">
                    <dl className="space-y-2">
                      {profileSummaryRows(profileSnapshot, cfg, { lifeStages, ageRanges }).map(
                        (row) => (
                          <div key={row.key} className="flex gap-3">
                            <dt className="w-28 shrink-0 text-muted-foreground">{row.label}</dt>
                            <dd className="font-medium wrap-break-word">{row.value}</dd>
                          </div>
                        )
                      )}
                    </dl>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => setEditingProfile(true)}
                  >
                    Edit details
                  </Button>
                  {stillNeededHere.length > 0 && (
                    <p className="text-sm text-muted-foreground">
                      Just a couple more things before you&apos;re done.
                    </p>
                  )}
                </div>
              )}

              {showNameFields && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="firstName">
                      First Name <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="firstName"
                      value={form.firstName}
                      onChange={(e) => set("firstName", e.target.value)}
                      placeholder="Juan"
                      required={singleSection}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lastName">
                      Last Name <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="lastName"
                      value={form.lastName}
                      onChange={(e) => set("lastName", e.target.value)}
                      placeholder="dela Cruz"
                      required={singleSection}
                    />
                  </div>
                </div>
              )}

              {showPersonalField("fieldNickname") && (
                <div className="space-y-2">
                  <Label htmlFor="nickname">
                    Nickname <RequiredMark on={cfg.fieldNicknameRequired} />
                  </Label>
                  <Input
                    id="nickname"
                    value={form.nickname}
                    onChange={(e) => set("nickname", e.target.value)}
                    placeholder="Jun"
                  />
                </div>
              )}

              {showPersonalField("fieldMobile") && (
                <div className="space-y-2">
                  <Label htmlFor="mobileNumber">
                    Mobile Number <RequiredMark on={cfg.fieldMobileRequired} />
                  </Label>
                  <OptionalPhonePHInput
                    id="mobileNumber"
                    value={form.mobileNumber}
                    onChange={(v) => set("mobileNumber", v)}
                    noNumber={noMobile}
                    onNoNumberChange={setNoMobile}
                    hideOptOut={cfg.fieldMobileRequired}
                  />
                </div>
              )}

              {showPersonalField("fieldEmail") && (
                <div className="space-y-2">
                  <Label htmlFor="email">
                    Email <RequiredMark on={cfg.fieldEmailRequired} />
                  </Label>
                  <OptionalEmailInput
                    id="email"
                    value={form.email}
                    onChange={(e) => set("email", e.target.value)}
                    placeholder="juan@email.com"
                    noEmail={noEmail}
                    onNoEmailChange={setNoEmail}
                    hideOptOut={cfg.fieldEmailRequired}
                  />
                </div>
              )}

              {/* Life Stage sits with the other demographics rather than in the
                  DGroup step: it describes the person, and ministries are scoped by
                  it, so it's worth asking whether or not they want a group. */}
              {showPersonalField("fieldLifeStage") && lifeStages.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="lifeStage">
                    Life Stage <RequiredMark on={cfg.fieldLifeStageRequired} />
                  </Label>
                  <Select
                    value={form.lifeStageId}
                    onValueChange={(v) => set("lifeStageId", v)}
                  >
                    <SelectTrigger id="lifeStage">
                      <SelectValue placeholder="Select life stage" />
                    </SelectTrigger>
                    <SelectContent>
                      {/* No opt-out item (CCF-143). Unanswered is the placeholder
                          state, which stores null exactly as the old sentinel did. */}
                      {lifeStages.map((ls) => (
                        <SelectItem key={ls.id} value={ls.id}>
                          {ls.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {showPersonalField("fieldBirthDate") && (
                <BirthMonthYearInput
                  required={cfg.fieldBirthDateRequired}
                  month={form.birthMonth}
                  year={form.birthYear}
                  onMonthChange={(v) => set("birthMonth", v)}
                  onYearChange={(v) => set("birthYear", v)}
                />
              )}

              {showPersonalField("fieldAgeRange") && ageRanges.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="ageRange">
                    Age Range <RequiredMark on={cfg.fieldAgeRangeRequired} />
                  </Label>
                  <Select
                    value={form.ageRangeBucketId}
                    onValueChange={(v) => set("ageRangeBucketId", v)}
                  >
                    <SelectTrigger id="ageRange">
                      <SelectValue placeholder="Select age range" />
                    </SelectTrigger>
                    <SelectContent>
                      {/* No opt-out item — see the Life Stage select above. */}
                      {ageRanges.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {showPersonalField("fieldGender") && (
                <div className="space-y-2">
                  <Label>
                    Gender <RequiredMark on={cfg.fieldGenderRequired} />
                  </Label>
                  <div className="flex gap-3">
                    {["Male", "Female"].map((g) => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => set("gender", form.gender === g ? "" : g)}
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
            </>
          )}

          {/* ── Events (cluster shared form, CCF-132) ── */}
          {cluster && currentSectionKey === "events" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Tick the events you&apos;ll be joining — at least one.
              </p>
              {cluster.events.map((ev) => {
                const checked = selectedEventIds.includes(ev.id)
                return (
                  <label
                    key={ev.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors hover:bg-muted/50",
                      checked && "border-primary bg-primary/5"
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleSelectedEvent(ev.id)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{ev.name}</span>
                      {ev.meta && (
                        <span className="block text-xs text-muted-foreground">{ev.meta}</span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          )}

          {/* ── Ministry (collab shared form, CCF-148) ──
              The same list of member events, asked as a different question and
              answered once. Radio semantics rather than tickboxes: "which ministry
              are you part of" has one answer, and offering two would produce a
              payload the server rejects.

              Falls back to event names when a ministry is missing — a day the
              Settings guard should have blocked, but a registrant standing in front
              of the form is the wrong person to punish for it. */}
          {cluster && currentSectionKey === "ministry" && (
            <div className="space-y-3" role="radiogroup" aria-label="Your ministry">
              <p className="text-sm text-muted-foreground">
                {cluster.events.every((ev) => ev.ministry)
                  ? "Which ministry are you part of?"
                  : "Which group are you with?"}
              </p>
              {cluster.events.map((ev) => {
                const checked = selectedEventIds.includes(ev.id)
                // The ministry is the whole label — the event name is deliberately
                // not shown alongside it. Someone at a collab is picking the group
                // they belong to, and naming the two underlying events beside it
                // re-exposes the split the day is meant to hide.
                const label = ev.ministry?.name ?? ev.name
                return (
                  <button
                    key={ev.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    onClick={() => selectOnlyEvent(ev.id)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50",
                      checked && "border-primary bg-primary/5"
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        checked ? "border-primary" : "border-input"
                      )}
                      aria-hidden="true"
                    >
                      {checked && <span className="size-2 rounded-full bg-primary" />}
                    </span>
                    {/* Only when a ministry actually names the choice. On the
                        event-name fallback there is no ministry to show a badge
                        for, and initials of an event name would be noise. */}
                    {ev.ministry && (
                      <MinistryAvatar ministry={ev.ministry} className="size-10" />
                    )}
                    <span className="min-w-0 text-sm font-medium">{label}</span>
                  </button>
                )
              })}
            </div>
          )}

          {/* ── Small Group Info ── */}
          {/* `!skipSmallGroup` is redundant with the step no longer existing, but
              it is the rule this section actually has — someone already in a DGroup
              is not asked to join one — so it stays stated where it's enforced. */}
          {includeSmallGroup && !skipSmallGroup && currentSectionKey === "smallgroup" && (
            <>
              {confirmedMember?.recordType === "member" && !confirmedMember.smallGroupId && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">
                  We don&apos;t have a DGroup on file for you — join one, or tell us
                  about the one you&apos;re already in.
                </div>
              )}

              {/* Two mutually exclusive options, for members and guests alike.
                  The "already part of one" branch was guest-only for a while,
                  because a guest has `claimedSmallGroupId` to hold a self-report
                  and a member had nowhere — `Member.smallGroupId` is real
                  membership only an admin may set. A member's answer now becomes
                  a *Pending* join request instead (`recordMemberGroupClaim`), so
                  membership stays admin-owned and the one group of people most
                  likely to already have a leader stops being the only ones who
                  can't say so. Members who *are* on file in a DGroup never reach
                  here — `skipSmallGroup` drops the section entirely. */}
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="wantsSmallGroup"
                    checked={smallGroupIntent === "wants"}
                    onCheckedChange={(v) => setSmallGroupIntent(v === true ? "wants" : null)}
                    className="mt-0.5"
                  />
                  <Label htmlFor="wantsSmallGroup" className="text-sm font-normal leading-snug">
                    I want to join a DGroup
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="alreadyInSmallGroup"
                    checked={smallGroupIntent === "already_in"}
                    onCheckedChange={(v) => {
                      setSmallGroupIntent(v === true ? "already_in" : null)
                      if (!v) {
                        setClaimedSmallGroupId("")
                        setClaimedGroupQuery("")
                        setClaimedGroupResults([])
                        setClaimedElsewhere(false)
                        setClaimedSatellite("")
                      }
                    }}
                    className="mt-0.5"
                  />
                  <Label htmlFor="alreadyInSmallGroup" className="text-sm font-normal leading-snug">
                    I&apos;m already part of a DGroup
                  </Label>
                </div>
              </div>

              {/* Already in a group — leader/group search */}
              {smallGroupIntent === "already_in" && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="claimedElsewhere"
                      checked={claimedElsewhere}
                      onCheckedChange={(v) => {
                        const on = v === true
                        setClaimedElsewhere(on)
                        // Only one answer survives — drop whichever the person left behind.
                        if (on) {
                          setClaimedSmallGroupId("")
                          setClaimedGroupQuery("")
                          setClaimedGroupResults([])
                        } else {
                          setClaimedSatellite("")
                        }
                      }}
                      className="mt-0.5"
                    />
                    <Label htmlFor="claimedElsewhere" className="text-sm font-normal leading-snug">
                      My DGroup is at another CCF satellite
                    </Label>
                  </div>

                  {claimedElsewhere && (
                    <div className="space-y-1.5">
                      <Label htmlFor="claimedSatellite">Which satellite?</Label>
                      <PersonCombobox
                        id="claimedSatellite"
                        options={satelliteOptions}
                        value={claimedSatellite}
                        onValueChange={setClaimedSatellite}
                        placeholder="Select a CCF satellite"
                        searchPlaceholder="Search satellites…"
                        emptyText="No satellite found."
                      />
                    </div>
                  )}
                </div>
              )}

              {smallGroupIntent === "already_in" && !claimedElsewhere && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="claimedGroupSearch">Search by leader&apos;s name</Label>
                    <Input
                      id="claimedGroupSearch"
                      value={claimedGroupQuery}
                      onChange={(e) => handleClaimedGroupQueryChange(e.target.value)}
                      placeholder="e.g. Juan dela Cruz"
                      autoComplete="off"
                    />
                  </div>
                  {claimedGroupSearching && (
                    <p className="text-xs text-muted-foreground">Searching…</p>
                  )}
                  {!claimedGroupSearching && claimedGroupResults.length > 0 && (
                    <div className="space-y-1.5">
                      {claimedGroupResults.map((g) => (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => {
                            setClaimedSmallGroupId(g.id)
                            setClaimedGroupQuery(g.name)
                            setClaimedGroupResults([])
                          }}
                          className={cn(
                            "w-full rounded-lg border px-4 py-3 text-left transition-colors",
                            claimedSmallGroupId === g.id
                              ? "border-primary bg-primary/5"
                              : "bg-background hover:bg-muted"
                          )}
                        >
                          <p className="text-sm font-medium">{g.name}</p>
                          <p className="text-xs text-muted-foreground">Led by {g.leaderName}</p>
                        </button>
                      ))}
                    </div>
                  )}
                  {!claimedGroupSearching && claimedGroupQuery.trim().length >= 2 && claimedGroupResults.length === 0 && !claimedSmallGroupId && (
                    <p className="text-xs text-muted-foreground">
                      No groups found for &ldquo;{claimedGroupQuery}&rdquo;.
                    </p>
                  )}
                  {claimedSmallGroupId && claimedGroupResults.length === 0 && (
                    <div className="flex items-center justify-between rounded-lg border border-primary bg-primary/5 px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">{claimedGroupQuery}</p>
                        <p className="text-xs text-muted-foreground">DGroup selected</p>
                      </div>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setClaimedSmallGroupId("")
                          setClaimedGroupQuery("")
                        }}
                      >
                        Change
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Wants to join — matching preferences */}
              {smallGroupIntent === "wants" && (
                <>
                  {hasMatchingFields && (
                    <div className="pt-1">
                      <p className="text-sm font-medium text-foreground">Help us connect you</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        These optional details help us find the right Breakout Group for you.
                      </p>
                    </div>
                  )}

                  {cfg.fieldLanguage && (
                    <div className="space-y-2">
                      <Label>
                        Primary Language <RequiredMark on={cfg.fieldLanguageRequired} />
                      </Label>
                      <MultiSelect
                        options={LANGUAGE_OPTIONS}
                        value={form.language}
                        onChange={(v) => set("language", v)}
                        placeholder="Select language(s)"
                      />
                    </div>
                  )}

                  {cfg.fieldMeetingPreference && (
                    <div className="space-y-2">
                      <Label>
                        Meeting Preference <RequiredMark on={cfg.fieldMeetingPreferenceRequired} />
                      </Label>
                      <Select
                        value={form.meetingPreference}
                        onValueChange={(v) => set("meetingPreference", v === "none" ? "" : v)}
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
                        onDayChange={(v) => set("scheduleDayOfWeek", v)}
                        onTimeStartChange={(v) => set("scheduleTimeStart", v)}
                        onTimeEndChange={(v) => set("scheduleTimeEnd", v)}
                      />
                    </div>
                  )}

                  {cfg.fieldWorkCity && (
                    <div className="space-y-2">
                      <Label>
                        Work / Home City <RequiredMark on={cfg.fieldWorkCityRequired} />
                      </Label>
                      <Select
                        value={form.workCity || "_none"}
                        onValueChange={(v) => set("workCity", v === "_none" ? "" : v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select city" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_none">No preference</SelectItem>
                          {CITY_OPTIONS.map((city) => (
                            <SelectItem key={city} value={city}>
                              {city}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ── Breakout Group ── */}
          {showBreakoutSection && currentSectionKey === "breakout" && (
            <BreakoutPicker
              suggested={suggestedBreakout}
              options={browsableCandidates}
              hasCandidates={hasBreakoutChoices}
              notice={breakoutNotice}
              value={selectedBreakoutId}
              onChange={setSelectedBreakoutId}
            />
          )}

          {/* ── Household ── */}
          {cfg.sectionFamily && currentSectionKey === "household" && (
            <>
              <p className="text-xs text-muted-foreground">
                {cfg.familySpouseOnly
                  ? "Optional — tell us about your spouse so we can keep you together."
                  : "Register the rest of your household here so you can all be checked in together. Only your own contact details are needed."}
              </p>

              <div className="space-y-2">
                <Label htmlFor="primaryRole">Your role at home</Label>
                <Select
                  value={primaryRole}
                  onValueChange={(v) => setPrimaryRole(v as FamilyRoleValue)}
                >
                  <SelectTrigger id="primaryRole">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(cfg.familySpouseOnly
                      ? (["FatherHusband", "MotherWife"] as const)
                      : FAMILY_ROLES
                    ).map((role) => (
                      <SelectItem key={role} value={role}>
                        {FAMILY_ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {cfg.familySpouseOnly ? (
                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm font-medium">
                    Your spouse{" "}
                    <span className="font-normal text-muted-foreground">
                      ({FAMILY_ROLE_LABELS[spouseRole]}) — optional
                    </span>
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="spouse-first">First Name</Label>
                      <Input
                        id="spouse-first"
                        value={spouse.firstName}
                        onChange={(e) => setSpouseField("firstName", e.target.value)}
                        placeholder="Maria"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="spouse-last">Last Name</Label>
                      <Input
                        id="spouse-last"
                        value={spouse.lastName}
                        onChange={(e) => setSpouseField("lastName", e.target.value)}
                        placeholder="dela Cruz"
                      />
                    </div>
                  </div>

                  {cfg.fieldBirthDate && (
                    <BirthMonthYearInput
                      month={spouse.birthMonth}
                      year={spouse.birthYear}
                      onMonthChange={(v) => setSpouseField("birthMonth", v)}
                      onYearChange={(v) => setSpouseField("birthYear", v)}
                    />
                  )}

                  {cfg.fieldGender && (
                    <div className="space-y-2">
                      <Label>Gender</Label>
                      <div className="flex gap-3">
                        {["Male", "Female"].map((g) => (
                          <button
                            key={g}
                            type="button"
                            onClick={() =>
                              setSpouseField("gender", spouse.gender === g ? "" : g)
                            }
                            className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                              spouse.gender === g
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
                </div>
              ) : (
              householdMembers.map((member, index) => (
                <div key={index} className="space-y-3 rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Household member {index + 1}</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setHouseholdMembers((prev) => prev.filter((_, i) => i !== index))
                      }
                    >
                      Remove
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor={`hm-first-${index}`}>
                        First Name <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id={`hm-first-${index}`}
                        value={member.firstName}
                        onChange={(e) =>
                          setHouseholdMembers((prev) =>
                            prev.map((m, i) =>
                              i === index ? { ...m, firstName: e.target.value } : m
                            )
                          )
                        }
                        placeholder="Juan"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`hm-last-${index}`}>
                        Last Name <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id={`hm-last-${index}`}
                        value={member.lastName}
                        onChange={(e) =>
                          setHouseholdMembers((prev) =>
                            prev.map((m, i) =>
                              i === index ? { ...m, lastName: e.target.value } : m
                            )
                          )
                        }
                        placeholder="dela Cruz"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor={`hm-role-${index}`}>Relationship</Label>
                    <Select
                      value={member.role}
                      onValueChange={(v) =>
                        setHouseholdMembers((prev) =>
                          prev.map((m, i) =>
                            i === index ? { ...m, role: v as FamilyRoleValue } : m
                          )
                        )
                      }
                    >
                      <SelectTrigger id={`hm-role-${index}`}>
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

                  {cfg.fieldBirthDate && (
                    <BirthMonthYearInput
                      month={member.birthMonth}
                      year={member.birthYear}
                      onMonthChange={(v) =>
                        setHouseholdMembers((prev) =>
                          prev.map((m, i) => (i === index ? { ...m, birthMonth: v } : m))
                        )
                      }
                      onYearChange={(v) =>
                        setHouseholdMembers((prev) =>
                          prev.map((m, i) => (i === index ? { ...m, birthYear: v } : m))
                        )
                      }
                    />
                  )}

                  {cfg.fieldAgeRange && ageRanges.length > 0 && (
                    <div className="space-y-2">
                      <Label htmlFor={`hm-age-${index}`}>
                        Age Range <RequiredMark on={cfg.fieldAgeRangeRequired} />
                      </Label>
                      <Select
                        value={member.ageRangeBucketId}
                        onValueChange={(v) =>
                          setHouseholdMembers((prev) =>
                            prev.map((m, i) =>
                              i === index ? { ...m, ageRangeBucketId: v } : m
                            )
                          )
                        }
                      >
                        <SelectTrigger id={`hm-age-${index}`}>
                          <SelectValue placeholder="Select age range" />
                        </SelectTrigger>
                        <SelectContent>
                          {/* No opt-out item — see the Life Stage select above. */}
                          {ageRanges.map((r) => (
                            <SelectItem key={r.id} value={r.id}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {cfg.fieldGender && (
                    <div className="space-y-2">
                      <Label>Gender</Label>
                      <div className="flex gap-3">
                        {["Male", "Female"].map((g) => (
                          <button
                            key={g}
                            type="button"
                            onClick={() =>
                              setHouseholdMembers((prev) =>
                                prev.map((m, i) =>
                                  i === index ? { ...m, gender: m.gender === g ? "" : g } : m
                                )
                              )
                            }
                            className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                              member.gender === g
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
                </div>
              )))}

              {!cfg.familySpouseOnly && householdMembers.length < MAX_HOUSEHOLD_MEMBERS && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() =>
                    setHouseholdMembers((prev) => [...prev, { ...defaultHouseholdMember }])
                  }
                >
                  Add household member
                </Button>
              )}
            </>
          )}

          {/* ── Dietary Preferences ── */}
          {includeDietary && currentSectionKey === "dietary" && (
            <>
              <p className="text-sm text-muted-foreground">
                Let us know if you have any dietary preferences.
              </p>

              <div className="space-y-2">
                <Label>Preference</Label>
                <Select
                  value={form.dietaryPreference || "_none"}
                  onValueChange={(v) =>
                    setForm((prev) => ({
                      ...prev,
                      dietaryPreference: (v === "_none" ? "" : v) as DietaryValue,
                      dietaryOther: v === "Other" ? prev.dietaryOther : "",
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select preference" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">No restrictions</SelectItem>
                    {DIETARY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {form.dietaryPreference === "Other" && (
                <div className="space-y-2">
                  <Label htmlFor="dietaryOther">Please specify</Label>
                  <Input
                    id="dietaryOther"
                    value={form.dietaryOther}
                    onChange={(e) => set("dietaryOther", e.target.value)}
                    placeholder="e.g. Low-sodium"
                  />
                </div>
              )}
            </>
          )}

          {/* ── Payment ── */}
          {includePayment && currentSectionKey === "payment" && (
            <>
              <p className="text-sm text-muted-foreground">
                Enter your payment reference (e.g. GCash transaction ID).
              </p>

              <div className="space-y-2">
                <Label htmlFor="paymentReference">Payment reference</Label>
                <Input
                  id="paymentReference"
                  value={form.paymentReference}
                  onChange={(e) => set("paymentReference", e.target.value)}
                  placeholder="Transaction or reference number"
                />
              </div>
            </>
          )}

          {/* ── Privacy Policy ── */}
          {safeStep === sections.length && (
            <PrivacyPolicyCheckbox
              checked={privacyAccepted}
              onCheckedChange={setPrivacyAccepted}
            />
          )}

          {/* ── Navigation ── */}
          <div className="flex gap-2 pt-2">
            {safeStep > 1 ? (
              <Button type="button" variant="outline" onClick={handleBack}>
                Back
              </Button>
            ) : identifyFirst ? (
              // Step 1 used to be a one-way door: the gate handed you the form
              // and there was no way back to correct the number you typed.
              <Button
                type="button"
                variant="outline"
                onClick={handleBackToIdentify}
                disabled={submitting}
              >
                Back
              </Button>
            ) : walkIn?.backHref ? (
              <Button type="button" variant="outline" asChild>
                <Link href={walkIn.backHref}>Back</Link>
              </Button>
            ) : null}
            {safeStep < sections.length ? (
              <Button type="button" className="flex-1" disabled={submitting} onClick={handleNext}>
                {submitting ? "Please wait…" : "Next"}
              </Button>
            ) : (
              <Button type="button" className="flex-1" disabled={submitting} onClick={handleSubmit}>
                {submitting ? "Checking…" : walkIn ? "Register & Check In" : "Register"}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </FormShell>
  )
}
