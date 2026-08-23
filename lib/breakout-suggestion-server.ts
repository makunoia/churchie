import "server-only"

import type { Prisma } from "@/app/generated/prisma/client"
import { db } from "@/lib/db"
import type { BreakoutCandidate } from "@/lib/breakout-suggestion"
import {
  AUTO_ASSIGNABLE_BREAKOUT_WHERE,
  ENABLED_BREAKOUT_WHERE,
} from "@/lib/breakouts/candidate-pool"
import { breakoutOccupancy } from "@/lib/breakouts/occupancy"
import { deriveEffectiveGenderFocus } from "@/lib/breakouts/gender-focus"
import { resolvePoolScope, resolveSurfaceBreakoutOwner } from "@/lib/events/pool-scope"
import type { BreakoutOwner, BreakoutSet } from "@/lib/breakouts/owner"

/**
 * The facilitator gate: a breakout group is only offered at a staffed surface
 * (the walk-in kiosk) once someone who runs it is actually in the room.
 *
 * "In the room" means checked in on the volunteer lane — see below; reading only
 * the registrant lane is what made this gate hold every group back forever.
 *
 * Note that every branch requires a facilitator relation to exist, so a group
 * with `facilitatorId` and `coFacilitatorId` both null matches nothing and is
 * never offered. That is deliberate — an unstaffed group has nobody to hand the
 * walk-in over to. It is also the single most confusing thing about this query,
 * which is why `breakoutPickerReadiness` exists to surface it to admins.
 */
function facilitatorGate(
  eventIds: string[],
  occurrenceId: string | null
): Prisma.BreakoutGroupWhereInput {
  // A facilitator is checked in *as a volunteer*. The kiosk resolves them to
  // their `Volunteer` row and records attendance there — an `OccurrenceAttendee`
  // carrying `volunteerId` for session events, `Volunteer.attendedAt` for
  // OneTime (`recordCheckinAttendance`). This is the lane that actually fills.
  const volunteerCheckedIn: Prisma.VolunteerWhereInput =
    occurrenceId !== null
      ? { occurrenceAttendances: { some: { occurrenceId } } }
      : { attendedAt: { not: null } }

  // The registrant lane, kept as a fallback rather than replaced. It is the only
  // thing this gate used to look at, which is the bug: `OccurrenceAttendee`
  // holds *either* a registrantId or a volunteerId and a volunteer is never a
  // registrant, so a facilitator who checked in normally never matched and every
  // group stayed held back forever. Events where a facilitator happens to also
  // hold an EventRegistrant row (hand-added, or imported) still pass.
  const registrantCheckedIn: Prisma.VolunteerWhereInput =
    occurrenceId !== null
      ? {
          member: {
            eventRegistrations: {
              some: {
                eventId: { in: eventIds },
                occurrenceAttendances: { some: { occurrenceId } },
              },
            },
          },
        }
      : {
          member: {
            eventRegistrations: {
              some: { eventId: { in: eventIds }, attendedAt: { not: null } },
            },
          },
        }

  const checkedIn: Prisma.VolunteerWhereInput = {
    OR: [volunteerCheckedIn, registrantCheckedIn],
  }

  return {
    OR: [
      { facilitator: checkedIn },
      { coFacilitator: checkedIn },
      // Per-occurrence stand-ins only — there is no such thing for OneTime.
      //
      // Deliberately the one branch that does NOT require a check-in, and it
      // reads like a bug until you see why (CCF-76 pins it): naming a stand-in
      // is a manual act an admin takes on the session screen, in the moment,
      // about a group they can see. That is explicit human intent, and intent
      // outranks the gate here for the same reason it does at the door — where
      // an explicit breakout pick is honoured while automatic placement is not.
      // The gate exists to stop people being sent somewhere *nobody chose*.
      //
      // Don't "fix" this to require attendance without changing CCF-76 first.
      ...(occurrenceId !== null
        ? [{ subFacilitators: { some: { occurrenceId } } } as const]
        : []),
    ],
  }
}

/**
 * The same gate across several sessions at once.
 *
 * A cluster's shared form has no single occurrence: a Collab day links one session
 * per member event, and a OneTime member event links none at all (its facilitators
 * check in on `Volunteer.attendedAt` instead). Rather than teach `facilitatorGate`
 * about lists — which would fork the two lanes it already balances — this ORs one
 * copy of it per distinct session. A day mixing a OneTime and a Recurring event
 * therefore gets exactly the two expressions its two member events would each have
 * produced on their own door.
 *
 * An empty list means "no session named", which is the `null` gate on its own.
 */
export function facilitatorGateForOccurrences(
  eventIds: string[],
  occurrenceIds: readonly (string | null)[]
): Prisma.BreakoutGroupWhereInput {
  const distinct = [...new Set(occurrenceIds)]
  if (distinct.length <= 1) return facilitatorGate(eventIds, distinct[0] ?? null)
  return { OR: distinct.map((occurrenceId) => facilitatorGate(eventIds, occurrenceId)) }
}

/**
 * The one place a `BreakoutGroup` row becomes a `BreakoutCandidate`.
 *
 * Shared by the per-event read and the cluster read so the select, the effective
 * gender focus and the occupancy derivation stay written once — a candidate that
 * means something different depending on which surface loaded it is exactly the
 * drift `ENABLED_BREAKOUT_WHERE` exists to prevent on the other axis.
 */
/**
 * Put capped and uncapped groups on one fullness scale, so the picker can order
 * a mixed set by how much room each has left.
 *
 * A capped group's load is simply its fill ratio, which is what makes a 20-seat
 * table take four people for every one a 5-seat table takes rather than the two
 * of them racing to the same headcount.
 *
 * An uncapped group has no denominator of its own, so it borrows one:
 *  - the mean cap of the capped groups it is being offered beside, when there
 *    are any — an unsized table is assumed to be about as big as the sized ones;
 *  - otherwise the largest headcount in the set, which normalises to 0..1
 *    without any absolute figure escaping. When *nothing* is capped — the common
 *    shape of a collab day — this is the whole of the ordering, and it is
 *    exactly right: every table is the same notional size, so the one with the
 *    fewest people is the one with the most room.
 *
 * An empty set of groups, or a set where nobody has been placed yet, yields 0
 * for everyone: no group is fuller than any other, and specificity decides.
 */
export function resolveFillLevels(
  rows: { memberCount: number; memberLimit: number | null }[]
): number[] {
  const caps = rows
    .map((r) => r.memberLimit)
    .filter((c): c is number => c !== null && c > 0)
  const meanCap = caps.length > 0 ? caps.reduce((a, b) => a + b, 0) / caps.length : null
  const maxCount = rows.reduce((m, r) => Math.max(m, r.memberCount), 0)

  return rows.map(({ memberCount, memberLimit }) => {
    if (memberLimit !== null && memberLimit > 0) return memberCount / memberLimit
    if (meanCap !== null) return Math.min(1, memberCount / meanCap)
    return maxCount > 0 ? memberCount / maxCount : 0
  })
}

async function loadCandidates(
  where: Prisma.BreakoutGroupWhereInput
): Promise<BreakoutCandidate[]> {
  const groups = await db.breakoutGroup.findMany({
    where,
    // `id` breaks the tie, and the tie is common: `createdAt` is a
    // `TIMESTAMP(3)`, so tables created in one go — a carry-over, an import, an
    // admin adding three in a row — routinely share a millisecond. Without a
    // second key Postgres returns those in whatever order it likes, and the
    // ranking rests on this: fill level and specificity decide most of the list,
    // but everything still level after that falls through to declaration order,
    // which is exactly the case on a day whose tables are all empty and all
    // alike. The suggestion would then differ between two identical requests.
    // cuid is monotonic within a process, so `id` asc *is* declaration order.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      genderFocus: true,
      // The picker filters on life stage the way it filters on gender, so the
      // public form needs the group's accepted stages just as the admin
      // surfaces do. Empty means "accepts everyone".
      lifeStages: { select: { id: true } },
      ageRangeMin: true,
      ageRangeMax: true,
      memberLimit: true,
      // Selected, never filtered on: the group has to reach the browse list, and
      // only `isEligible` — the suggester's half — turns it away. Filtering here
      // would make it behave exactly like `isEnabled: false`.
      manualAssignOnly: true,
      _count: { select: { members: true } },
      // Not for display — a group's gender focus is often left blank and implied
      // by who runs it, and both the picker and the suggester have to see the
      // same focus the admin surfaces do. See `deriveEffectiveGenderFocus`.
      facilitator: { select: { member: { select: { gender: true } } } },
      coFacilitator: { select: { member: { select: { gender: true } } } },
      linkedSmallGroup: { select: { genderFocus: true } },
    },
  })

  const occupancies = groups.map((g) =>
    breakoutOccupancy({ memberCount: g._count.members, memberLimit: g.memberLimit })
  )
  // Computed across the whole set rather than per row — a group's fullness only
  // means anything next to the groups it is offered beside.
  const fillLevels = resolveFillLevels(
    occupancies.map((o) => ({ memberCount: o.memberCount, memberLimit: o.memberLimit }))
  )

  return groups.map((g, i) => {
    const occupancy = occupancies[i]
    return {
      id: g.id,
      name: g.name,
      genderFocus: deriveEffectiveGenderFocus(
        g.genderFocus,
        g.facilitator?.member.gender,
        g.coFacilitator?.member.gender,
        g.linkedSmallGroup?.genderFocus
      ),
      lifeStageIds: g.lifeStages.map((ls) => ls.id),
      ageRangeMin: g.ageRangeMin,
      ageRangeMax: g.ageRangeMax,
      isFull: occupancy.isFull,
      fillLevel: fillLevels[i],
      manualAssignOnly: g.manualAssignOnly,
      occupancy: { memberCount: occupancy.memberCount, memberLimit: occupancy.memberLimit },
    }
  })
}

export async function fetchBreakoutCandidates(
  eventId: string,
  occurrenceId: string | null,
  requireCheckedIn = true,
  breakoutSet: BreakoutSet = "event"
): Promise<BreakoutCandidate[]> {
  // Keeps taking an event id: every caller is a public or per-event surface that
  // knows which event it is serving. On a Collab day that event has two sets in
  // play, so the surface names which — its own by default, the day's when a
  // cluster form or kiosk is asking.
  const { candidateEventIds } = await resolvePoolScope(eventId)
  const owner = await resolveSurfaceBreakoutOwner(eventId, breakoutSet)

  return loadCandidates({
    ...owner,
    ...ENABLED_BREAKOUT_WHERE,
    ...(requireCheckedIn ? facilitatorGate(candidateEventIds, occurrenceId) : {}),
  })
}

export type BreakoutAvailability = {
  candidates: BreakoutCandidate[]
  /**
   * The event's *enabled* breakout groups, before the facilitator gate.
   *
   * Switched-off groups are excluded because this number exists to explain an
   * empty picker to a member of the public, and "your table hosts haven't
   * arrived yet" is the wrong explanation when an admin has deliberately taken
   * every group out of play. Counting only enabled groups makes an all-off event
   * indistinguishable from an event with no groups — which is what off means on
   * a public route. The admin-side `breakoutPickerReadiness` keeps the ungated
   * count instead, because there the difference is the whole point.
   */
  totalGroups: number
}

/**
 * `fetchBreakoutCandidates` plus the enabled group count.
 *
 * Rendering surfaces need both to tell two very different empty states apart:
 * "this event has nothing to offer" (nothing to say — drop the step) versus
 * "it has groups but none is staffed right now" (say so — the person at the
 * kiosk is otherwise looking at a step that silently vanished).
 */
export async function fetchBreakoutAvailability(
  eventId: string,
  occurrenceId: string | null,
  requireCheckedIn = true,
  breakoutSet: BreakoutSet = "event"
): Promise<BreakoutAvailability> {
  const owner = await resolveSurfaceBreakoutOwner(eventId, breakoutSet)
  const [candidates, totalGroups] = await Promise.all([
    fetchBreakoutCandidates(eventId, occurrenceId, requireCheckedIn, breakoutSet),
    db.breakoutGroup.count({ where: { ...owner, ...ENABLED_BREAKOUT_WHERE } }),
  ])
  return { candidates, totalGroups }
}

/**
 * The cluster counterpart of {@link fetchBreakoutAvailability} (CCF-148).
 *
 * A Collab day's tables belong to the CLUSTER, so there is no event id to resolve
 * a scope from — the owner is the cluster itself and the candidate events are its
 * members. `occurrenceIds` carries the session each member event's link names, and
 * is what makes the door's facilitator gate answerable across a day that may hold
 * one OneTime and one Recurring event at the same time.
 *
 * Only a Collab owns tables, so a Parallel cluster comes back empty rather than
 * erroring: `resolveBreakoutNotice` then drops the step, which is exactly right.
 */
export async function fetchClusterBreakoutAvailability(
  clusterId: string,
  opts: { occurrenceIds: readonly (string | null)[]; requireCheckedIn: boolean }
): Promise<BreakoutAvailability> {
  const owner = { clusterId }
  const links = await db.eventClusterEvent.findMany({
    where: { clusterId },
    select: { eventId: true },
  })
  const candidateEventIds = links.map((l) => l.eventId)

  const [candidates, totalGroups] = await Promise.all([
    loadCandidates({
      ...owner,
      ...ENABLED_BREAKOUT_WHERE,
      ...(opts.requireCheckedIn
        ? facilitatorGateForOccurrences(candidateEventIds, opts.occurrenceIds)
        : {}),
    }),
    db.breakoutGroup.count({ where: { ...owner, ...ENABLED_BREAKOUT_WHERE } }),
  ])
  return { candidates, totalGroups }
}

export type BreakoutPickerReadiness = {
  totalGroups: number
  /** Of those, the ones still switched on — a disabled group is never offered. */
  enabledGroups: number
  /**
   * Enabled groups with a facilitator or co-facilitator assigned — the rest can
   * never pass the gate.
   */
  staffedGroups: number
  /**
   * Enabled groups the system may place someone into by itself — the rest are
   * held back for manual assignment.
   *
   * Separate from `enabledGroups` because `manualAssignOnly` splits the two
   * halves `isEnabled` moves together: a held-back table is still offered in
   * every dropdown, so it counts toward "is there anything to show", and never
   * suggested, so it counts for nothing toward "will auto-assign place anyone".
   * With auto-assign on and this at zero, the step is suppressed and the
   * placement it was suppressed in favour of never happens.
   */
  autoAssignableGroups: number
  /**
   * Enabled groups whose **effective** focus is Male or Female — the ones that
   * can never be suggested to someone whose gender the form didn't ask for.
   *
   * Deliberately not a `count`: the focus is usually *implied* by who runs the
   * table rather than set on it, so this has to go through
   * `deriveEffectiveGenderFocus` exactly as `loadCandidates` does. A count on the
   * `genderFocus` column alone would report zero for the very events where the
   * problem is worst.
   */
  genderedGroups: number
}

async function pickerReadinessFor(
  owner: BreakoutOwner
): Promise<BreakoutPickerReadiness> {
  const [totalGroups, enabledGroups, staffedGroups, autoAssignableGroups, enabled] = await Promise.all([
    db.breakoutGroup.count({ where: owner }),
    db.breakoutGroup.count({ where: { ...owner, ...ENABLED_BREAKOUT_WHERE } }),
    db.breakoutGroup.count({
      where: {
        ...owner,
        ...ENABLED_BREAKOUT_WHERE,
        OR: [{ facilitatorId: { not: null } }, { coFacilitatorId: { not: null } }],
      },
    }),
    // The same clause `matchBreakoutGroups` scores over, so the warning and the
    // matcher can't disagree about what is placeable.
    db.breakoutGroup.count({ where: { ...owner, ...AUTO_ASSIGNABLE_BREAKOUT_WHERE } }),
    db.breakoutGroup.findMany({
      where: { ...owner, ...ENABLED_BREAKOUT_WHERE },
      select: {
        genderFocus: true,
        facilitator: { select: { member: { select: { gender: true } } } },
        coFacilitator: { select: { member: { select: { gender: true } } } },
        linkedSmallGroup: { select: { genderFocus: true } },
      },
    }),
  ])

  const genderedGroups = enabled.filter((g) => {
    const focus = deriveEffectiveGenderFocus(
      g.genderFocus,
      g.facilitator?.member.gender,
      g.coFacilitator?.member.gender,
      g.linkedSmallGroup?.genderFocus
    )
    return focus === "Male" || focus === "Female"
  }).length

  return { totalGroups, enabledGroups, staffedGroups, autoAssignableGroups, genderedGroups }
}

/**
 * Admin-side counterpart to the gate: what the form builder needs in order to
 * warn that an enabled Breakout step will not actually render.
 *
 * "Staffed" here means *assigned*, not checked in — check-in is a runtime fact
 * that changes during the event, whereas an unstaffed group is a standing
 * configuration problem the admin can fix now.
 *
 * Three figures rather than two because switching groups off is a third way to
 * empty the picker, and it has a different fix from the other two. `totalGroups`
 * stays deliberately ungated so "you have no groups" and "you have groups but
 * they're all off" can be told apart.
 */
export async function breakoutPickerReadiness(
  eventId: string
): Promise<BreakoutPickerReadiness> {
  const { breakoutOwner: owner } = await resolvePoolScope(eventId)
  return pickerReadinessFor(owner)
}

export type ClusterBreakoutPickerReadiness = BreakoutPickerReadiness & {
  /**
   * Member events without the Breakout module, by name.
   *
   * The quietest way a cluster picker fails. `assignBreakoutForRegistrant` gates
   * on the *registrant's own event* having the module — the day owning the table
   * isn't enough — so on a Collab a person routed to such an event loses their
   * pick with no error anywhere. The admin can only find that out here.
   */
  eventsWithoutBreakoutModule: string[]
  /** Member events placing people on submit, by name. */
  eventsAutoAssigning: string[]
}

/**
 * Admin-side counterpart to the gate for a cluster's shared form.
 *
 * The three counts mean what they do for an event, over the cluster's own tables.
 * The two name lists are the part that has no per-event equivalent: a cluster
 * config is one form, but the write it drives happens against whichever member
 * event the person's ministry names, and that event carries the module switch and
 * the auto-assign flag.
 */
export async function clusterBreakoutPickerReadiness(
  clusterId: string
): Promise<ClusterBreakoutPickerReadiness> {
  const [counts, links] = await Promise.all([
    pickerReadinessFor({ clusterId }),
    db.eventClusterEvent.findMany({
      where: { clusterId },
      orderBy: { order: "asc" },
      select: {
        event: {
          select: {
            name: true,
            autoAssignBreakout: true,
            modules: { where: { type: "Breakout" }, select: { id: true }, take: 1 },
          },
        },
      },
    }),
  ])

  return {
    ...counts,
    eventsWithoutBreakoutModule: links
      .filter((l) => l.event.modules.length === 0)
      .map((l) => l.event.name),
    eventsAutoAssigning: links
      .filter((l) => l.event.autoAssignBreakout)
      .map((l) => l.event.name),
  }
}
