-- A breakout group can be held back for manual assignment.
--
-- `isEnabled` was the only lever, and it is all-or-nothing: switching a table
-- off removes it from every automatic AND public route at once, so it vanishes
-- from the registrant's dropdown and the kiosk's browse list too. There was no
-- way to say "don't *push* people here, but let anyone who wants it choose it"
-- — the shape of an overflow table held in reserve, a table for a named list, or
-- a facilitator's group they intend to fill by hand.
--
-- `manualAssignOnly` closes the automatic half only. The suggested-table card,
-- the kiosk suggestion, `autoAssignBreakout` at registration and the walk-in
-- door, the admin match card and `autoAssignBreakouts` all skip it; every
-- dropdown, the admin add/transfer screens and the group's own candidate picker
-- keep offering it.
--
-- Note it is deliberately not a `where` fragment on the candidate query the way
-- `isEnabled` is: `suggestBreakoutGroup` and `breakoutPickerOptions` are fed by
-- ONE loaded set, so the flag travels on the candidate and is applied in
-- `isEligible` alone. Only `matchBreakoutGroups`, which has no browse list
-- beside it, filters on the column in SQL.
--
-- Defaults to false — every table that exists today is in the matcher's rotation
-- and must stay there on deploy, so no backfill is needed.
--
-- Written idempotently per CLAUDE.md so a partial run can be safely retried.

ALTER TABLE "BreakoutGroup"
  ADD COLUMN IF NOT EXISTS "manualAssignOnly" BOOLEAN NOT NULL DEFAULT false;
