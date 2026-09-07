import { describe, expect, it } from "vitest"
import { registrantSchema } from "@/lib/validations/event-registrant"

const person = { firstName: "Ana", lastName: "Cruz" }

describe("registration email validation", () => {
  it.each([
    "not-an-email", "ana@", "@example.com", "ana@example",
    "ana@@example.com", "ana cruz@example.com", "ana@example..com",
    ".ana@example.com", "ana..cruz@example.com", "ana@example.com extra",
  ])("rejects malformed email %s", (email) => {
    const result = registrantSchema.safeParse({ ...person, email })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ["email"], message: "Please enter a valid email address.",
      })
    }
  })

  it.each(["ana@example.com", "Ana.Cruz+church@example.com", "ana@sub.example.org"])(
    "accepts and trims valid email %s", (email) => {
      expect(registrantSchema.parse({ ...person, email: `  ${email}  ` }).email).toBe(email)
    }
  )

  it.each([undefined, null, "", "   "])("keeps optional email %j as null", (email) => {
    expect(registrantSchema.parse({ ...person, email }).email).toBeNull()
  })
})
