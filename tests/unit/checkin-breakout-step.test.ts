import { readFileSync } from "fs"
import { join } from "path"
import { describe, expect, it } from "vitest"

import {
  deriveLegacyEventFormConfig,
  fieldsForContext,
  formLayoutFor,
  FORM_TOGGLE_KEYS,
} from "@/lib/forms/context-config"
import {
  clusterCheckInNotApplicableToggles,
  clusterNotApplicableToggles,
  clusterOffersBreakoutStep,
} from "@/lib/forms/cluster-sections"

/**
 * Check-in can now offer the breakout step (CCF-149).
 *
 * It used to be listed as inapplicable there, on the reasoning that check-in only
 * ever *shows* the group someone was already assigned. That left the people the
 * step exists for with nowhere to go: someone arriving unseated on an event with
 * auto-assign off was placed by nobody, and the kiosk is the last moment anyone
 * asks.
 *
 * These tests pin the three layers that had to agree before the toggle could
 * appear, and the one that must NOT change — an existing event stays off.
 */

describe("the Check-in layout offers a Breakout section", () => {
  const layout = formLayoutFor("CheckIn")

  it("includes sectionBreakout", () => {
    expect(layout.map((s) => s.key)).toContain("sectionBreakout")
  })

  it("puts it after the DGroup prompt, mirroring the kiosk's step order", () => {
    // The board asks for a profile inside the DGroup steps, and gender plus life
    // stage are the two answers the suggestion turns on. A builder that listed the
    // breakout section first would describe a form that doesn't exist.
    const keys = layout.map((s) => s.key)
    expect(keys.indexOf("sectionBreakout")).toBeGreaterThan(keys.indexOf("sectionSmallGroup"))
  })

  it("adds no fields of its own", () => {
    const section = layout.find((s) => s.key === "sectionBreakout")
    expect(section?.fields).toEqual([])
    expect(section?.options).toEqual([])
    // ...and therefore doesn't widen what Check-in may ask for.
    expect(fieldsForContext("CheckIn")).not.toContain("fieldBirthDate")
  })

  it("still has no Payment section — check-in is not a till", () => {
    expect(layout.map((s) => s.key)).not.toContain("sectionPayment")
  })
})

describe("the builder no longer hides it", () => {
  const builder = readFileSync(
    join(process.cwd(), "components/forms/event-form-builder.tsx"),
    "utf8"
  )
  const checkInNotApplicable = /NOT_APPLICABLE[\s\S]*?CheckIn:\s*\[([\s\S]*?)\]/.exec(builder)

  it("drops sectionBreakout from NOT_APPLICABLE.CheckIn", () => {
    expect(checkInNotApplicable).not.toBeNull()
    expect(checkInNotApplicable![1]).not.toContain(`"sectionBreakout"`)
  })

  it("keeps the toggles that really are inapplicable", () => {
    // Asserted by membership rather than as an exact literal, so the list can grow.
    for (const key of ["sectionPayment", "fieldBirthDate", "fieldMobile", "fieldEmail"]) {
      expect(checkInNotApplicable![1]).toContain(`"${key}"`)
    }
  })
})

describe("existing events stay exactly as they were", () => {
  it("derives Check-in's breakout section as off", () => {
    // The backfill's mapping. Every event that predates this change keeps a
    // check-in that asks nothing extra, whatever its auto-assign setting is.
    for (const autoAssignBreakout of [true, false]) {
      const config = deriveLegacyEventFormConfig(
        {
          formIncludeSmallGroup: true,
          formIncludeDietary: true,
          formIncludePayment: true,
          autoAssignBreakout,
        },
        "CheckIn"
      )
      expect(config.sectionBreakout).toBe(false)
    }
  })

  it("still derives it from auto-assign for Register", () => {
    const on = deriveLegacyEventFormConfig(
      {
        formIncludeSmallGroup: false,
        formIncludeDietary: false,
        formIncludePayment: false,
        autoAssignBreakout: true,
      },
      "Register"
    )
    expect(on.sectionBreakout).toBe(false)
  })
})

describe("a cluster day's check-in kiosk", () => {
  it("offers the breakout toggle on a Collab and nothing else", () => {
    const na = clusterCheckInNotApplicableToggles("Collab")
    expect(na).not.toContain("sectionBreakout")
    // The board has no DGroup prompt, no profile form and no household step, so
    // every toggle those would drive is unhonoured rather than merely off.
    expect(na).toContain("sectionSmallGroup")
    expect(na).toContain("sectionFamily")
    expect(na).toContain("sectionDietary")
    expect(na).toContain("fieldGender")
  })

  it("offers nothing at all on a Parallel day", () => {
    // A Parallel day owns no tables — the same rule the shared form draws.
    expect(clusterCheckInNotApplicableToggles("Parallel")).toEqual([...FORM_TOGGLE_KEYS])
    expect(clusterOffersBreakoutStep("Parallel")).toBe(false)
  })

  it("keeps the registration form's own rule unchanged", () => {
    expect(clusterNotApplicableToggles("Collab")).not.toContain("sectionBreakout")
    expect(clusterNotApplicableToggles("Parallel")).toContain("sectionBreakout")
  })
})

describe("the facilitator-gate warning names the door alone", () => {
  const server = readFileSync(
    join(process.cwd(), "lib/forms/form-prerequisites-server.ts"),
    "utf8"
  )

  it("stays off Check-in, whose pool is ungated", () => {
    // The door gates on the facilitator being in the room, because there a
    // staffer is handing someone over and an unstaffed table is a handover to
    // nobody. The kiosk asked with the same gated pool for exactly one commit
    // (CCF-149) before it was widened to every enabled table: a table whose host
    // hasn't arrived yet is the ordinary state of the first half hour, so the
    // gate left an `awaiting-facilitator` notice where the suggestion should be.
    // The warning has to follow, or it explains an emptiness that no longer
    // happens there.
    //
    // Asserted over *every* copy of the branch: there are two — the event's and
    // the cluster's — and changing only one is the drift this guards against.
    const matches = [
      ...server.matchAll(/staffedGroups === 0[\s\S]*?contexts: \[([^\]]*)\]/g),
    ]
    expect(matches.length).toBe(2)
    for (const match of matches) {
      expect(match[1]).toContain(`"WalkIn"`)
      expect(match[1]).not.toContain(`"CheckIn"`)
    }
  })
})
