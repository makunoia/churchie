# Churchie — Project Reference

## What This Is
Church management web app for administrators. Six domains: **Members**, **Guests**, **Small Groups**, **Ministries**, **Events**, **Volunteers**.

---

## Tech Stack

| Concern | Choice |
|---|---|
| Framework | Next.js (App Router) + TypeScript |
| Database | PostgreSQL |
| ORM | Prisma 7 (client at `app/generated/prisma/`, driver adapter `PrismaPg`) |
| Auth | NextAuth.js (Auth.js v5) |
| Styling | Tailwind CSS v4 |
| UI Components | shadcn/ui |
| Validation | Zod |
| Package manager | pnpm |

---

## User Roles

| Role | Access |
|---|---|
| **Super Admin** | Full access to all data and settings |
| **Staff** | Scoped access — granted per `FeatureArea` (Members, Guests, SmallGroups, Ministries, Events, Volunteers) and per `UserEventAccess` (specific events) |

No member self-service portal. Staff users see only permitted nav items; Settings is Super Admin only. Access controlled via `UserPermission { userId, feature: FeatureArea }` and `UserEventAccess { userId, eventId }`.

---

## Domain Model

### Member
Created when a Guest joins a Small Group (auto-promoted) or added directly by admin.

**Fields:** `id`, `firstName`, `lastName`, `email`, `phone`, `address`, `dateJoined`, `notes`, `createdAt`, `updatedAt`

**Matching fields:** `lifeStageId → LifeStage?`, `gender (Male|Female)?`, `language[]`, `birthMonth Int?`, `birthYear Int?`, `workCity?`, `workIndustry?`, `meetingPreference (Online|Hybrid|InPerson)?`, `SchedulePreference[] { dayOfWeek, timeStart, timeEnd }`

**Relationships:**
- Leads one or more `SmallGroup` (`SmallGroup.leaderId`)
- Belongs to **at most one** SmallGroup via `Member.smallGroupId`
- `groupStatus MemberGroupStatus? (Member|Timothy|Leader)` — null when not in a group; set on join
- `lifeStageId → LifeStage?`
- `eventRegistrations EventRegistrant[]`
- `guest Guest?` — set if promoted from a Guest

---

### Guest
Non-member who attended an event. Entry point into the discipleship pipeline. **Every non-member registrant becomes a Guest** regardless of event type.

**Fields:** `id`, `firstName`, `lastName`, `email`, `phone`, `notes`, `createdAt`, `updatedAt`

**Matching fields:** same set as Member (see above, minus address/dateJoined).

**Additional fields:** `scheduleDayOfWeek Int?` (0=Sun…6=Sat), `scheduleTimeStart String?` (HH:MM — single schedule slot), `claimedSmallGroupId → SmallGroup?` — self-reported group from check-in prompt.

**Promotion to Member:** When added to a Small Group → creates `Member` (`dateJoined = today`), sets `Member.smallGroupId`, sets `Guest.memberId`, updates all `EventRegistrant` records to point to new Member. Guest record is retained for history; promoted guests leave the active guest list.

**Relationships:** `eventRegistrations EventRegistrant[]`, `memberId → Member? (unique)` — null = still active guest.

---

### SmallGroup
Unlimited-depth network of member-led groups. A leader is simultaneously a member of another group (upward accountability).

**Fields:** `id`, `name`, `leaderId → Member`, `parentGroupId → SmallGroup?`, `createdAt`, `updatedAt`

**Matching fields:** `lifeStageId → LifeStage?` (null = accepts all), `genderFocus (Male|Female|Mixed)?`, `language[]`, `ageRangeMin Int?`, `ageRangeMax Int?`, `meetingFormat (Online|Hybrid|InPerson)?`, `locationCity?`, `memberLimit Int?`, `scheduleDayOfWeek Int?` (0=Sun…6=Sat), `scheduleTimeStart String?` (HH:MM — single meeting slot)

**Other fields:** `leaderConfirmationToken String? (unique)` — public confirmation link token for the group leader.

**Rules:** One SmallGroup per member at a time. `parentGroupId` links leader's own membership upward. No max depth. Prevent circular refs at app layer.

---

### SmallGroupMemberRequest
Tracks pending/confirmed/rejected requests to add a Guest or Member to a SmallGroup (including transfers between groups).

**Fields:** `id`, `smallGroupId → SmallGroup`, `guestId → Guest?`, `memberId → Member?` (exactly one set), `fromGroupId → SmallGroup?` (set on transfers), `status (Pending|Confirmed|Rejected)`, `notes?`, `assignedByUserId → User?`, `breakoutGroupId?` (links to originating breakout — cleared on removal), `resolvedAt?`, `createdAt`

---

### SmallGroupLog
Append-only audit trail for all SmallGroup membership changes.

**Fields:** `id`, `smallGroupId → SmallGroup`, `action (GroupCreated|MemberAdded|MemberRemoved|MemberTransferred|TempAssignmentCreated|TempAssignmentConfirmed|TempAssignmentRejected)`, `memberId?`, `guestId?`, `fromGroupId?`, `toGroupId?`, `performedByUserId?`, `description?`, `createdAt`

---

### Ministry
Sub-operation targeting a life stage. **Fields:** `id`, `name`, `lifeStageId → LifeStage`, `description`, `createdAt`, `updatedAt`.

**LifeStage:** `id`, `name`, `order` — managed in **Settings → Life Stages**.

---

### Volunteer (Committee & Role System)

Members serving in a Ministry or Event. Each Ministry/Event has its own independent committees and roles.

**VolunteerCommittee:** `id`, `name`, `eventId → Event` — scoped to events only (no ministry-level committees).

**CommitteeRole:** `id`, `name`, `committeeId → VolunteerCommittee`.

**Volunteer:** `id`, `memberId → Member`, `ministryId?`, `eventId?` (exactly one set), `committeeId`, `preferredRoleId → CommitteeRole`, `assignedRoleId → CommitteeRole?`, `status (Pending|Confirmed|Rejected)`, `notes?`, `leaderApprovalToken String? (unique UUID)`, `leaderNotes?`, `createdAt`, `updatedAt`.

**Rules:** Role selection is preference only — admin reviews and may reassign via `assignedRoleId`. Member can hold multiple Volunteer records (different ministries/events). `BreakoutGroup.facilitatorId → Volunteer`.

**Leader approval flow:**
1. `leaderApprovalToken` auto-generated on sign-up
2. Admin shares `/volunteer-approval/[token]` with Small Group leader
3. Leader approves/rejects (no login) + optional `leaderNotes` → sets status automatically
4. Admin can always manually override status

---

### Event
Three types with different behavior:

| Type | Description |
|---|---|
| **OneTime** | Single date; optional registration + payment |
| **MultiDay** | Consecutive days; per-day attendance via occurrences |
| **Recurring** | Fixed schedule; first-timers register once; returning attendees check in per occurrence |

**Fields:** `id`, `name`, `description`, `type (OneTime|MultiDay|Recurring)`, `startDate`, `endDate`, `price Int? (cents, null=free)`, `registrationStart?`, `registrationEnd?`, `createdAt`, `updatedAt`

**Recurring-only:** `recurrenceDayOfWeek Int?` (0=Sun…6=Sat), `recurrenceFrequency (Weekly|Biweekly|Monthly)?`, `recurrenceEndDate?` (null = indefinite)

**Event-Ministry:** many-to-many via `EventMinistry` join table.

**Feature matrix:**

| Feature | OneTime | MultiDay | Recurring |
|---|---|---|---|
| Public registration | ✅ | ✅ | ✅ (first-timers, no payment) |
| Payment tracking | ✅ | ✅ | ❌ |
| Breakout groups | ✅ | ✅ | ✅ |
| Baptism module | ✅ | ✅ | ❌ |
| Embarkation module | ✅ | ✅ | ❌ |
| Volunteers | ✅ | ✅ | ✅ |
| Check-in | `attendedAt` on registrant | Per day (`OccurrenceAttendee`) | Per occurrence (`OccurrenceAttendee`) |

**Event workspace** (`/event/[id]/...`): dashboard, registrants, sessions, sessions/[occurrenceId], breakouts, volunteers, baptism, embarkation, settings. Old `/events/[id]` URLs redirect to new workspace routes. PWA — admin navigation never uses `target="_blank"`. The exceptions are links that leave the workspace for a **public form** or a **print surface**: bus manifest print, "View public form"/"View check-in form"/"View walk-in form" on the Forms pages, the session check-in links, and the cluster check-in board's Shortcuts. Those are worked alongside the admin screen that launched them, so the screen behind has to survive; pair every one with `rel="noopener noreferrer"` and an `sr-only` "(opens in a new tab)" hint.

**Public URLs (no login):** `/events/[id]/register`, `/events/[id]/checkin`

#### EventRegistrant
One record per person per event series.

`id`, `eventId`, `memberId?`, `guestId?`, `firstName?`, `lastName?`, `nickname?`, `email?`, `mobileNumber?`, `isPaid Boolean`, `paymentReference?`, `attendedAt?` (OneTime only), `occurrenceAttendances OccurrenceAttendee[]`

**No data duplication:** personal fields only populated when both FKs are null. When either FK is set, data comes from the linked record. Exactly one of: memberId, guestId, or personal fields — app-layer enforced.

#### Member Resolution at Registration
Lookup by mobile number (exact match). **Match found:** show confirm screen — if confirmed, set `memberId`; if not, proceed as non-member. **No match:** create/find `Guest` by mobile, link via `guestId`.

#### Payment
Admin manually marks `isPaid = true` and must enter `paymentReference`. Stored on `EventRegistrant`.

#### MultiDay & Recurring Occurrences

**EventOccurrence:** `id`, `eventId`, `date DateTime`, `notes?`, `isOpen Boolean` (whether check-in is currently open), `createdAt`, `updatedAt`, `@@unique([eventId, date])`

**OccurrenceAttendee:** `id`, `occurrenceId`, `registrantId → EventRegistrant`, `checkedInAt`, `@@unique([occurrenceId, registrantId])`

MultiDay: occurrences auto-generated for every day in date range (`ensureMultiDayOccurrences()`). Recurring: occurrences created on-demand when check-in page is opened. Walk-ins auto-create an `EventRegistrant` at check-in time.

#### BreakoutGroup
Sub-groups within an event **or a Collab cluster**. Same matching fields as SmallGroup. `id`, `eventId?`, `clusterId?`, `name`, `facilitatorId → Volunteer?`, `coFacilitatorId → Volunteer?`, `linkedSmallGroupId → SmallGroup?` (temp membership target), `lifeStageId?`, `genderFocus?`, `language?`, `ageRangeMin?`, `ageRangeMax?`, `meetingFormat?`, `locationCity?`, `memberLimit?`, `BreakoutGroupSchedule[] { dayOfWeek, timeStart, timeEnd }`, `createdAt`

**`eventId` is nullable.** Exactly one of `eventId` / `clusterId` is set — app-layer XOR via `isValidBreakoutOwner` (`lib/breakouts/owner.ts`), the same pattern `EventFormConfig` uses. Never dereference `group.event` without a null check; use `breakoutOccasionName()` for a display label.

**Never scope a breakout query on a bare `eventId`.** Take a `BreakoutOwner` (`{ eventId } | { clusterId }`) and spread it: `where: { id: groupId, ...owner }`. Public/unauthenticated paths that only know an event id resolve their own owner via `resolvePoolScope(eventId)`. Every write action in `breakout-actions.ts` follows this.

**BreakoutGroupMember:** `breakoutGroupId`, `registrantId → EventRegistrant`, `assignedAt`

`EventRegistrant` is one row per person per event **series**, so a recurring event's regular has one long-lived row that stays seated in a standing table. Already-seated guards must therefore be owner-scoped (`breakoutGroupMemberships: { none: { breakoutGroup: owner } }`) — a global `{ none: {} }` would exclude every regular from a collab day's tables. And under a Collab one person holds a row per member event, so "one seat" is enforced **per person** via `personKeyFor`, not per registrant row.

#### The breakout selection screen

The registration and walk-in forms offer a **"Suggested for you" card plus a dropdown of the other tables that fit** — `suggestBreakoutGroup` and `breakoutPickerOptions` (`lib/breakout-suggestion.ts`, pure and client-safe, so both re-rank live as the person answers). `assignBreakoutForRegistrant`'s auto-assign branch calls the same `suggestBreakoutGroup`, deliberately: `autoAssignBreakout` *suppresses* the picker rather than sitting beside it, so a table the screen would hide must not be one auto-assign quietly drops the same person into.

**Both rank emptiest-first, then by specificity.** Gender, life stage, age and capacity are filters applied before ranking, so everything reaching the comparator already fits the person; what's left to decide is which of them takes the next arrival, and the answer is whichever holds the fewest so far. That is what makes the suggestion *rotate* as a day fills instead of naming one table to everyone. Specificity (gendered +2, life-staged +2, age-ranged +1) only breaks ties. This inverts the original scoring, where specificity was worth +2 against a capacity term worth at most 1 — a gendered table won every arrival until it was full.

**`fillLevel`, not `roomRatio`.** Ordering needs one scale that capped and uncapped groups share. `roomRatio` was the share of the *cap* still open and therefore `null` whenever a group had no `memberLimit` — and a day whose tables are created without limits is the ordinary case. Every uncapped group scored alike, the sort was stable, and the first table created absorbed every registrant, permanently. `resolveFillLevels` (`lib/breakout-suggestion-server.ts`) reduces a whole *set* at once: a capped group's own fill ratio; an uncapped one measured against the mean cap beside it, or against the fullest headcount when nothing is capped. It is a **ratio, never a headcount**, so it survives `withoutOccupancy` and the public form can order by it without learning how many people are in any group — the distinction `breakout-occupancy-visibility` pins.

**Missing data never reads as a mismatch.** Gender excludes an unknown candidate from a *suggestion* (a men's table is a hard boundary) but never from the *dropdown*. Life stage is more forgiving on both — it reuses `scoreLifeStage`, so only a known mismatch excludes — because it is frequently left unasked, and gender's strictness would delete the suggested-group card on most events. A group that declares no life stages accepts everyone.

**One picker, three surfaces.** `BreakoutPicker` (`components/breakouts/breakout-picker.tsx`) is the suggested-table card plus the "Or browse groups" dropdown, and it **ranks nothing** — `suggested` and `options` arrive pre-ordered. That is what lets the registration form re-rank on every keystroke (the person is *answering* gender and life stage as they go) while the check-in kiosks resolve the profile once, server-side, from the Member or Guest record that already exists. Occupancy is likewise not decided in the component: a candidate carries counts or it doesn't, and the surface that loaded it made that call via `withoutOccupancy`. Their *presence* — never a `staff` flag — is what lets a full group be chosen.

#### Picking a table at check-in

`sectionBreakout` is a **Check-in** toggle too, off by default. It used to be listed as inapplicable there, on the reasoning that check-in only ever *shows* the group someone was already assigned — which left the people the step exists for with nowhere to go. Someone arriving unseated on an event with auto-assign off was placed by nobody, and the kiosk is the last moment anyone asks. (Worse on a OneTime event, whose kiosk never auto-assigned at all: that branch is gated on `occurrenceId !== null`.)

Two server actions in `breakout-actions.ts`, beside `autoAssignRegistrantToBreakout` and deliberately unguarded for the same reason — the kiosks are public routes. `getCheckinBreakoutChoices` returns a pre-ranked `CheckinBreakoutChoices` (`lib/breakouts/checkin-choices.ts`), or `null` when the step should simply not appear: no enabled groups, or the person staffs one. A *gated* empty list is different and comes back as a `notice`. `pickCheckinBreakout` wraps `assignBreakoutForRegistrant`, which already owns the module gate, `pickedIsInPlay`, `isEnabled`, capacity and the one-seat-per-person move. What the wrapper adds is the guard that function can't: **refuse unless attendance is already recorded** for this event/occurrence. Free on the real path — the step runs after the check-in write — and without it a public endpoint taking a caller-supplied group id would seat anyone anywhere.

**The step comes after the DGroup steps**, not before: `sg-profile` is where someone can supply gender and life stage for the first time, and those are the two answers the suggestion turns on. It is skippable and never assigns on skip.

**Here the Check-in config outranks `autoAssignBreakout`** — the one surface where it does. Everywhere else auto-assign *replaces* the picker; at the kiosk auto-assign is what steps aside (`offerBreakoutPicker = cfg.sectionBreakout`, and `handleConfirm` skips its auto-assign call when the picker is offered). The old ordering meant an event with auto-assign on had no way to ask however plainly the Check-in form said to: the person was placed a moment earlier, `getCheckinBreakoutChoices` then reported them already seated, and the step was skipped — so turning the section on looked like it did nothing. This is the last moment anyone can ask and the person is standing right there, which is what makes a silent placement the weaker answer.

**The candidate set is the registration form's, not the door's** — every enabled table, ungated (`fetchBreakoutAvailability(…, false)`). Gating it was wrong twice over. It *hid* the step: every branch of `facilitatorGate` requires a facilitator relation, so a table with nobody assigned can never pass, and a table whose host hasn't arrived yet is the ordinary state of the first half hour — both left an `awaiting-facilitator` notice where the suggestion should be. And it *distorted the ranking*: `resolveFillLevels` reduces the whole candidate set at once, so "the emptiest table" only means "the emptiest of all of them" when the set **is** all of them. A gated subset was worst in the window where exactly one facilitator had checked in — it collapsed to that single table and every arrival stacked into it, the opposite of the spread the suggestion exists to produce. The **door** keeps the gate: there a staffer is handing someone over, and an unstaffed table is a handover to nobody.

On a **Collab** day the cluster kiosk offers it too, over the day's own tables. `checkInToCluster` returns a `breakoutSubject` — the registration it would seat, resolved server-side because it needs the day's session map — which is `null` for someone the day knows only as a volunteer. Only `sectionBreakout` is applicable on a cluster's Check-in form (`clusterCheckInNotApplicableToggles`): the day's board is a lean one with no DGroup prompt, no profile form and no household step, so every other toggle would be *unhonoured* rather than merely off. A Parallel day gets nothing, owning no tables.

`breakoutSubject` is read off the cells whose attendance **now stands**, not the ones this tap wrote. A cell skipped as `already` is attendance too — the person is in the room, they simply got there a moment earlier, by a double tap or by a staffer working the admin board. Reading only `recorded` gave the step exactly one chance to appear and no retry, which is what made "undo the arrival, then check in again" the only way to reach it. Every other skip reason is a real absence and stays out; `pickCheckinBreakout` re-checks attendance itself, so the widening can seat nobody the room hasn't recorded.

**On a Collab day, registration holds off so the kiosk has someone to ask.** `deferBreakoutToCheckin` (`registerForCluster`) suppresses the auto-assign branch of `assignBreakoutForRegistrant` — never an explicit pick — whenever the day's Check-in form offers the step. Same rule as the paragraph above, one surface further along: a member event's `autoAssignBreakout` placed every registrant at submit, the kiosk skips anyone already seated, and so a day whose Check-in form asked about tables never got to ask anybody. **Never at the door**, which checks people in on the spot: nobody deferred there would ever reach the kiosk, so the walk-in picker and its auto-assign stay exactly as they were. A **single event** still pre-seats at registration — the same trap, not yet closed — which is why `eventFormPrerequisites` keeps warning about auto-assign on all three of its tabs while `clusterFormPrerequisites` withholds that warning once the kiosk is asking.

---

## Event Clusters

An `EventCluster` ("Event Day") groups events that share one public registration form and one aggregated admin workspace at `/cluster/[id]/...`. Member events stay independent; the cluster is a layer on top. One cluster per event (`@@unique([eventId])` on `EventClusterEvent`), always one day, and Priced/MultiDay events can't join (`validateClusterEventLink`).

Four independent open/close switches: `isOpen` (shared form), `walkInIsOpen` (door), `checkInIsOpen` (kiosk), `volunteerIsOpen` (the day's volunteer sign-up form — Collab only).

**The kiosk switch opens the whole day.** `checkInIsOpen` only ever governed the kiosk's own door; what decides whether a person standing at it can actually be checked in is each member event's own control — a `FormConfig("EventCheckIn")` row for OneTime, an `EventOccurrence.isOpen` for a session event. Until every one was open the kiosk found the person and silently skipped their events (`skipReasonFor`), which on a Collab day it can't even name. `setClusterCheckinOpen` is the one switch: `planClusterCheckinToggle` (`lib/clusters/checkin-toggle.ts`) turns the read side's own `resolveClusterCheckinTargets` output into a per-event op, and the action replays it through the **existing per-event actions** (`setFormOpen` / `setOccurrenceCheckinOpen`) so opening from the day is indistinguishable from opening on the event's own screen — the walk-in door moves the same way, and there is no second code path to drift. A session event with no session for the day gets one created at the cluster's date and pinned to the link. Closing never creates a session, and neither does opening a dateless cluster. It is a fan-out in the `registerForCluster` shape: per-item `try/catch`, a typed status per event, `success: true` once the loop has run.

### ClusterKind — `Parallel | Collab`

| | **Parallel** (default) | **Collab** |
|---|---|---|
| Shape | Several events sharing a day | Two ministries co-running **one** event |
| Registration | Events step asks which to attend (any number) | **Ministry step** asks which ministry the registrant is part of; that answer routes them to **one** event — theirs. The form sends the event id behind the ministry, so nothing downstream knows ministries exist (`resolveClusterEventSelection`) |
| Success screen | Per-event breakdown | Collapsed to the cluster's name |
| Volunteers | Per event | **The day's own sign-ups** (`Volunteer.signUpClusterId`), taken through the day's shared volunteer form. Rows stay event-owned — a person serves under a ministry. The union of both standing rosters is still one click away (`?scope=all`) and is still what facilitator eligibility draws on |
| Breakouts | Per event | **Cluster-owned and exclusive.** Empty by default; member events' standing tables are untouched and unused for the day. `carryOverBreakoutGroups` copies a member event's tables in (optionally with rosters) |
| Cluster nav | Dashboard/Registrants/Check-in/Forms | …plus Breakouts and Volunteers |
| Public check-in kiosk | Per-event breakdown per person, "check me in (N)" | Name → tap → **"Check me in"** → welcome. Names no events at all |

The asymmetry is deliberate: someone chose to serve under a *ministry*, so a volunteer row keeps that provenance and the day only stamps it; a breakout table for a collab session belongs to the *session*, so the day owns a fresh set.

**A Collab requires every member event to name exactly one distinct ministry** — no ministry, several, `allMinistries`, or two events sharing one all make "which ministry are you part of?" unanswerable. Enforced on both writes (`updateEventCluster` switching to Collab, `addEventToCluster`) by `collabMinistryProblems`, and mirrored in cluster Settings so the reason shows before Save. The public form falls back to event names if a day slips through, rather than dead-ending a registrant.

**A Collab day's registrant list starts fresh.** `EventRegistrant` is one row per person per event *series*, so every regular of either ministry already holds a row on a member event — one that predates the day. On a Collab that row is **not** a registration for the day: `clusterDayRegistrationDisposition` (`lib/clusters/day-registration.ts`) returns `reuse`, and the fan-out does the day's work on top of it (stamp `registrationClusterId`, merge the answers just given, auto-assign one of the day's cluster-owned tables, file the DGroup request) rather than short-circuiting. The row is reused, never duplicated — the member event must not gain a second registration for one person. Only a row already stamped with *this* cluster returns `already`, which is what makes a second submission idempotent. A **Parallel** day is unchanged: there the person ticked that event, so its own registration is exactly what they asked about.

That fresh list is enforced on the read side too, and it has to be: the write rule alone left every inherited row on the day's screens, flagged "on the series" but present, so a day built from two existing events opened with both ministries' rosters already in it. On a Collab, `isOnClusterDay` drops every "of course it's ours" shortcut — a OneTime member event's pre-existing sign-ups and a dateless cluster's whole series included — and counts only the day's stamp, the day's check-in, or a sign-up made on the day itself; `belongsOnClusterList` (`lib/clusters/roster.ts`) then removes the rest from the roster, the registrants screen and the CSV export. A **Parallel** day still keeps them, flagged: there the row *is* the thing the person asked for, and hiding it made the roster claim someone was not registered while the add-registrant screen refused to add them twice. Dropping is safe on a Collab precisely because the disposition is `reuse` — the shared form and the door can always bring an inherited row onto the day.

The same rule reaches the day's tables: `breakoutCandidateWhere` (`lib/breakouts/candidate-events.ts`) scopes who may be seated to the day's registrations via `clusterDayRegistrantWhere`, so the pickers, `autoAssignBreakouts` and the "N unassigned" figure all describe the people who are actually here rather than both ministries' entire series.

**A Collab day's shared form can offer the Breakout step**, over the day's own tables — the same suggested-table-plus-dropdown a single event offers, rendered by the same `RegistrationForm`. `clusterNotApplicableToggles` (`lib/forms/cluster-sections.ts`) is the one place that decides: Payment and Family are out on every day, and `sectionBreakout` follows exactly where cluster-owned tables exist, so a **Parallel** day still hides it — its member events each run their own standing set and a registrant may tick several, leaving no one set to offer. Candidates come from `fetchClusterBreakoutAvailability`, whose door mode gates on `facilitatorGateForOccurrences` — one copy of the per-event `facilitatorGate` per distinct session the day's links name, so a day holding one OneTime and one Recurring event answers both check-in lanes. The write reuses `resolveBreakoutSelection` + `assignBreakoutForRegistrant` unchanged; its `pickedIsInPlay` check is already an owner comparison, so a table from another day or from a member event is refused. Placement still needs the **registrant's own member event** to have the Breakout module — the day owning the table isn't enough — which is why `clusterFormPrerequisites` names the events that don't.

**A Collab day recruits its own serving team.** `/register/c/[token]/volunteer` is the staffing counterpart of the shared registration form: it asks which ministry you're part of, offers that ministry's committees and roles, and files the sign-up against that ministry's event stamped with `signUpClusterId` (`submitClusterVolunteerSignUp`). A ministry regular who already holds a `Volunteer` row is **reused, never duplicated** — the stamp goes on and the preferences just given replace what was there, while `status` is left alone so a confirmation already given isn't silently withdrawn. This is what the per-event form could not do: it refuses a second sign-up outright, so the day had no way to hear from anyone already on a ministry's roster. Collab-only, like the Volunteers screen itself.

**A volunteer is one of the day's people.** `Volunteer` and `EventRegistrant` are mutually exclusive by design — `findEventVolunteerConflict` refuses a registration from someone serving the event, and `OccurrenceAttendee` keys attendance to one or the other — so a day roster built from registrations alone leaves the serving team out of the room it describes. The two are unioned at the **read** layer instead (`getClusterDayRows`), each record staying what it is: the registrants screen, the dashboard roster, the check-in board and the CSV export all list volunteers, typed **Volunteer** (it outranks Member, since every volunteer is one), linking to the volunteer's own detail page. Counts stay split — `registrations` and `volunteers` are separate figures on the dashboard and in the header, because seats and shifts are planned separately. `getClusterRegistrantRows` still means registrations alone.

`volunteerIsOnClusterDay` (`lib/clusters/roster.ts`) scopes them, and it is stricter than the registrant rule on **both** kinds of day: a `Volunteer` row is a standing fact about a ministry's event rather than a registration for a date, so only the day's own evidence — its volunteer form's stamp, its check-in, or a sign-up made on the day — puts one on the day. The day's **registration** form counts as that stamp too: when the fan-out turns a submission away because the person is serving that event (`findEventVolunteerRecord`), it writes `signUpClusterId` via `stampVolunteerClusterProvenance` before it `continue`s — the volunteer half of `stampClusterProvenance`, and for the same reason. Without it a ministry regular who filled in the shared form was told "you're serving — already included" and then dropped from every one of the day's surfaces. Only the stamp is written: `status` and the preferences from their volunteer sign-up are left alone, because a registration submission is not a re-answer of the serving questions. Where a person holds both records for one event, serving wins the cell, the same precedence `buildClusterCheckinPeople` applies.

Day-scoping never reaches identity: the mobile-number step (`lookupProfileByMobile`) still resolves people against the whole Member and Guest pool. "Fresh list" is about which *registrations* count for the day, never about who we can recognise.

**Amending a collab registration doesn't re-ask the ministry** — the step isn't in `sections`, so the submission arrives with an empty selection and `registerForCluster` resolves the target from the registration being amended, preferring a registration stamped for this day over an inherited series row. The client's submit guard is gated on the cluster step having actually rendered: a form must never block on an answer it did not ask for.

**The collab kiosk (`/register/c/[token]/check-in`) names no events.** A registrant belongs to exactly one member event — their ministry's — so the per-event cell list would re-expose the split *and* render the partner ministry as "Not registered" beside their name. `ClusterCheckinBoard` takes the day's `kind` and collapses accordingly; the write is identical either way. The **admin** board at `/cluster/[id]/checkin` collapses the same way, via `clusterOffersPerEventCheckin(kind)`: no per-event check-in door in its Shortcuts, and no per-event badge under a name in its arrivals list — a door to half the day is one no staffer can be asked to choose, and the badge column is one ministry's event name repeating down every row. Those rows had one job left, showing which member event's closed form was blocking the kiosk, and the day's own switch took it (`setClusterCheckinOpen` opens every member event at once). The per-event read-out stays on **Forms → Check-in**, which is both the diagnosis and the escape hatch for opening just one. A **Parallel** day keeps everything: there the events really are separate, someone may be registered for any subset, and a MultiDay event's own check-in link has no substitute on the board.

**The admin board is the session detail screen, for a day.** `/cluster/[id]/checkin` asks what a session's page asks — who is expected, who has arrived — so it is built the same way: five `StatCard` tiles, an inline filter strip, then cards below `xl` and a `DataTable` (`tableKey: "cluster.checkin"`) above it. The arithmetic is pure, in `lib/clusters/checkin-board.ts`, so the tiles and the rows read one set of figures. Two departures from the session screen, both forced by what a cluster day *is*: its turnout counts volunteers in **both** halves of the ratio (a day expects people, not registrations — `formatTurnoutRatio` names the wrong denominator, so the board formats its own), and a person's standing has three states rather than two, because a **Parallel** registrant may hold several of the day's events and arrive for some — `Partly in` is the only honest answer there, and it is the one thing the per-event badges cannot say. A **Collab** person holds exactly one event, so that state never occurs and the event badges, the event filter and the badge column all stay hidden. Filters are inline rather than in the `FilterBar` drawer for the same reason the session screen's are: mid-event, "who isn't here yet" has to be one tap.

**The board corrects the room, not just reports it.** `removeClusterCheckin` is the day's answer to the session screen's "Remove from session", and the inverse of `checkInToCluster` down to its argument: a **person key**, never a registrant or volunteer id, so every row is re-resolved from the cluster's own events and a forged key finds nobody. Person-level rather than per-event because that is the grain of the board and of the tap that made the record — one click checked them into every event of the day that would take it, so one click undoes it, and the confirm dialog names the events on a Parallel day where that can be more than one. `planClusterCheckinRemoval` (`lib/clusters/checkin-removal.ts`) is the pure planner, the mirror of `planClusterCheckinToggle` and fed by the same `resolveClusterCheckinTargets` output, so the write cannot drift from the read's idea of which session the day stands for. It dispatches the two lanes `clearCheckinAttendance` clears — `attendedAt` on a OneTime row, the day's `OccurrenceAttendee` otherwise — and clears **every** row behind one cell, since a person may hold two on one event. A session event whose day names no session is refused rather than cleared: a dateless cluster reads every sitting's attendance, and undoing "the" arrival there would erase a history nobody asked about.

Undoing an arrival can also take the person **off the board**, and that is `hasDayEvidence` rather than a side effect: for a series registrant the day's check-in was the only thing tying them to the date. The registration is untouched — a Parallel day's OneTime sign-up stays on the day, because there the sign-up names the event and the event is the day — and the kiosk can always bring them back. The dialog says so.

Two facts were added to `ClusterRegistrantRow` to serve it: `gender` (the tile's split bar) and `checkedInAt` (the arrival column), the latter read from `attendedAt` on a OneTime event and the day-scoped `OccurrenceAttendee` otherwise — the same attendance the `checkedIn` flag beside it already used. `ClusterRosterPerson.gender` takes the **first stated** answer across a person's rows, so a walk-in row carrying no profile can't erase what the Member record holds. Times are formatted on the server: timestamps are UTC and the board reads Manila time, and formatting on both sides of hydration is how the two come to disagree about the hour.

**Catch Mech on a Collab day is endorsed to the facilitator's ministry event.** There is no cluster-level Catch Mech. A cluster-owned table is followed up by the member event of whoever staffs it — `Volunteer.eventId` is required, so a facilitator belongs to exactly one member event, and `CatchMechSession` keeps its required `eventId` (that ministry) while pointing at the cluster's table. A table staffed from two ministries appears on both events' Catch Mech, which needs no special handling: `resolveCatchMechTargets` gives the linked DGroup only to the lead, and `hidesPerson` already scopes decisions per facilitator. `lib/catch-mech/scope.ts` is the seam — **never scope a Catch Mech query on a bare `eventId`**; take `resolveCatchMechScope(eventId).where` and combine it with `AND` (the Collab branch is itself an `OR`). A table with no staff is endorsed to nobody and is flagged on the cluster Breakouts page.

**A substitute can stand in at a cluster-owned table.** `OccurrenceSubFacilitator` is keyed by `[occurrenceId, breakoutGroupId, role]` and carries no event of its own, so the row could always name one — what could not was the screen that writes it. The session page listed tables on a bare `eventId`, so a Collab day offered the member event's standing tables and none of the day's own. Both the page and `sub-facilitator-actions.ts` resolve the owner through `resolvePoolScope` now: the **table** must belong to the day's owner, while the **substitute** comes from `volunteerEventIds` — either ministry's roster, since a cluster-owned table can be staffed from either. The occurrence itself stays the member event's; a substitute stands in at one sitting of one event.

Those two actions previously had **no guard at all** — no `auth()`, no permission check, and no verification that the caller-supplied occurrence, group and volunteer belonged together — so anyone reaching the endpoint could staff any table of any event. They now take `requireBreakoutWrite(owner)` and validate both ids against the scope, the way their neighbour `attendee-actions.ts` always described. `removeSubFacilitator` no longer takes an `eventId` parameter: it was caller-supplied and used only to build a revalidate path.

**Not yet supported on cluster-owned tables:** CSV import of breakout groups is event-only; carry-over is the cluster equivalent.

**One seat per person, every owner.** `BreakoutGroupMember` is keyed by `registrantId`, but a person can hold several registrant rows — one per member event under a Collab, or two from a duplicate sign-up on a single event. Every seating path guards on `personKeyFor`, not on the row. `scripts/find-double-seated.ts` reports and cleans legacy duplicates.

**Public URLs (no login):** `/register/c/[token]` (shared form), `/register/c/[token]/walk-in` (door), `/register/c/[token]/check-in` (kiosk), `/register/c/[token]/volunteer` (volunteer sign-up, Collab only) — helpers in `lib/public-routes.ts`.

**Code:** `lib/breakouts/owner.ts` (pure owner/surface types), `lib/breakouts/candidate-events.ts` (`breakoutCandidateEventIds` / `breakoutCandidateWhere`), `lib/events/pool-scope.ts` (the resolver), `lib/catch-mech/scope.ts` (Catch Mech's table scope), `lib/catch-mech/faci-session.ts` (who may answer for a table), `lib/events/require-event-write.ts` (`requireEventWrite` / `requireClusterWrite` / `requireBreakoutWrite`), `lib/clusters/aggregate.ts` (`getClusterVolunteerPool`, `getClusterBreakoutPool`, `getClusterMinistries`).

---

## Event Add-on Modules

Toggled per-event in **Event Settings → Modules**. Tracked in `EventModule { id, eventId, type (Baptism|Embarkation|CatchMech), createdAt, @@unique([eventId, type]) }`.

### Baptism
Admin-managed opt-in (not on public form). `BaptismOptIn { id, eventId, registrantId (@unique globally), createdAt }`

### Embarkation
Bus assignments for registrants and volunteers. Bus manifest PDF at `/events/[id]/buses/[busId]/manifest` (print-to-PDF, no external library).

`Bus { id, eventId, name, capacity Int?, direction (ToVenue|FromVenue|Both), createdAt, updatedAt }`

`BusPassenger { id, busId, registrantId?, volunteerId? — exactly one set, createdAt }`

---

### Catch Mech
Facilitator-led confirmation flow that converts breakout group attendees into SmallGroup member requests.

**How it works:**
1. Admin enables the CatchMech module on an event
2. Public entry at `/events/[id]/catch-mech` — facilitator verifies identity via mobile number, receives a unique token link
3. Facilitator opens their token URL (`/events/[id]/catch-mech/[token]`) — no login; shows their breakout group members with checkboxes to confirm attendance/interest
4. Confirmed members generate `SmallGroupMemberRequest` records targeting the breakout's `linkedSmallGroupId`
5. Admin tracks all requests in the event workspace at `/event/[id]/catch-mech` (filterable by Pending/Confirmed/Rejected status), with per-registrant matching UI

**Who may answer for a table:** lead facilitator, co-facilitator, or an `OccurrenceSubFacilitator` substitute — resolved in that precedence by `staffVolunteerFor` (`lib/catch-mech/faci-session.ts`). Substitutes are not scoped to one occurrence: Catch Mech is about the table's people, not a single sitting.

**One person, one form.** A facilitator who opens the volunteer follow-up form is redirected to their table's facilitator form (`verifyCatchMechVolunteer` returns a discriminated `VolunteerEntry`), and anyone staffing a table is excluded from the volunteer response denominator. Otherwise a facilitator would report only the people they personally absorbed while their table went unanswered, and sit in both response rates at once.

**The cohort is breakout membership — nothing else.** Anyone who attended but was never seated is outside every Catch Mech count. The dashboard's "Not at a table" card surfaces them via `unassignedCandidateWhere`; household registrations land there by design (CCF-148).

`CatchMechSession { id, token (unique cuid), eventId, breakoutGroupId, facilitatorVolunteerId, createdAt }` — under a Collab, `eventId` is the facilitator's ministry event and `breakoutGroupId` a cluster-owned table.

**Event workspace routes:** `/event/[id]/catch-mech`, `/event/[id]/catch-mech/[status]`, `/event/[id]/catch-mech/[status]/[rid]`

**Public routes:** `/events/[id]/catch-mech`, `/events/[id]/catch-mech/[token]` (no login required)

---

## Matching Algorithm

Scoring engine for SmallGroup suggestions and Breakout auto-assignment. Each factor is scored 0.0–1.0 **and flagged `known`** (was it actually measurable, or is 0.5 a placeholder for missing data). Only the six **weighted factors** feed the score; the three **hard gates** are pass/fail eligibility filters applied before scoring.

**Hard eligibility gates** (a group failing any is excluded entirely — never scored, never weighted):

| Gate | Rule |
|---|---|
| Life Stage | 1.0 match; excluded on mismatch; unknown (0.5, no filter) when group sets none or candidate has none |
| Gender | 1.0 match or group is Mixed/none; excluded on mismatch; unknown when candidate gender missing |
| Schedule | Excluded when candidate's availability doesn't overlap the group's meeting time |

**Weighted factors** (0.0–1.0 × weight, normalised over the active-weight total):

| Factor | Scoring logic |
|---|---|
| Language | 1.0 any overlap, 0.0 no overlap; unknown when either side empty |
| Age | 1.0 in range, linear decay over 10 years to 0.0 outside; unknown without birth year or group range |
| Work City | 1.0 same, 0.0 different; unknown when either missing |
| Meeting Preference | 1.0 exact, 0.5 Hybrid↔Online/InPerson, 0.0 incompatible; unknown when either missing |
| Career/Industry | Peer-count ladder: 0→0.25, 1→0.70, 2→0.85, 3+→1.0 (group-size independent); unknown without candidate industry or group roster |
| Capacity | `null` limit → unknown (0.5); else `0.4 + 0.6·min(1, openSlots/3)` — gentle load-balancing (full groups already gate-excluded) |

Each result also carries `breakdown` (all nine sub-scores), `coverage` (per-factor `known` flags), `confidence` (share of active weight backed by measured factors), and `groupSummary` (group-side facts for the UI, with `industryPeerCount` in place of the member roster — safe for the public join page). Results sort by score, then by confidence as a tie-break.

**MatchingWeightConfig:** `{ context (SmallGroup|Breakout), lifeStage, gender, language, age, schedule, location, mode, career, capacity, guestCooldownDays }`. Weights are **normalised at scoring time over the six active factors** (`ACTIVE_WEIGHT_KEYS` in `lib/validations/matching-weights.ts`) — they do NOT need to sum to 1. The three gate columns (`lifeStage`, `gender`, `schedule`) are retained but unweighted (kept at 0); they exist so a gate could be re-promoted to a weighted factor without a schema migration. Configured per context in **Settings → Matching Weights** (six sliders + a read-only "Requirements" section for the gates).

**Code:** `lib/matching/` — `types.ts`, `scorers.ts` (`scoreXDetailed` returns `{score, known}`; plain `scoreX` wrappers), `engine.ts` (pure/no DB — normalisation + confidence + groupSummary), `index.ts` (DB-aware entry points). UI: `components/small-group-match-card.tsx` (`buildFitReasons` → `{strengths, considerations}`, `MatchBreakdown` grid behind `showBreakdown`, admin-only), `components/matching/factor-meta.tsx` (icons/colours/`scoreBand`, client-only).

---

## AI Assistant

SuperAdmin-only chat assistant (floating button, right-side Sheet) mounted in the dashboard and event-workspace layouts. Built on the Vercel AI SDK (`ai` v7) + `@ai-sdk/anthropic` (`ANTHROPIC_API_KEY` required; model constant in `lib/assistant/config.ts`).

- **Server**: `lib/assistant/` — `config.ts` (model + cost caps), `system-prompt.ts`, `serializers.ts` (compact JSON projections; never return raw Prisma rows from a tool), `queries.ts` (read-only helpers, row-capped), `tools.ts` (`buildAssistantTools(session)` — tools close over the session and re-check `canRead`/`canWrite`/`canAccessEvent` per call), `agent.ts` (`ToolLoopAgent` per request). Route: `app/api/assistant/route.ts` (401 unauthenticated / 403 non-SuperAdmin).
- **Writes**: every write tool is listed in `WRITE_TOOL_NAMES` and gated by `toolApproval: 'user-approval'` — the client renders an Approve/Cancel card before execution. Write tools delegate to the existing server actions (which re-run `requireWrite()` + Zod). No delete tools — ever.
- **Client**: `components/assistant/` — panel, message list, per-tool renderers (tables/chart/cards), approval card. Conversation state is in-memory only (resets on reload).
- **Adding a tool**: define it in `tools.ts` (zod `inputSchema`, permission check first line of `execute`, serialize via `serializers.ts`); if it writes, add its name to `WRITE_TOOL_NAMES` and a title in `approval-card.tsx`; add a renderer case in `tool-renderers.tsx` + a loading label; ship schema + integration tests like `tests/integration/assistant-tools.test.ts`.

---

## Development Conventions

### Migrations

Prisma generates non-idempotent SQL by default. **Always rewrite generated migration files to be idempotent before committing.** This prevents P3018/P3009 failures when a migration partially runs and is retried.

| Statement | Required rewrite |
|---|---|
| `CREATE TYPE "Foo" AS ENUM (...)` | Wrap in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` |
| `ALTER TABLE "T" ADD COLUMN "c" ...` | `ALTER TABLE "T" ADD COLUMN IF NOT EXISTS "c" ...` |
| `CREATE TABLE "T" (...)` | `CREATE TABLE IF NOT EXISTS "T" (...)` |
| `CREATE INDEX "i" ON ...` | `CREATE INDEX IF NOT EXISTS "i" ON ...` |
| `ALTER TABLE "T" ADD CONSTRAINT ...` | Wrap in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` |

**Example — enum + column + table + FK:**
```sql
DO $$ BEGIN
  CREATE TYPE "MyStatus" AS ENUM ('Active', 'Inactive');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "MyTable" ADD COLUMN IF NOT EXISTS "status" "MyStatus" NOT NULL DEFAULT 'Active';

CREATE TABLE IF NOT EXISTS "MyLog" (
    "id" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    CONSTRAINT "MyLog_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "MyLog" ADD CONSTRAINT "MyLog_refId_fkey"
    FOREIGN KEY ("refId") REFERENCES "MyTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

**Workflow:** `prisma migrate dev` (local) → edit SQL → commit → `prisma migrate deploy` (preview/prod). Never run `migrate dev` against shared databases.

**Recovery when a migration fails in prod (P3009/P3018):**
1. `PRISMA_ENV_FILE=.env.preview npx prisma migrate resolve --rolled-back <migration_name>`
2. Fix the migration SQL to be idempotent
3. `PRISMA_ENV_FILE=.env.preview npx prisma migrate deploy`

---

### Data Access
- Prisma client only — no raw SQL except migrations. Import `db` from `@/lib/db`.
- Prisma 7: import `PrismaClient` from `@/app/generated/prisma/client`; `lib/db.ts` uses `PrismaPg` adapter.

### Mutations
- **Next.js Server Actions** for all create/update/delete. No internal REST routes.
- Return type: `{ success: true; data: T } | { success: false; error: string }`

### Validation
- Zod schemas on all form inputs before DB. Co-locate with feature or in `lib/validations/`.

### Mobile number format
- **Every mobile/phone number is stored in the canonical `"+63 XXX XXX XXXX"` format** — no exceptions, across all six domains.
- Before any `db.*.create`/`update` that writes a phone, and before any lookup that matches on `phone`, pass the value through `formatPhilippinePhone` (`@/lib/utils`). It is idempotent (canonical input → same output), so it is safe to apply defensively anywhere.
- This applies to **every entry path**: admin forms, public registration (`registerForEvent`, `join-small-group`), event check-in/walk-ins, and **all CSV imports** (members, guests, volunteers, registrants, sessions, small groups). A raw CSV/user value that skips normalization both stores a malformed number and silently fails exact-match dedup against existing canonical records — creating duplicates.
- Enforce at the Zod layer where possible: the shared `phone` fields in `lib/validations/member.ts` and `lib/validations/guest.ts` use a `nullablePhone` transform; the public-registration schemas (`registrantSchema`, `personalInfoSchema`) and import actions normalize inline. The `PhonePHInput` component already emits canonical on the client, but never rely on the client alone — always normalize server-side too.

### UI
- **Tailwind CSS** for all styling
- **shadcn/ui** for all component primitives (Button, Dialog, Table, Form, etc.)
- Do not hand-roll components that shadcn/ui already provides
- **Phone inputs:** Always use `PhonePHInput` (`components/ui/phone-ph-input.tsx`) for mobile/phone fields — never a plain `<input type="tel">`. Use `OptionalPhonePHInput` when the field is optional.
- **Email inputs:** Always use `OptionalEmailInput` (`components/ui/optional-email-input.tsx`) for email fields when the field is optional. Never a plain `<input type="email">` unless the field is strictly required with no opt-out.
- **Time inputs:** Always use `TimeInput` (`components/ui/time-input.tsx`) for any time-of-day field — never a plain `<input type="time">`. Accepts/emits `HH:MM` 24-hour strings or `""`. Use `variant="inline"` inside match/profile sections (underline style); use the default variant elsewhere (bordered, matches shadcn `Input` height). The component enforces 12-hour display with am/pm toggle and caps hours at 12.
- **Table link columns:** The primary identifier column in every table (name, date, title) must be a `<Link>` with this exact className: `"font-medium underline decoration-dashed underline-offset-2 decoration-foreground/50 hover:decoration-foreground transition-colors"`. Do not use `hover:underline`, a plain `<Button asChild>`, or any other link style in table identifier columns — this applies everywhere in the app including the Event miniapp (`app/(event)/`).
- **Tables:** Every list table is `DataTable` (`components/ui/data-table.tsx`) over a TanStack `ColumnDef[]`. Never hand-roll `<table>` markup, and never render the shadcn `<Table>` primitive directly for a list — that split (three implementations at once) is what made column widths differ on every screen. See **Table columns** below.
- **Page headers & actions:** Every list screen header uses `PageHeader` + `PageActions` (`components/page-header.tsx`). Pass the main action as `PageActions`' `primary` prop (a `PageAction`) and any extras as the `actions` array; mount dialogs/import wizards as `children`. `PageActions` enforces the standard automatically — never hand-roll header buttons or pass a bare `<Button>` into `PageHeader`'s `actions` slot:
  - **Max 3 visible buttons** on desktop (1 primary + up to 2 inline secondary); any further secondary actions auto-overflow into the `⋯` menu.
  - **Layout:** inline secondary → `primary` → the `⋯` overflow menu, which is always pinned to the **far right**.
  - **Utility actions** (Import, Export, and similar) must set `overflow: true` on their `PageAction` so they always live inside the `⋯` menu rather than inline.
  - **On mobile** (`<sm`) the primary renders **icon-only** and all secondary actions collapse into the single `⋯` menu (still far right). Always give every `PageAction` an `icon` so the icon-only/overflow states read clearly.
- **Filter controls:** List screens filter via the `FilterBar` drawer (`components/filter-bar.tsx`) with `FilterField`-wrapped controls — never an ad-hoc inline filter row.

### Table columns

Every list table renders through `DataTable` (`components/ui/data-table.tsx`), which owns column sizing, the column picker and its own toolbar. A screen supplies a `ColumnDef[]` and a `tableKey`; it renders no table markup of its own.

**A column names what it *is*, and the vocabulary sets its width.** `meta.width` is one of the tokens in `lib/tables/column-sizing.ts` (`micro`, `actions`, `narrow`, `status`, `date`, `phone`, `name`, `email`, `text`, `wide`). `size` is a **proportion**, not a pixel width, and `min` is the floor below which the value stops being readable. `DataTable` measures its own container and `columnStyles` resolves both into plain pixels on a `<colgroup>` over a `table-fixed` table (`resolveColumnWidths`: hand out the space by `size`, pin anything under its floor, re-split what's left); before the measurement lands it emits bare percentages of `size`, so the ratios are right on the first paint. **Never a `calc()` or a `max()`** — Chrome drops such a value for a `<col>` under `table-fixed` and falls back to `auto`, which is how every flexible column once came out the same width. `tableMinWidth` sums the floors into the table's `min-width` so a narrow container scrolls instead of crushing. Never hand-pin a width with `w-[…]` on a `TableHead`; that is exactly how one header row ended up carrying `w-14`, `w-20`, `w-24` and `w-40` for four columns of the same kind.

| `meta` field | Meaning |
|---|---|
| `label` | The column's name in the picker. **Required for anything hideable** — a `header` may be JSX and can't be read as text. A column with no `label` is treated as structural: locked, and left out of the picker entirely (the selection checkbox, the `⋯` menu). |
| `width` | Semantic width token. Defaults to `text`. **The trailing `⋯` column takes `actions`, never `micro`** — `micro` is 44px for a checkbox or an expand chevron, and a 32px icon trigger inside it (after the cell's `px-4`) overflows its own cell, gets clipped by `truncate`, and loses the right edge of its hit area against the card border. `actions` is 52px and `DataTable` swaps the cell's `px-4` for `px-2 text-right`, which lands the glyph 16px in — the same optical gutter as the first column's text. |
| `locked` | Never hideable or movable. Goes on the selection column, the identifier `<Link>` column, and `id: "actions"`. Hiding the identifier would leave rows with no route to their detail page. |
| `optIn` | A real column that is **off by default** — a field the record holds that most days nobody needs (gender, work city, notes). Appears under "More columns" in the picker. |
| `align` | `"right"` for counts. It sets the cell's `text-align`, so it reaches **inline** content only — a cell that lays itself out (a flex row, a block) ignores it and stays left. That is how a right-aligned "Members" header came to sit a column-width away from its own values. |
| `noTruncate` | For cells that lay out their own contents (a name plus a badge, a wrapping row of chips). |
| `stopRowClick` | On a table with `onRowClick`, keep this cell's clicks to itself. |

**The table's toolbar carries the row count.** The strip above the header row states how many rows are on screen — post-filter, in the list's own noun via `rowLabel={{ one, many }}` (default "rows"; `plural` lives in `lib/format/plural.ts`). It exists because the strip was `justify-end` around a single Columns button and its left half was empty on every screen. **Selection count stays in the page header** — `SelectionSummary`'s "N selected" chip already says that, and repeating it in the toolbar would say one thing twice.

**Saved layouts are per user, in the database.** `UserTablePreference` stores `hidden` / `shown` / `order` / `density`, keyed `[userId, tableKey]`. The two lists are separate on purpose: absent from `hidden` means on, so a column added later appears for everyone; absent from `shown` means off, so an `optIn` column added later stays out of the way. A single `visible` array gets both wrong. `resolveTableColumns` (`lib/tables/preferences.ts`) is the pure merge — no React, no Prisma — and is where stale ids are discarded and new columns slotted back beside the column they were declared after.

**`tableKey` names the screen, never the record** — `"event.registrants"`, not `"event.<id>.registrants"`. Someone who has arranged the registrant columns wants that arrangement on the next event too. Preferences are read once per layout by `getTablePreferences` and provided by `TablePreferencesProvider`, so a table has its saved layout on first render rather than flashing defaults. Omit `tableKey` for an embedded sub-list (a per-bus manifest) to render through the same component with no picker.

**Email and mobile cells are copyable.** Use `emailColumn` / `phoneColumn` (`lib/tables/columns/contact.tsx`) rather than writing the cell again — they carry their width token and a `CopyableText` cell whose copy icon appears on row hover and always copies the **full** value, not the truncated one. For a copy affordance outside a table, use `useCopyToClipboard` (`lib/hooks/use-copy-to-clipboard.ts`); don't hand-roll `navigator.clipboard`.

**Not on DataTable, on purpose:** the bus manifest print surface, the cluster dashboard's per-event matrix, the event dashboard chart widget, the import wizard previews, the assistant's markdown/tool renderers, the expanded detail panel inside the Volunteers table, and the **Sessions list** (`sessions-client.tsx`). None of them is a person list, and a column picker on a print manifest is noise.

The Sessions list is the one that used to be a table and isn't any more. A session row is a **control panel, not a record**: three of its four columns were actions, and the whole set had to fit `actions` (52px) as bare icons whose only labels were hover tooltips — which never fire on the tablets sessions are run from, and whose trailing buttons were clipped out of reach besides.

`SessionCard` is **one card at every width**, no breakpoint variants. Two zones with a rule between: what the session *is* on top (date, turnout, the `⋯`), what you *do* with it below (the check-in switch, the kiosk link). Each zone holds two things at opposite edges, which is what keeps it calm — a wide desktop row that put the date at the far left and its controls 800px away at the far right was its own kind of crowding, the eye crossing the page to connect a session to the switch that runs it. Binding them into one object of readable width (`max-w-3xl` on the list) fixes that.

**The control budget is two visible controls plus the menu.** The switch names its own state, so the state needs no second badge; Manage and Delete are structural and rare, so they sit in the `⋯` with their names on — which is what separates it from the icon strip it replaced, where the *primary* action was an unlabelled icon too.

**"Check-in page" appears only when the kiosk would admit someone.** `isCheckinLive` (`lib/events/checkin-link.ts`) is read by both the list and the kiosk's own date gate at `/events/[id]/checkin/[occurrenceId]`, which refuses every visitor unless the session `isOpen` or today *is* its date. The rule used to live only inside the page, so the list offered the button on every card and most led straight to "Check-in not available" — a dead action being the most crowding thing on a card this size. Comparison is on **UTC days** (occurrence dates are stored at UTC midnight) and `today` is resolved on the server and passed down, so the two sides of hydration can't disagree about which card is today.

**A series is a section, not a card.** Each session is a card, and a card holding cards is a border inside a border — the nesting DESIGN.md rules out. A heading with generous space above it groups just as well and takes a whole layer of chrome off the page. The series' own `⋯` and its stat badges sit in the section header, with an `N open` badge when anything is live; the standalone MultiDay list carries the same figure as a `4 days · 1 open` line.

### CSV Exports

Every person-list export offers a **column picker**, never a fixed header row. Four layers, and a new surface writes only the first:

| Layer | Where |
|---|---|
| Column registry (pure — server *and* client import it) | `lib/exports/<surface>.ts` over `lib/exports/columns.ts` |
| Row query + column offer | `lib/exports/<surface>-server.ts`, or the action for small ones |
| Server action (`auth` → `canExport` → `canAccessEvent`) | `.../export-actions.ts` |
| Dialog + download | `useExportColumnsDialog` + a shim in `lib/export-entities.ts` |

`ExportColumnDef.value` is the single definition of a cell, so the picker and the CSV can never disagree. Three rules the shared builder enforces:

- **A value is never hidden.** A `toggle`- or `module`-gated column whose gate is now off still exports when answers exist, flagged *No longer asked*. A gate that is off with nothing behind it is dropped — an all-blank column is noise.
- **`optional: true`** is for facts nobody was ever *asked* (a session's series title, a profile nickname): offered when populated, never flagged.
- **Booleans need `hasData`.** "Yes"/"No" is never blank, so the default emptiness test would offer a Paid column to every free event.

Column offers come from `mergeFormConfigs(await getEffectiveFormConfigs(eventId))` (a cluster unions its member events via `getClusterFormCoverage`): the surface someone registered through isn't recorded, so a field counts as asked if *any* context asks it. Never hand-roll CSV text — `lib/csv-export.ts` owns escaping, CRLF, and the Excel BOM. Export is a utility `PageAction` with `overflow: true`, so the dialog is trigger-less and the screen calls `open()` from `onSelect`. Exports describe the whole list, never the active filter.

### Error Handling
- `try/catch` in all server actions
- Never expose raw Prisma/DB errors to the client
- Show user-facing errors via toast notifications (sonner or shadcn/ui toast)

### Deletes
- Hard delete only. Always show confirmation dialog before destructive actions.

### Timestamps
- Entity models: `createdAt @default(now())` + `updatedAt @updatedAt`
- Immutable join/log models (e.g. `OccurrenceAttendee`, `BreakoutGroupMember`, `BaptismOptIn`): `createdAt` only — no `updatedAt`.
- Store all datetimes in UTC.

### TypeScript
- Strict mode. Prefer `type` over `interface` for plain data shapes. Derive types from Prisma where possible.

---

## Testing

### Coverage Policy — build forward
**Every implementation ships with its tests in the same change — never deferred.** Coverage only accumulates; it must never regress. For each feature or fix, add the layers that fit the change:

| Layer | What it covers | Where |
|---|---|---|
| **Unit** | Pure logic in isolation — scorers, helpers, validators, formatters | `tests/unit/` |
| **Integration** | Server actions + real DB state, truncate→seed→call→assert | `tests/tickets/` (or `tests/integration/`) |
| **Regression** | A test pinning the exact bug being fixed so it cannot return | with the fix |
| **Edge case** | Boundaries, nulls, empty/duplicate inputs, malformed phones, circular refs | with the feature |
| **End-to-end** | User-facing flows across the browser | Playwright (`pnpm test:e2e`) |

- Treat tests as part of **"done,"** not a follow-up. A PR that touches `app/` or `lib/` should touch `tests/`.
- Not every change needs all five layers — pick the ones that fit, but **explicitly call out any layer you skip and why** rather than silently omitting it. (A copy tweak needs no integration/e2e; a new server action needs at minimum unit + integration + edge case.)
- Gate before merge: `pnpm verify:ticket CCF-NNN` (or `pnpm test:unit`) as you go, then `pnpm qa:gate`.

### Setup
- **Test runner:** Vitest (unit + ticket tests), Playwright (e2e)
- **Test database:** local PostgreSQL 16 (`ccf_test`) — separate from staging. Started via `brew services start postgresql@16`.
- **Env:** `.env.test` at project root sets `DATABASE_URL=postgresql://marknoya@localhost/ccf_test`. Vitest loads this automatically via `vitest.config.ts`.
- **`next/cache`** (`revalidatePath`, `revalidateTag`) is globally mocked in `tests/setup.ts` — required for any test that imports a server action.

### Commands

| Command | Purpose |
|---|---|
| `pnpm ticket:test:new CCF-NNN` | Scaffold `tests/tickets/ccf-nnn.test.ts` with unit/integration/regression stubs |
| `pnpm verify:ticket CCF-NNN` | Run just that ticket's test file |
| `pnpm test:tickets` | Run all ticket verification files |
| `pnpm test:unit` | Run unit tests only (`tests/unit/`) |
| `pnpm test` | Run all Vitest tests |
| `pnpm test:e2e` | Run Playwright e2e tests (auto-starts dev server) |
| `pnpm qa:gate` | Full CI gate: lint → vitest → verify:all → build |

### Workflow for a ticket
1. `pnpm ticket:test:new CCF-NNN` — creates the test file with stubs
2. Read the Jira ticket, implement the feature/fix
3. Replace `it.todo` stubs with real assertions
4. `pnpm verify:ticket CCF-NNN` — confirm green
5. `pnpm qa:gate` before merging

### Integration test pattern
Tests that call server actions or touch the DB follow this pattern:

```ts
import { db } from "@/lib/db"
import { myAction } from "@/app/.../actions"

beforeEach(async () => {
  await db.$executeRaw`TRUNCATE "TableA", "TableB" RESTART IDENTITY CASCADE`
})
afterAll(async () => {
  await db.$disconnect()
})

it("...", async () => {
  // 1. Seed minimum required data
  const record = await db.someModel.create({ data: { ... } })
  // 2. Call the action
  const result = await myAction(args)
  // 3. Assert DB state
  expect(result.success).toBe(true)
  const updated = await db.someModel.findUnique({ where: { id: record.id } })
  expect(updated?.field).toBe("expected")
})
```

- The test DB is empty between runs — each test seeds its own data.
- `Member.dateJoined` is required — always pass `dateJoined: new Date()` when seeding.
- Truncate all tables touched by the test (use CASCADE freely — it won't drop the schema).
- No shared fixtures. Tests must be fully self-contained.
