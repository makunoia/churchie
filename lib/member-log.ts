/**
 * Display helpers for MemberLog entries, mirroring `lib/small-group-log.ts`.
 *
 * `MemberLog.action` is a bare `String` rather than a Prisma enum, so there is no
 * compile-time guarantee that a label exists for every value — `memberLogLabel`
 * falls back rather than rendering `undefined`. That fallback matters: the member
 * activity log used to *discard* `action` entirely and hardcode one kind, so every
 * row rendered as "Updated volunteer information" no matter what it recorded.
 */

export const MEMBER_LOG_ACTIONS = {
  VolunteerInfoUpdated: "VolunteerInfoUpdated",
  ProfilesMerged: "ProfilesMerged",
} as const

export type MemberLogAction = (typeof MEMBER_LOG_ACTIONS)[keyof typeof MEMBER_LOG_ACTIONS]

const LABELS: Record<MemberLogAction, string> = {
  VolunteerInfoUpdated: "Updated volunteer information",
  ProfilesMerged: "Duplicate profile merged in",
}

/** How an action reads: a gain, a loss, or neither. Drives icon and colour. */
export type MemberLogTone = "positive" | "negative" | "neutral"

const TONES: Record<MemberLogAction, MemberLogTone> = {
  VolunteerInfoUpdated: "neutral",
  // The keeper gained everything the deleted record held. Nothing about this member
  // was lost, so it isn't negative — but it is irreversible, so it isn't a plain
  // update either. Neutral, and the description carries the detail.
  ProfilesMerged: "neutral",
}

function isKnown(action: string): action is MemberLogAction {
  return action in LABELS
}

export function memberLogLabel(action: string): string {
  return isKnown(action) ? LABELS[action] : "Profile updated"
}

export function memberLogTone(action: string): MemberLogTone {
  return isKnown(action) ? TONES[action] : "neutral"
}
