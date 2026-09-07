/**
 * The field-level conflict policy for a duplicate-profile merge.
 *
 * Pure — no `db`, no Prisma imports beyond types — because the policy is the part
 * worth testing exhaustively and the transaction around it is not. `merge-profiles.ts`
 * owns the writes; this file owns the question "what should the keeper end up with,
 * and what did we have to throw away to get there".
 *
 * That second half is new and is the whole point. The merge deletes the losing rows,
 * so a value the keeper didn't take is gone for good — where before it at least
 * survived on a row somebody could go and look at. Every dropped value therefore comes
 * back as a `FieldConflict` for the caller to write onto the keeper's timeline.
 */

/** A loser value the keeper refused, kept so the merge can report it. */
export type FieldConflict = {
  field: string
  /** The keeper's value that won. Never empty — an empty keeper field is filled, not contested. */
  kept: string
  /** The loser's value that was discarded. */
  dropped: string
}

/**
 * How one field behaves when both records hold a value.
 *
 * - `"keeper-wins"` — the default and the rule the UI promises. The loser's value is
 *   reported as a conflict rather than written.
 * - `"append"` — free text where both sides can be true at once (`notes`). Never
 *   conflicts; the loser's text is appended under an attribution line.
 * - `"union"` — scalar lists (`language`). Never conflicts; the two sets are merged.
 *   This replaces the old "copy only when the keeper's array is empty", which silently
 *   dropped a language the loser alone spoke.
 */
export type MergeStrategy = "keeper-wins" | "append" | "union"

export type MergeSpec = Record<string, MergeStrategy>

type Value = unknown

/**
 * Empty for merge purposes: null, undefined, a blank/whitespace-only string, or an
 * empty array. `0` and `false` are values, not emptiness — `birthMonth: 0` is a real
 * answer and `isPaid: false` is a real answer, so neither may be treated as a gap the
 * loser gets to fill.
 */
function isEmpty(v: Value): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === "string") return v.trim() === ""
  if (Array.isArray(v)) return v.length === 0
  return false
}

/** Display form for a conflict report. Dates render as ISO, everything else via String(). */
function display(v: Value): string {
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.join(", ")
  return String(v)
}

function sameValue(a: Value, b: Value): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => x === b[i])
  }
  return a === b
}

export type MergeScalarsResult<T> = {
  /** Fields to write onto the keeper. Empty when the keeper already had everything. */
  update: Partial<T>
  /** Loser values that lost a contest. Empty when nothing was contested. */
  conflicts: FieldConflict[]
}

/**
 * Resolves every field the loser holds against the keeper.
 *
 * Only keys present on `loser` are considered, and only keys listed in `spec` are
 * considered at all — an explicit allowlist rather than "everything minus a delete
 * list". The old `fillNulls` used the subtractive form and every branch that called it
 * had to remember its own `delete fill.x` lines; the guest→member branch forgot one
 * (`notes`, with a comment claiming it was handled elsewhere) and mishandled another
 * (`groupStatus` copied without `smallGroupId`). An allowlist can't drift that way.
 */
export function mergeScalars<T extends Record<string, unknown>>(
  keeper: T,
  // Deliberately not `Partial<T>`: the loser is a different row and may be a different
  // table entirely — a Guest folding into a Member shares only some of its columns.
  loser: Record<string, unknown>,
  spec: MergeSpec,
): MergeScalarsResult<T> {
  const update: Partial<T> = {}
  const conflicts: FieldConflict[] = []

  for (const [field, strategy] of Object.entries(spec)) {
    if (!(field in loser)) continue
    const lv = loser[field] as Value
    const kv = keeper[field as keyof T] as Value

    if (isEmpty(lv)) continue

    const keeperEmpty = isEmpty(kv)

    if (strategy === "union") {
      const kArr = Array.isArray(kv) ? (kv as unknown[]) : []
      const lArr = Array.isArray(lv) ? (lv as unknown[]) : []
      const merged = [...kArr]
      for (const item of lArr) if (!merged.includes(item)) merged.push(item)
      if (merged.length !== kArr.length) {
        update[field as keyof T] = merged as T[keyof T]
      }
      continue
    }

    if (keeperEmpty) {
      update[field as keyof T] = lv as T[keyof T]
      continue
    }

    if (sameValue(kv, lv)) continue

    if (strategy === "append") {
      update[field as keyof T] = `${String(kv).trimEnd()}\n\n${String(lv).trim()}` as T[keyof T]
      continue
    }

    conflicts.push({ field, kept: display(kv), dropped: display(lv) })
  }

  return { update, conflicts }
}

// ─── Merge report ─────────────────────────────────────────────────────────────

/** A duplicate child row the merge collapsed rather than carried twice. */
export type FoldSummary = {
  /** `"registration"` / `"volunteer role"` — pluralised by `describeMerge`. */
  kind: string
  /** The event the two rows shared. */
  eventName: string
  conflicts?: FieldConflict[]
}

export type MergeReport = {
  /** The deleted record, as it read at merge time. */
  loserName: string
  loserType: "member" | "guest"
  loserId: string
  /** Rows carried onto the keeper, e.g. `{ registrations: 3, volunteerRoles: 1 }`. */
  carried: Record<string, number>
  folds: FoldSummary[]
  conflicts: FieldConflict[]
  /** Admin who ran the merge. `MemberLog` has no actor column, so it goes in the text. */
  performedBy: string | null
}

/** The `MemberLog.action` value for a merge entry. */
export const MERGE_LOG_ACTION = "ProfilesMerged"

/**
 * The `MemberLog.description` for one absorbed record.
 *
 * Written to be read by a person six months later trying to work out where a value
 * went, so it names the deleted record explicitly (including its id, which is the only
 * way to correlate it with anything else) and states every conflict as
 * "kept X, discarded Y" rather than just noting that one occurred.
 */
export function describeMerge(report: MergeReport): string {
  const lines: string[] = []

  const who = report.performedBy ? ` by ${report.performedBy}` : ""
  lines.push(
    `Merged and deleted duplicate ${report.loserType} "${report.loserName}" (${report.loserId})${who}.`,
  )

  const carried = Object.entries(report.carried).filter(([, n]) => n > 0)
  if (carried.length > 0) {
    lines.push(
      `Carried over: ${carried.map(([label, n]) => `${n} ${plural(label, n)}`).join(", ")}.`,
    )
  }

  if (report.folds.length > 0) {
    const byKind = new Map<string, string[]>()
    for (const f of report.folds) {
      byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f.eventName])
    }
    for (const [kind, events] of byKind) {
      lines.push(
        `Combined duplicate ${plural(kind, events.length)} on ${events.join(", ")} into one.`,
      )
    }
  }

  const conflicts = [...report.conflicts, ...report.folds.flatMap(f =>
    (f.conflicts ?? []).map(c => ({ ...c, field: `${f.eventName}: ${c.field}` })))]
  if (conflicts.length > 0) {
    lines.push("Conflicting values — the keeper's were kept:")
    for (const c of conflicts) {
      lines.push(`• ${c.field}: kept "${c.kept}", discarded "${c.dropped}"`)
    }
  }

  return lines.join("\n")
}

/** Naive pluralisation — the labels here are all regular nouns. */
function plural(label: string, n: number): string {
  if (n === 1) return label
  return label.endsWith("s") ? label : `${label}s`
}
