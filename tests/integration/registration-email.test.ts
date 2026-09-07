import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { db } from "@/lib/db"
import { createRegistrant } from "@/app/(dashboard)/events/actions"
import { registerForCluster } from "@/app/(dashboard)/events/cluster-actions"

// Unit tests cover syntax and empty values; these pin rejection before writes.
// E2E is skipped because this changes server validation, not the browser flow.
beforeEach(async () => {
  await db.$executeRaw`TRUNCATE "EventRegistrant", "Guest", "Member", "Event" RESTART IDENTITY CASCADE`
})
afterAll(async () => { await db.$disconnect() })

const person = { firstName: "Ana", lastName: "Cruz", mobileNumber: "09171234567" }

async function makeEvent() {
  return db.event.create({ data: {
    name: "Email validation", type: "OneTime",
    startDate: new Date("2026-09-01"), endDate: new Date("2026-09-01"),
  } })
}

describe("registration email persistence", () => {
  it.each([false, true])("rejects invalid email without creating records (walk-in: %s)", async (walkIn) => {
    const event = await makeEvent()
    const result = await createRegistrant(event.id, { ...person, email: "ana@example" },
      null, null, false, null, walkIn ? { occurrenceId: null } : undefined)
    expect(result).toEqual({ success: false, error: "Please enter a valid email address." })
    expect(await db.guest.count()).toBe(0)
    expect(await db.eventRegistrant.count()).toBe(0)
  })

  it("rejects invalid cluster submissions before person resolution", async () => {
    const result = await registerForCluster("unused-token", { ...person, email: "ana@@example.com" },
      null, null, false, [])
    expect(result).toEqual({ success: false, error: "Please enter a valid email address." })
    expect(await db.guest.count()).toBe(0)
    expect(await db.eventRegistrant.count()).toBe(0)
  })

  it("does not overwrite a confirmed member's email with malformed input", async () => {
    const event = await makeEvent()
    const member = await db.member.create({ data: {
      firstName: "Ana", lastName: "Cruz", email: "ana@example.com", dateJoined: new Date(), language: [],
    } })
    const result = await createRegistrant(event.id, { ...person, email: "invalid" }, member.id)
    expect(result.success).toBe(false)
    expect((await db.member.findUniqueOrThrow({ where: { id: member.id } })).email).toBe("ana@example.com")
    expect(await db.eventRegistrant.count()).toBe(0)
  })

  it.each(["  Ana.Cruz+church@example.com  ", null, ""])("still registers valid or omitted email %j", async (email) => {
    const event = await makeEvent()
    const result = await createRegistrant(event.id, { ...person, email }, null)
    expect(result.success).toBe(true)
    expect((await db.guest.findFirstOrThrow()).email).toBe(email?.trim() || null)
    expect(await db.eventRegistrant.count()).toBe(1)
  })
})
