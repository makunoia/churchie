import { describe, expect, it } from "vitest"
import { mergePortalTokens } from "@/lib/people/portal-tokens"

describe("portal tokens across merges", () => {
  it("keeps the primary token and unions aliases without duplicates", () => {
    expect(mergePortalTokens(
      { selfServiceToken: "main", selfServiceTokenAliases: ["old"] },
      { selfServiceToken: "incoming", selfServiceTokenAliases: ["old", "main", "older"] },
    )).toEqual({ selfServiceToken: "main", selfServiceTokenAliases: ["old", "older", "incoming"] })
  })

  it("adopts an incoming primary token when the keeper has none", () => {
    expect(mergePortalTokens(
      { selfServiceToken: null, selfServiceTokenAliases: [] },
      { selfServiceToken: "incoming", selfServiceTokenAliases: ["older"] },
    )).toEqual({ selfServiceToken: "incoming", selfServiceTokenAliases: ["older"] })
  })

  it("supports records with no issued links", () => {
    const empty = { selfServiceToken: null, selfServiceTokenAliases: [] }
    expect(mergePortalTokens(empty, empty)).toEqual(empty)
  })
})
