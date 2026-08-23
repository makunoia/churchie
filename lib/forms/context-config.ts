import type { FormContext } from "@/app/generated/prisma/client"

/**
 * Per-(event, context) registration form configuration.
 *
 * Register / Walk-in / Check-in each control their own sections and fields. A
 * missing row means "bare" — only the mandatory identity fields (name plus
 * mobile/email), which is the default for new events. Existing events were
 * backfilled by the migration so their pre-existing behavior carried over.
 */

export const FORM_CONTEXTS = ["Register", "WalkIn", "CheckIn"] as const

export const FORM_SECTION_KEYS = [
  "sectionSmallGroup",
  "sectionBreakout",
  "sectionDietary",
  "sectionPayment",
  "sectionFamily",
] as const

export const FORM_FIELD_KEYS = [
  "fieldNickname",
  "fieldMobile",
  "fieldEmail",
  "fieldLifeStage",
  "fieldGender",
  "fieldBirthDate",
  "fieldAgeRange",
  "fieldWorkCity",
  "fieldLanguage",
  "fieldSchedule",
  "fieldMeetingPreference",
] as const

/**
 * The two fields that identify a person, of which at least one must always be
 * collected (CCF-142).
 *
 * Mobile is the app's person key — member resolution at registration and the
 * check-in/walk-in lookup are exact mobile matches — and email is the only
 * fallback the dedup path in `lib/events/registration-core.ts` knows about. A
 * form collecting neither would create a fresh Guest for someone who already
 * exists, every single time, so the config layer refuses it.
 */
export const IDENTITY_FIELD_KEYS = ["fieldMobile", "fieldEmail"] as const

/**
 * Modifiers on a section rather than sections in their own right. Persisted and
 * validated exactly like the other toggles, but rendered nested under their
 * parent section instead of as a top-level row in the builder.
 */
export const FORM_OPTION_KEYS = ["familySpouseOnly"] as const

/** Which section each option hangs off, for grouping in the builder. */
export const FORM_OPTION_PARENT: Record<FormOptionKey, FormSectionKey> = {
  familySpouseOnly: "sectionFamily",
}

export type FormSectionKey = (typeof FORM_SECTION_KEYS)[number]
export type FormFieldKey = (typeof FORM_FIELD_KEYS)[number]
export type FormOptionKey = (typeof FORM_OPTION_KEYS)[number]
export type FormToggleKey = FormSectionKey | FormFieldKey | FormOptionKey

export const FORM_TOGGLE_KEYS: readonly FormToggleKey[] = [
  ...FORM_SECTION_KEYS,
  ...FORM_FIELD_KEYS,
  ...FORM_OPTION_KEYS,
]

// ─── Required flags (CCF-142) ────────────────────────────────────────────────

/**
 * The sections that can be marked Required.
 *
 * Not all of them can, and the line is whether the section has a single stored
 * answer that is either given or blank. Dietary has `dietaryPreference` and
 * Payment has `paymentReference`; the other three don't:
 *
 *  - **Breakout** can be filled by auto-assign, so "unanswered" is satisfiable
 *    without the person ever choosing.
 *  - **Family** is legitimately empty for anyone registering alone.
 *  - **Small Group** is a tri-state intent the step already makes you answer.
 *
 * Requiring one of those would enforce something the form can meet by accident,
 * which is worse than not offering the flag at all.
 */
export const REQUIRABLE_SECTION_KEYS = ["sectionDietary", "sectionPayment"] as const
export type RequirableSectionKey = (typeof REQUIRABLE_SECTION_KEYS)[number]

/** Every toggle that can carry a Required companion. */
export type RequirableKey = FormFieldKey | RequirableSectionKey

export const REQUIRABLE_KEYS: readonly RequirableKey[] = [
  ...FORM_FIELD_KEYS,
  ...REQUIRABLE_SECTION_KEYS,
]

/**
 * The Required companion of a toggle, named `<key>Required` so the pairing is
 * mechanical rather than a lookup table anyone could forget to extend. Options
 * are excluded by construction: an option modifies a section rather than asking
 * anything.
 */
export type FormRequiredKey = `${RequirableKey}Required`

export function requiredKeyFor(key: RequirableKey): FormRequiredKey {
  return `${key}Required`
}

export const FORM_REQUIRED_KEYS: readonly FormRequiredKey[] =
  REQUIRABLE_KEYS.map(requiredKeyFor)

/** Whether this section is one of the two that can be marked Required. */
export function isRequirableSection(key: string): key is RequirableSectionKey {
  return (REQUIRABLE_SECTION_KEYS as readonly string[]).includes(key)
}

/** Every boolean column persisted on an `EventFormConfig` row. */
export const FORM_PERSISTED_KEYS: readonly (FormToggleKey | FormRequiredKey)[] = [
  ...FORM_TOGGLE_KEYS,
  ...FORM_REQUIRED_KEYS,
]

export type FormPersistedKey = FormToggleKey | FormRequiredKey

export type EventFormConfigData = Record<FormToggleKey, boolean> &
  Record<FormRequiredKey, boolean>

/**
 * What each toggle is worth when the column — or the whole row — is absent.
 *
 * Everything is off, *except* the two identity fields: they were hardcoded
 * always-on before CCF-142 made them configurable, so an event that has never
 * been configured has to keep asking for them. This is the one place that
 * knowledge lives; `pickToggles` and `BARE_EVENT_FORM_CONFIG` both read it
 * rather than restating `false`.
 */
export const FORM_TOGGLE_DEFAULTS: Record<FormPersistedKey, boolean> = Object.freeze(
  Object.fromEntries(
    FORM_PERSISTED_KEYS.map((k) => [
      k,
      (IDENTITY_FIELD_KEYS as readonly string[]).includes(k),
    ])
  ) as Record<FormPersistedKey, boolean>
)

/**
 * Whether a config would still collect something that identifies a person.
 * The guard `saveEventFormConfig` runs before writing, and what the builder
 * checks before letting the last identity checkbox be unticked.
 */
export function hasIdentityField(config: Record<string, boolean>): boolean {
  return IDENTITY_FIELD_KEYS.some((k) => config[k])
}

/**
 * The toggles whose being on proves an admin has actually configured a form.
 *
 * Row existence used to be that proof, because a new event had no rows at all.
 * `20260804000000_add_form_field_nickname` broke that: it writes a Register and a
 * Walk-in row for every event that had none, so those events keep the nickname
 * input they were already showing. Nickname is therefore the one toggle the
 * *system* can switch on by itself, and counting it would mark an untouched
 * event's form as set up.
 *
 * The same reasoning rules out anything on by default (mobile and email): a
 * toggle the system switches on for you can't be evidence that anyone chose it.
 *
 * Derived from `FORM_TOGGLE_KEYS` rather than restated, so a toggle added later
 * counts as admin intent without anyone having to remember this list.
 */
export const ADMIN_INTENT_TOGGLE_KEYS: readonly FormToggleKey[] = FORM_TOGGLE_KEYS.filter(
  (key) => key !== "fieldNickname" && !FORM_TOGGLE_DEFAULTS[key]
)

/**
 * The "bare" form: nothing optional, but still enough to tell people apart.
 * That means name (never a toggle) plus mobile and email, per
 * `FORM_TOGGLE_DEFAULTS` — everything else off, nothing required.
 */
export const BARE_EVENT_FORM_CONFIG: EventFormConfigData = Object.freeze({
  ...FORM_TOGGLE_DEFAULTS,
} as EventFormConfigData)

// ─── Success screen copy (CCF-130) ───────────────────────────────────────────

/**
 * The sub copy under "Welcome, <name>!" on the registration success screen.
 *
 * The stock copy tells people to bring a friend, which is right for an open
 * event and wrong for an invite-only one — so it's overridable per (event,
 * context) rather than hardcoded in the form. Null/blank means "use the default",
 * which keeps every existing event on exactly the copy it had before.
 *
 * Walk-in keeps its own default: someone standing at the kiosk has already
 * arrived, so inviting them to bring a friend reads oddly. Check-in never shows
 * this screen at all.
 */
export const SUCCESS_MESSAGE_MAX_LENGTH = 300

const DEFAULT_SUCCESS_MESSAGE_WITH_EVENT = (eventName: string) =>
  `You're all set for ${eventName}. We're so glad you're coming — feel free to bring a friend!`

const DEFAULT_SUCCESS_MESSAGE =
  "You're all set! We're so glad you're joining us. Feel free to bring a friend — see you soon!"

const DEFAULT_WALKIN_SUCCESS_MESSAGE = "You're registered and checked in. Enjoy the event!"

/**
 * The copy an admin sees as the starting point in the builder, and what the form
 * renders when nothing is configured.
 */
export function defaultSuccessMessage(context: FormContext, eventName?: string): string {
  if (context === "WalkIn") return DEFAULT_WALKIN_SUCCESS_MESSAGE
  return eventName
    ? DEFAULT_SUCCESS_MESSAGE_WITH_EVENT(eventName)
    : DEFAULT_SUCCESS_MESSAGE
}

/**
 * Resolve what the success screen actually shows. A stored message that is blank
 * or whitespace-only is treated as unset — clearing the textarea is how an admin
 * goes back to the default.
 */
export function resolveSuccessMessage(
  stored: string | null | undefined,
  context: FormContext,
  eventName?: string
): string {
  const trimmed = stored?.trim()
  return trimmed ? trimmed : defaultSuccessMessage(context, eventName)
}

// ─── Display metadata ────────────────────────────────────────────────────────
// Pure data only — no icons. Icons are attached client-side so nothing
// non-serializable crosses the server/client boundary.

export type FormToggleMeta = {
  key: FormToggleKey
  label: string
  description: string
}

export const FORM_SECTION_META: Record<FormSectionKey, FormToggleMeta> = {
  sectionSmallGroup: {
    key: "sectionSmallGroup",
    label: "DGroup",
    description:
      "Ask whether the person wants to join a DGroup or is already in one, and collect their matching preferences.",
  },
  sectionBreakout: {
    key: "sectionBreakout",
    label: "Breakout Group selection",
    description:
      "Let the person pick their own breakout group. Turn off to assign groups yourself or auto-assign on submit.",
  },
  sectionDietary: {
    key: "sectionDietary",
    label: "Dietary Restrictions",
    description:
      "Ask whether the person has dietary preferences (Vegetarian, Vegan, Halal, etc.).",
  },
  sectionPayment: {
    key: "sectionPayment",
    label: "Payment Reference",
    description: "Ask for a payment reference (e.g. a GCash transaction ID) on submission.",
  },
  sectionFamily: {
    key: "sectionFamily",
    label: "Family mode",
    description:
      "Let one person register their whole household in one pass. They're saved as a Family, so check-in can bring them all in together.",
  },
}

export const FORM_FIELD_META: Record<FormFieldKey, FormToggleMeta> = {
  fieldNickname: {
    key: "fieldNickname",
    label: "Nickname",
    description:
      "What the person actually goes by. Used on their name badge and to find them at check-in, where a search matches nicknames as well as legal names.",
  },
  fieldMobile: {
    key: "fieldMobile",
    label: "Mobile Number",
    description:
      "How a returning person is matched to the record they already have, here and at check-in. Turning it off means this form can only recognise someone by email.",
  },
  fieldEmail: {
    key: "fieldEmail",
    label: "Email",
    description:
      "A second way to reach someone, and the fallback for recognising a returning person when their mobile number isn't collected.",
  },
  fieldLifeStage: {
    key: "fieldLifeStage",
    label: "Life Stage",
    description: "Which life stage the person belongs to.",
  },
  fieldGender: {
    key: "fieldGender",
    label: "Gender",
    description: "Male or Female.",
  },
  fieldBirthDate: {
    key: "fieldBirthDate",
    label: "Birth Month + Year",
    description:
      "The matching engine's source of truth for age. Also helps match returning people to an existing record.",
  },
  fieldAgeRange: {
    key: "fieldAgeRange",
    label: "Age Range",
    description:
      "A coarser alternative to birth date, picked from configurable buckets. Used for matching only when birth date is absent.",
  },
  fieldWorkCity: {
    key: "fieldWorkCity",
    label: "Work City",
    description: "Where the person works — used to match nearby groups.",
  },
  fieldLanguage: {
    key: "fieldLanguage",
    label: "Language",
    description: "Languages the person is comfortable with.",
  },
  fieldSchedule: {
    key: "fieldSchedule",
    label: "Schedule / availability",
    description: "Which day and time window the person is free to meet.",
  },
  fieldMeetingPreference: {
    key: "fieldMeetingPreference",
    label: "Meeting Preference",
    description: "Online, Hybrid, or In-person.",
  },
}

export const FORM_OPTION_META: Record<FormOptionKey, FormToggleMeta> = {
  familySpouseOnly: {
    key: "familySpouseOnly",
    label: "Spouse only",
    description:
      "Ask only about a spouse, not children or other household members. Useful when the point is couples eligibility rather than a full family roster.",
  },
}

export const FORM_CONTEXT_META: Record<
  FormContext,
  { context: FormContext; label: string; description: string }
> = {
  Register: {
    context: "Register",
    label: "Register",
    description: "The public registration link people fill in ahead of the event.",
  },
  WalkIn: {
    context: "WalkIn",
    label: "Walk-in",
    description: "Registration at the door, run by staff at the check-in kiosk.",
  },
  CheckIn: {
    context: "CheckIn",
    label: "Check-in",
    description: "The attendance surface people use on the day of the event.",
  },
}

// ─── Form layout ─────────────────────────────────────────────────────────────

/**
 * Where each toggle actually lives in the public form.
 *
 * This is the **single source of truth** for the builder's shape, and it mirrors
 * the real step order of the form it configures — `sections` in
 * `app/events/[id]/register/registration-form.tsx` for Register/Walk-in, and the
 * profile step in `checkin-board.tsx` for Check-in.
 *
 * It exists because a flat list of section toggles next to a flat list of field
 * toggles tells an admin nothing about which fields appear where: five of the
 * eight fields only render inside the DGroup step, and Check-in has a different
 * shape entirely. Grouping the builder by section makes the config legible, and
 * pinning the grouping here (rather than in the component) lets tests assert it
 * against the form.
 *
 * `key: "personal"` is the identity step — always present, not toggleable, since
 * name plus mobile/email is the "bare" form.
 */
export type FormLayoutSection = {
  key: FormSectionKey | "personal"
  /** Heading as it appears to the person filling the form. */
  title: string
  description: string
  fields: readonly FormFieldKey[]
  options: readonly FormOptionKey[]
  /** Extra context shown in the builder — e.g. what a field-less section adds. */
  note?: string
}

const REGISTER_LAYOUT: readonly FormLayoutSection[] = [
  {
    key: "personal",
    title: "Personal Information",
    description: "Name is always collected. Everything else here is up to you.",
    fields: [
      "fieldNickname",
      "fieldMobile",
      "fieldEmail",
      "fieldLifeStage",
      "fieldBirthDate",
      "fieldAgeRange",
      "fieldGender",
    ],
    options: [],
  },
  {
    key: "sectionSmallGroup",
    title: "DGroup Info",
    description: FORM_SECTION_META.sectionSmallGroup.description,
    fields: ["fieldLanguage", "fieldMeetingPreference", "fieldSchedule", "fieldWorkCity"],
    options: [],
    note: "These are asked only of someone who says they're looking for a group. Life Stage moved to Personal Information, so it's asked either way.",
  },
  {
    key: "sectionBreakout",
    title: "Breakout Group",
    description: FORM_SECTION_META.sectionBreakout.description,
    fields: [],
    options: [],
    note: "Adds a step for picking a breakout group. No extra fields.",
  },
  {
    key: "sectionFamily",
    title: "Your Household",
    description: FORM_SECTION_META.sectionFamily.description,
    fields: [],
    options: ["familySpouseOnly"],
    note: "Each household member is asked for the Personal Information fields enabled above.",
  },
  {
    key: "sectionDietary",
    title: "Dietary Preferences",
    description: FORM_SECTION_META.sectionDietary.description,
    fields: [],
    options: [],
    note: "Adds a dietary preference picker, plus a free-text note when Other is chosen.",
  },
  {
    key: "sectionPayment",
    title: "Payment",
    description: FORM_SECTION_META.sectionPayment.description,
    fields: [],
    options: [],
    note: "Adds a payment reference input on the final step.",
  },
]

/**
 * Check-in has its own shape: the profile step asks every matching field directly,
 * with no DGroup dependency, and it never asks for birth date. Payment doesn't
 * apply at all (see `NOT_APPLICABLE` in the builder).
 */
const CHECKIN_LAYOUT: readonly FormLayoutSection[] = [
  {
    key: "personal",
    title: "Their details",
    description:
      "Shown when someone checks in for the first time, so their profile can be filled in.",
    fields: [
      "fieldLifeStage",
      "fieldAgeRange",
      "fieldGender",
      "fieldLanguage",
      "fieldMeetingPreference",
      "fieldSchedule",
      "fieldWorkCity",
    ],
    options: [],
  },
  {
    key: "sectionSmallGroup",
    title: "DGroup prompt",
    description: FORM_SECTION_META.sectionSmallGroup.description,
    fields: [],
    options: [],
    note: "Asked of anyone checking in who has no DGroup yet — guests, members and volunteers alike. Naming the group they're already in is guest-only. No extra fields.",
  },
  {
    key: "sectionBreakout",
    title: "Breakout Group",
    description: FORM_SECTION_META.sectionBreakout.description,
    fields: [],
    options: [],
    note: "Adds a step after the DGroup prompt for picking a breakout group, ranked from the profile we already hold, over every table that's switched on. Only offered to someone who isn't already seated — volunteers never see it. Always skippable. The kiosk places nobody automatically while this is on, so there is someone left to ask; on an event day, registration holds off too.",
  },
  {
    key: "sectionFamily",
    title: "Household check-in",
    description: FORM_SECTION_META.sectionFamily.description,
    fields: [],
    options: ["familySpouseOnly"],
    note: "Surfaces the whole household so they can be checked in together, and allows adding a member at the door.",
  },
]

export function formLayoutFor(context: FormContext): readonly FormLayoutSection[] {
  return context === "CheckIn" ? CHECKIN_LAYOUT : REGISTER_LAYOUT
}

/**
 * Every field this context's form can actually ask for.
 *
 * Check-in's shape is a strict subset — no name, nickname, birth date, mobile or
 * email, because it identifies someone who already exists rather than collecting
 * them from scratch. Required-field enforcement narrows to this list so a flag
 * set on a field the context never renders can't make its form unsubmittable.
 */
export function fieldsForContext(context: FormContext): readonly FormFieldKey[] {
  return formLayoutFor(context).flatMap((section) => section.fields)
}

/**
 * The section a field is nested under in this context, or null when it sits in the
 * always-on identity step. Derived from the layout so there is only one list.
 */
export function parentSectionFor(
  field: FormFieldKey,
  context: FormContext,
): FormSectionKey | null {
  for (const section of formLayoutFor(context)) {
    if (!section.fields.includes(field)) continue
    return section.key === "personal" ? null : section.key
  }
  return null
}

// ─── Legacy derivation ───────────────────────────────────────────────────────

export type LegacyFormToggles = {
  formIncludeSmallGroup: boolean
  formIncludeDietary: boolean
  formIncludePayment: boolean
  autoAssignBreakout: boolean
}

/**
 * The pre-CCF-119 effective behavior of a context, derived from the flat
 * `Event.formInclude*` columns. This mirrors the backfill in
 * `20260727000000_add_event_form_config` one-for-one and exists so that mapping
 * stays pinned by tests rather than living only in SQL.
 *
 * Notes on the mapping:
 *  - Register and Walk-in rendered the same component with the same props
 *    (walk-ins go through `/events/[id]/register?checkin=…`), so they match.
 *  - Birth date, Gender and Nickname were rendered unconditionally in Personal
 *    Information, independent of any toggle. Nickname only became a toggle later
 *    (`20260804000000_add_form_field_nickname`), and that migration's backfill
 *    matches the value returned here.
 *  - The matching fields only appeared inside the DGroup section.
 *  - Breakout selection had no toggle — it appeared whenever the event was not
 *    in auto-assign mode (and candidates existed, which stays a runtime check).
 *  - Check-in only surfaced the DGroup prompt + matching profile; it never
 *    collected dietary, payment, or birth date.
 *  - Mobile and email were rendered unconditionally, so they carry over on; no
 *    field was ever mandatory, so every Required flag carries over off. Both come
 *    from the spread of `BARE_EVENT_FORM_CONFIG` rather than being restated.
 */
export function deriveLegacyEventFormConfig(
  legacy: LegacyFormToggles,
  context: FormContext,
): EventFormConfigData {
  const sg = legacy.formIncludeSmallGroup
  const isCheckIn = context === "CheckIn"
  return {
    ...BARE_EVENT_FORM_CONFIG,
    sectionSmallGroup: sg,
    sectionBreakout: isCheckIn ? false : !legacy.autoAssignBreakout,
    sectionDietary: isCheckIn ? false : legacy.formIncludeDietary,
    sectionPayment: isCheckIn ? false : legacy.formIncludePayment,
    sectionFamily: false,
    fieldNickname: !isCheckIn,
    fieldLifeStage: sg,
    fieldGender: isCheckIn ? sg : true,
    fieldBirthDate: isCheckIn ? false : true,
    fieldAgeRange: false,
    fieldWorkCity: sg,
    fieldLanguage: sg,
    fieldSchedule: sg,
    fieldMeetingPreference: sg,
    familySpouseOnly: false,
  }
}
