import { describe, expect, it } from "vitest"
import {
  MERGE_LOG_ACTION,
  describeMerge,
  mergeScalars,
  type MergeSpec,
} from "@/lib/people/merge-fields"

/** Both sides of a merge are loose records — the two rows need not share a table. */
type Row = Record<string, unknown>

const SPEC: MergeSpec = {
  nickname: "keeper-wins",
  workCity: "keeper-wins",
  birthMonth: "keeper-wins",
  notes: "append",
  language: "union",
}

describe("mergeScalars", () => {
  it("fills the keeper's empty fields from the loser", () => {
    const { update, conflicts } = mergeScalars<Row>(
      { workCity: null, nickname: "" },
      { workCity: "Makati", nickname: "JC" },
      SPEC,
    )
    expect(update).toEqual({ workCity: "Makati", nickname: "JC" })
    expect(conflicts).toEqual([])
  })

  it("keeps the keeper's value on a conflict and reports what it discarded", () => {
    const { update, conflicts } = mergeScalars<Row>(
      { workCity: "Makati" },
      { workCity: "Cebu" },
      SPEC,
    )
    expect(update).toEqual({})
    expect(conflicts).toEqual([{ field: "workCity", kept: "Makati", dropped: "Cebu" }])
  })

  it("reports nothing when the two records agree", () => {
    const { update, conflicts } = mergeScalars<Row>(
      { workCity: "Makati" },
      { workCity: "Makati" },
      SPEC,
    )
    expect(update).toEqual({})
    expect(conflicts).toEqual([])
  })

  it("ignores fields the loser left empty", () => {
    const { update, conflicts } = mergeScalars<Row>(
      { workCity: "Makati" },
      { workCity: null, nickname: "   " },
      SPEC,
    )
    expect(update).toEqual({})
    expect(conflicts).toEqual([])
  })

  it("treats 0 as a value, not a gap — birthMonth 0 must not be overwritten", () => {
    // Regression guard: a falsy-but-real answer is not emptiness. `0` is a valid
    // birthMonth and `false` a valid isPaid, so a truthiness test here silently lets the
    // loser overwrite the keeper.
    const { update, conflicts } = mergeScalars<Row>({ birthMonth: 0 }, { birthMonth: 5 }, SPEC)
    expect(update).toEqual({})
    expect(conflicts).toEqual([{ field: "birthMonth", kept: "0", dropped: "5" }])
  })

  it("unions scalar lists instead of contesting them", () => {
    const { update, conflicts } = mergeScalars<Row>(
      { language: ["English"] },
      { language: ["Tagalog", "English"] },
      SPEC,
    )
    expect(update).toEqual({ language: ["English", "Tagalog"] })
    expect(conflicts).toEqual([])
  })

  it("leaves a list alone when the loser adds nothing new", () => {
    const { update } = mergeScalars<Row>(
      { language: ["English", "Tagalog"] },
      { language: ["English"] },
      SPEC,
    )
    expect(update).toEqual({})
  })

  it("takes the loser's list when the keeper has none", () => {
    const { update } = mergeScalars<Row>({ language: [] }, { language: ["Cebuano"] }, SPEC)
    expect(update).toEqual({ language: ["Cebuano"] })
  })

  it("appends notes rather than discarding either side", () => {
    const { update, conflicts } = mergeScalars<Row>(
      { notes: "Prayed to receive Christ" },
      { notes: "Invited by Ana" },
      SPEC,
    )
    expect(update.notes).toBe("Prayed to receive Christ\n\nInvited by Ana")
    expect(conflicts).toEqual([])
  })

  it("does not duplicate identical notes", () => {
    const { update } = mergeScalars<Row>({ notes: "Same" }, { notes: "Same" }, SPEC)
    expect(update).toEqual({})
  })

  it("ignores fields absent from the spec", () => {
    // The spec is an allowlist on purpose: the old subtractive form made every caller
    // remember its own delete list, and the guest branch forgot one.
    const { update, conflicts } = mergeScalars<Row>(
      { secret: null },
      { secret: "leaked", workCity: "Cebu" },
      SPEC,
    )
    expect(update).toEqual({ workCity: "Cebu" })
    expect(conflicts).toEqual([])
  })

  it("compares dates by value, not identity", () => {
    const spec: MergeSpec = { dateJoined: "keeper-wins" }
    const { conflicts } = mergeScalars<Row>(
      { dateJoined: new Date("2026-01-01") },
      { dateJoined: new Date("2026-01-01") },
      spec,
    )
    expect(conflicts).toEqual([])
  })
})

describe("describeMerge", () => {
  const base = {
    loserName: "Juan Cruz",
    loserType: "guest" as const,
    loserId: "guest_123",
    carried: {},
    folds: [],
    conflicts: [],
    performedBy: null,
  }

  it("names the deleted record and its id", () => {
    const text = describeMerge(base)
    expect(text).toContain('Merged and deleted duplicate guest "Juan Cruz" (guest_123).')
  })

  it("attributes the merge when an admin name is known", () => {
    expect(describeMerge({ ...base, performedBy: "Mark" })).toContain("by Mark")
  })

  it("lists what was carried, pluralised", () => {
    const text = describeMerge({
      ...base,
      carried: { registration: 3, "volunteer role": 1, "DGroup request": 0 },
    })
    expect(text).toContain("Carried over: 3 registrations, 1 volunteer role.")
    // A zero count is noise, not information.
    expect(text).not.toContain("DGroup request")
  })

  it("names the events whose duplicate rows were folded", () => {
    const text = describeMerge({
      ...base,
      folds: [
        { kind: "registration", eventName: "Sunday Service" },
        { kind: "registration", eventName: "Retreat" },
        { kind: "volunteer role", eventName: "Retreat" },
      ],
    })
    expect(text).toContain("Combined duplicate registrations on Sunday Service, Retreat into one.")
    expect(text).toContain("Combined duplicate volunteer role on Retreat into one.")
  })

  it("states both sides of every conflict", () => {
    // The whole point: the losing row is deleted, so this line is the only surviving
    // record of the value that was thrown away.
    const text = describeMerge({
      ...base,
      conflicts: [{ field: "email", kept: "a@x.com", dropped: "b@x.com" }],
    })
    expect(text).toContain("Conflicting values — the keeper's were kept:")
    expect(text).toContain('• email: kept "a@x.com", discarded "b@x.com"')
  })

  it("includes conflicts from folded event rows with their event name", () => {
    const text = describeMerge({ ...base, folds: [{
      kind: "registration", eventName: "Retreat", conflicts: [{
        field: "paymentReference", kept: "PAY-A", dropped: "PAY-B",
      }],
    }] })
    expect(text).toContain('Retreat: paymentReference: kept "PAY-A", discarded "PAY-B"')
  })

  it("omits every optional section when there is nothing to say", () => {
    const text = describeMerge(base)
    expect(text).not.toContain("Carried over")
    expect(text).not.toContain("Combined duplicate")
    expect(text).not.toContain("Conflicting values")
  })
})

describe("MERGE_LOG_ACTION", () => {
  it("is stable — stored rows are matched against it on render", () => {
    expect(MERGE_LOG_ACTION).toBe("ProfilesMerged")
  })
})
