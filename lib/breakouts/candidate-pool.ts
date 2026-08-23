import type { Prisma } from "@/app/generated/prisma/client"
import type { BreakoutOwner } from "./owner"

/**
 * Who is eligible to be placed into one of a day's breakout groups.
 *
 * Two rules, both scoped to the groups actually in play (`owner` — an event's
 * standing tables, or a Collab cluster's tables for the day):
 *  1. Not already seated in one of THOSE groups.
 *  2. Not a facilitator or co-facilitator of one of them (CCF-87 — they run a
 *     table, they don't sit at one).
 *
 * Note this is *not* "excludes all volunteers". A confirmed volunteer who isn't
 * facilitating a table is a normal participant and stays in the pool. The
 * breakouts list page used to exclude every confirmed volunteer while the group
 * detail page and `autoAssignBreakouts` excluded only facilitators, so the
 * "N unassigned" count disagreed with the list you could actually pick from.
 * All three now share this clause.
 *
 * Deliberately not scoped by `volunteers.status`: a Pending or Rejected
 * volunteer who is still attached as a facilitator is excluded too. That was the
 * pre-existing behaviour and changing it is a separate decision.
 *
 * ## Why rule 1 is owner-scoped rather than global (CCF-148)
 *
 * It used to read `breakoutGroupMemberships: { none: {} }` — "in no breakout
 * group anywhere". That was harmless while every group belonged to an event,
 * because an `EventRegistrant` row belongs to exactly one event and only that
 * event's groups could ever hold it, making the global form and the event-scoped
 * form equivalent.
 *
 * Cluster-owned groups break that equivalence, and badly. `EventRegistrant` is
 * one row per person per event *series*, not per occurrence, so a member who
 * attends a ministry's recurring event every week has a single long-lived
 * registrant row — and that row is already seated in one of that ministry's
 * standing tables. Under the global clause, every single regular would be
 * excluded from the collab day's tables: the people the day is actually for.
 *
 * Scoping to the owner asks the question the caller means — "is this person
 * already seated at one of the tables I am filling" — and leaves their standing
 * placement alone.
 *
 * ## Why it takes a where-input and not only an owner
 *
 * Most callers are filling exactly one set and pass a bare {@link BreakoutOwner},
 * which is itself a valid group filter. Catch Mech is the exception: on a Collab
 * day "already seated" spans the event's own tables *and* the day's, so it passes
 * `CatchMechScope.seatedWhere` — an `OR` over the two. Narrowing the parameter to
 * one owner there would report everyone at a cluster table as unseated.
 */
export function unassignedCandidateWhere(
  owner: BreakoutOwner | Prisma.BreakoutGroupWhereInput
): Prisma.EventRegistrantWhereInput {
  return {
    breakoutGroupMemberships: { none: { breakoutGroup: owner } },
    NOT: {
      member: {
        volunteers: {
          some: {
            OR: [
              { facilitatedGroups: { some: owner } },
              { coFacilitatedGroups: { some: owner } },
            ],
          },
        },
      },
    },
  }
}

/**
 * The other half of eligibility: which *groups* may still receive someone
 * without an admin explicitly putting them there.
 *
 * Spelled as a shared constant because it has to hold identically in three
 * queries that otherwise share nothing — the public/walk-in picker
 * (`fetchBreakoutCandidates`), the scorer (`matchBreakoutGroups`) and the
 * registration write (`assignBreakoutForRegistrant`). A group that is off in one
 * of them and on in another is the bug this prevents.
 *
 * Deliberately *not* applied to the admin add/transfer paths: switching a group
 * off aims at the automatic and public routes, not at staff judgment.
 */
export const ENABLED_BREAKOUT_WHERE = { isEnabled: true } as const satisfies Prisma.BreakoutGroupWhereInput

/**
 * Groups the system may place someone in *on its own* — enabled, and not held
 * back for manual assignment.
 *
 * The stricter sibling of `ENABLED_BREAKOUT_WHERE`, for a query that feeds a
 * suggestion with no browse list beside it. Only `matchBreakoutGroups` qualifies:
 * every one of its callers is an automatic or suggestion surface (the admin match
 * card, the kiosk's auto-assign, the bulk assign-all), and none of them offers
 * the admin a full list of tables to pick from afterwards.
 *
 * The candidate-loading queries in `breakout-suggestion-server` deliberately do
 * NOT use this. There one loaded set feeds both the suggester and the dropdown,
 * so `manualAssignOnly` is applied per-function inside `isEligible` instead —
 * filtering it in SQL would take the group out of the browse list too, which is
 * what `isEnabled` already does and what this setting exists to avoid.
 */
export const AUTO_ASSIGNABLE_BREAKOUT_WHERE = {
  ...ENABLED_BREAKOUT_WHERE,
  manualAssignOnly: false,
} as const satisfies Prisma.BreakoutGroupWhereInput
