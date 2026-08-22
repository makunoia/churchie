import "server-only"

import { db } from "@/lib/db"
import { ClusterKind } from "@/app/generated/prisma/client"
import {
  breakoutPickerReadiness,
  clusterBreakoutPickerReadiness,
} from "@/lib/breakout-suggestion-server"
import { getClusterFormConfig } from "./context-config-server"
import type { TogglePrerequisites } from "./form-prerequisites"

/**
 * Warnings for toggles that are on but cannot render for lack of data elsewhere.
 *
 * Every one of these was previously invisible: the builder showed a switch in the
 * "on" position and the form quietly rendered one section or field short. The
 * whole point is that the admin finds out here rather than at the door.
 */

/**
 * Gaps that apply to any form surface, event or cluster, because life stages and
 * age range buckets are global settings rather than per-event data.
 */
async function globalFieldPrerequisites(): Promise<TogglePrerequisites> {
  const [lifeStageCount, ageRangeCount] = await Promise.all([
    db.lifeStage.count(),
    db.ageRangeBucket.count(),
  ])

  const prerequisites: TogglePrerequisites = {}
  if (lifeStageCount === 0) {
    prerequisites.fieldLifeStage = {
      message:
        "No life stages exist yet, so this field is skipped. Add them in Settings → Life Stages.",
    }
  }
  if (ageRangeCount === 0) {
    prerequisites.fieldAgeRange = {
      message:
        "No age ranges exist yet, so this field is skipped. Add them in Settings → Age Ranges.",
    }
  }
  return prerequisites
}

/**
 * The cluster's shared form.
 *
 * Only a Collab day owns breakout tables, so only a Collab has a Breakout step to
 * warn about — a Parallel day hides the toggle entirely and gets the global gaps
 * alone.
 *
 * Five reasons a Collab's enabled Breakout step can still come to nothing, ordered
 * most- to least-decisive so the admin is given one thing to fix. The middle two
 * have no per-event counterpart: a cluster config is one form, but the write it
 * drives lands on whichever member event the person's ministry names, and that
 * event carries the module switch and the auto-assign flag.
 */
export async function clusterFormPrerequisites(
  clusterId: string,
  kind: ClusterKind
): Promise<TogglePrerequisites> {
  const globals = await globalFieldPrerequisites()
  if (kind !== ClusterKind.Collab) return globals

  const [
    {
      totalGroups,
      enabledGroups,
      staffedGroups,
      genderedGroups,
      eventsWithoutBreakoutModule,
      eventsAutoAssigning,
    },
    checkInConfig,
  ] = await Promise.all([
    clusterBreakoutPickerReadiness(clusterId),
    getClusterFormConfig(clusterId, "CheckIn"),
  ])

  /**
   * Whether the day's kiosk asks about tables — which is what decides who gets
   * placed automatically at registration.
   *
   * With it on, the shared form deliberately leaves people unseated so the kiosk
   * has someone to ask (`deferBreakoutToCheckin` in `registerForCluster`), so the
   * auto-assign warning below would describe the opposite of what happens.
   */
  const asksAtCheckin = checkInConfig.sectionBreakout

  const prerequisites: TogglePrerequisites = { ...globals }

  // The day has no auto-assign flag of its own — each member event carries one,
  // and `eventsAutoAssigning` is already the list of those that do. Any one of
  // them means somebody is being placed without choosing, which is the wording
  // that matters.
  Object.assign(
    prerequisites,
    genderFieldPrerequisite(genderedGroups, eventsAutoAssigning.length > 0)
  )

  if (totalGroups === 0) {
    prerequisites.sectionBreakout = {
      message:
        "This event day has no breakout groups yet, so the step won't appear. Create one in Breakouts, or carry a member event's over.",
    }
  } else if (enabledGroups === 0) {
    prerequisites.sectionBreakout = {
      message: `All ${totalGroups} of this event day's breakout group${
        totalGroups === 1 ? " is" : "s are"
      } switched off, so there is nothing to offer and the step won't appear. Switch one on in Breakouts.`,
    }
  } else if (eventsWithoutBreakoutModule.length > 0) {
    // The quietest failure of the lot: the pick is accepted by the form and then
    // dropped at the write, because placement is gated on the registrant's own
    // event having the module rather than on the day owning the table.
    prerequisites.sectionBreakout = {
      message: `${listNames(eventsWithoutBreakoutModule)} ${
        eventsWithoutBreakoutModule.length === 1 ? "doesn't have" : "don't have"
      } Breakout Groups switched on, so anyone routed to ${
        eventsWithoutBreakoutModule.length === 1 ? "that ministry" : "those ministries"
      } will have their choice ignored. Enable the module in that event's Settings → Modules.`,
    }
  } else if (eventsAutoAssigning.length > 0 && !asksAtCheckin) {
    prerequisites.sectionBreakout = {
      message: `${listNames(eventsAutoAssigning)} ${
        eventsAutoAssigning.length === 1 ? "places" : "place"
      } people into a breakout group on submit. A choice made here still wins, but anyone who skips the step is placed for them.`,
    }
  } else if (staffedGroups === 0) {
    // The door only — see the per-event chain for why the kiosk isn't named.
    prerequisites.sectionBreakout = {
      message: `At the door, people only see groups whose facilitator has checked in, and none of the ${enabledGroups} breakout group${
        enabledGroups === 1 ? " has" : "s have"
      } a facilitator assigned — so this step won't appear there. Assign facilitators in Breakouts.`,
      contexts: ["WalkIn"],
    }
  }

  return prerequisites
}

/**
 * The Gender field's warning, which is the one that fires while its switch is
 * **off** (`whenOff`).
 *
 * It sits outside the `sectionBreakout` chain above on purpose. That chain
 * answers one question — "why won't the Breakout step appear?" — and returns a
 * single most-decisive fix. This is a different question about a different
 * toggle: the step appears fine, but placement quietly runs on less information
 * than it could. Folding it into the chain would let "all your groups are
 * switched off" mask it, or vice versa.
 *
 * A gendered table is never suggested to someone whose gender we don't hold
 * (`isEligible`), so with the field off those tables simply drop out and life
 * stage becomes the deciding signal instead (`comparatorFor`). That's a
 * reasonable fallback and not an error — hence a warning that names the trade,
 * rather than one that demands a fix.
 */
function genderFieldPrerequisite(
  genderedGroups: number,
  autoAssignBreakout: boolean
): TogglePrerequisites {
  if (genderedGroups === 0) return {}

  const groups = `${genderedGroups} breakout group${genderedGroups === 1 ? "" : "s"}`
  // Auto-assign is the sharper failure: nobody chose the placement, so there is
  // no one to notice it didn't happen.
  const message = autoAssignBreakout
    ? `${groups} here ${genderedGroups === 1 ? "is" : "are"} for one gender. Without this field nobody can be placed into ${genderedGroups === 1 ? "it" : "them"} automatically — people are matched on life stage instead.`
    : `${groups} here ${genderedGroups === 1 ? "is" : "are"} for one gender, so ${genderedGroups === 1 ? "it is" : "they are"} never suggested to someone who wasn't asked. People are matched on life stage instead, and can still pick a group themselves.`

  return { fieldGender: { message, whenOff: true } }
}

/** "A", "A and B", "A, B and C" — for naming the member events at fault. */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/**
 * An event's form, including the four separate reasons its Breakout step can be
 * enabled and still never appear. They are mutually exclusive and ordered most-
 * to least-decisive, so the admin gets the one thing to fix rather than a list.
 */
export async function eventFormPrerequisites(
  eventId: string,
  autoAssignBreakout: boolean
): Promise<TogglePrerequisites> {
  const [globals, { totalGroups, enabledGroups, staffedGroups, genderedGroups }] = await Promise.all([
    globalFieldPrerequisites(),
    breakoutPickerReadiness(eventId),
  ])

  const prerequisites: TogglePrerequisites = { ...globals }

  Object.assign(prerequisites, genderFieldPrerequisite(genderedGroups, autoAssignBreakout))

  if (autoAssignBreakout) {
    // Still true of the kiosk on a single event, and worth saying there: it
    // withholds its own automatic placement while this section is on, but by then
    // anyone who pre-registered or came through the door was already placed at
    // submit, so the step finds them seated and skips. A cluster day is where that
    // now differs — see `clusterFormPrerequisites`.
    prerequisites.sectionBreakout = {
      message:
        "Auto-assign is on, so people are placed into a breakout group on submit and never see this step. Switch to manual below to let them choose.",
    }
  } else if (totalGroups === 0) {
    prerequisites.sectionBreakout = {
      message:
        "This event has no breakout groups yet, so the step won't appear. Create one in Breakouts.",
    }
  } else if (enabledGroups === 0) {
    // Distinct from "no groups": the fix is a switch, not a new group.
    prerequisites.sectionBreakout = {
      message: `All ${totalGroups} of this event's breakout group${
        totalGroups === 1 ? " is" : "s are"
      } switched off, so there is nothing to offer and the step won't appear. Switch one on in Breakouts.`,
    }
  } else if (staffedGroups === 0) {
    // The door only. It hands someone over to a table, so an unstaffed one is a
    // handover to nobody. The kiosk was named here too and shouldn't have been:
    // it offers every enabled group ungated, exactly as the registration form
    // does, because a table whose host hasn't arrived yet is the ordinary state
    // of the first half hour.
    prerequisites.sectionBreakout = {
      message: `At the door, people only see groups whose facilitator has checked in, and none of the ${enabledGroups} breakout group${
        enabledGroups === 1 ? " has" : "s have"
      } a facilitator assigned — so this step won't appear there. Assign facilitators in Breakouts.`,
      contexts: ["WalkIn"],
    }
  }

  return prerequisites
}
