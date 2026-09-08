import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { db } from "@/lib/db"
import { promoteGuestToMember } from "@/app/(dashboard)/guests/actions"
import {
  PROMOTABLE_GUEST_SELECT,
  buildPromotedMemberData,
  type PromotableGuest,
} from "@/lib/people/promote-guest"

/**
 * CCF-123 regression — an Age Range collected at registration must survive
 * guest→member promotion.
 *
 * Found by audit, not by the original implementation: four separate promotion
 * paths built the new Member from an explicit field list, and all four silently
 * dropped `ageRangeBucketId`. (`nickname` was dropped by three of them, found the
 * same way.) The duplicate-profile merge was fine because it uses a generic
 * `fillNulls` over the whole record instead of a hand-written list — which is
 * exactly why the explicit lists were the fragile ones.
 *
 * The fix was to delete the four lists: `lib/people/promote-guest.ts` now owns the
 * copy. So the guards below no longer chase one column. They check the two things
 * that make a repeat impossible — that no site has grown a private field list
 * again, and that every Guest column is either copied or explicitly excused.
 */

/** Every site that turns a Guest into a Member. */
const PROMOTION_SITES = [
  "app/(dashboard)/guests/actions.ts",
  // Owns the guest promotion for both request-confirmation surfaces — the leader's
  // token form and the admin approving on their behalf. The leader file used to
  // promote inline; it delegates here now, so this is the site that must not grow
  // a private field list.
  "lib/small-groups/resolve-member-request.ts",
  // Moved out of app/events/[id]/catch-mech/actions.ts: everything exported from a
  // "use server" file is a public endpoint, and prefetchRegistrantData sitting there
  // let anyone read guest emails/phones/notes by registrant id.
  "lib/catch-mech/confirmations.ts",
  "app/(event)/event/[id]/catch-mech/matching-actions.ts",
]

/**
 * Sites that resolve a membership request but delegate the promotion itself. They
 * are checked for the hand-copy smell only — the temptation is to "just inline it
 * here" for a new surface, which is how the four lists CCF-123 found came about.
 */
const DELEGATING_SITES = [
  "app/small-group-confirmation/[token]/actions.ts",
  "app/(dashboard)/small-groups/actions.ts",
]

/**
 * Guest columns a promotion is not supposed to copy, each for a stated reason.
 * Anything not listed here must reach the new Member — that is the whole guard.
 * Adding a column to this list should require justifying it in review.
 */
const INTENTIONALLY_NOT_COPIED: Record<string, string> = {
  id: "the Member gets its own id",
  createdAt: "when the Guest row appeared, not when they became a member",
  updatedAt: "managed by Prisma",
  memberId: "the promotion link itself",
  claimedSmallGroupId: "a self-reported claim, superseded by the real placement",
  claimedSatellite: "same — a self-reported claim, not a member attribute",
  selfServiceToken:
    "the guest's own portal token; promotion mints a fresh Member.selfServiceToken rather than reusing it",
  selfServiceTokenAliases:
    "remain on the retained guest; the portal follows its promotion link to the member",
  scheduleDayOfWeek: "becomes a SchedulePreference row, not a Member column",
  scheduleTimeStart: "becomes a SchedulePreference row, not a Member column",
  scheduleTimeEnd: "becomes a SchedulePreference row, not a Member column",
}

/** Scalar column names on the Guest model, read straight from the schema. */
function guestScalarColumns(): string[] {
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8")
  const model = schema.match(/^model Guest \{$([\s\S]*?)^\}$/m)
  if (!model) throw new Error("Could not find the Guest model in prisma/schema.prisma")

  const relationTypes = /^(Member|Guest|LifeStage|AgeRangeBucket|SmallGroup|EventRegistrant|SmallGroupMemberRequest|SmallGroupLog|FamilyMember)\b/

  return model[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line && !line.startsWith("@@"))
    .map((line) => line.split(/\s+/))
    .filter(([, type]) => type && !relationTypes.test(type))
    .map(([name]) => name)
}

beforeEach(async () => {
  await db.$executeRaw`TRUNCATE
    "SmallGroupMemberRequest", "SmallGroupLog", "SmallGroup", "Member", "Guest",
    "AgeRangeBucket", "FamilyMember", "Family"
    RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await db.$disconnect()
})

describe("CCF-123 regression — promotion carries every guest column", () => {
  it("no promotion site keeps a private copy of the field list", () => {
    // A guard against the next person adding a promotion path — or quietly
    // reintroducing a hand-written one next to the shared helper.
    for (const site of PROMOTION_SITES) {
      const source = readFileSync(join(process.cwd(), site), "utf8")
      expect(
        source.includes("@/lib/people/promote-guest"),
        `${site} must promote through lib/people/promote-guest`
      ).toBe(true)
      expect(
        /firstName:\s*guest\.firstName/.test(source),
        `${site} must not hand-copy guest fields onto a Member — use buildPromotedMemberData`
      ).toBe(false)
    }

    for (const site of DELEGATING_SITES) {
      const source = readFileSync(join(process.cwd(), site), "utf8")
      expect(
        /firstName:\s*guest\.firstName/.test(source),
        `${site} must not hand-copy guest fields onto a Member — delegate to resolveMemberRequest`
      ).toBe(false)
    }
  })

  it("every Guest column is either copied onto the Member or explicitly excused", () => {
    // The real CCF-123 fix: a new Guest column now fails this test instead of
    // silently vanishing at promotion time.
    const expected = guestScalarColumns().filter((c) => !(c in INTENTIONALLY_NOT_COPIED))
    // Without this the loop below passes vacuously if the schema parse ever drifts.
    expect(expected.length, "schema parse found no copyable Guest columns").toBeGreaterThan(10)

    // A fixture with every field populated, so a dropped column shows up as a
    // missing key rather than an indistinguishable null.
    const guest = Object.fromEntries(
      Object.keys(PROMOTABLE_GUEST_SELECT).map((k) => [k, k === "language" ? ["en"] : `${k}-value`])
    ) as unknown as PromotableGuest
    const { data } = buildPromotedMemberData(guest, { dateJoined: new Date() })

    for (const column of expected) {
      expect(
        Object.keys(PROMOTABLE_GUEST_SELECT),
        `PROMOTABLE_GUEST_SELECT must read Guest.${column}`
      ).toContain(column)
      expect(
        data[column as keyof typeof data],
        `buildPromotedMemberData must carry Guest.${column} onto the Member`
      ).toBe(guest[column as keyof PromotableGuest])
    }
  })

  it("carries the bracket through promoteGuestToMember", async () => {
    const bucket = await db.ageRangeBucket.create({
      data: { label: "30 – 39", minAge: 30, maxAge: 39, order: 3 },
      select: { id: true },
    })
    const leader = await db.member.create({
      data: { firstName: "Lead", lastName: "Er", dateJoined: new Date(), language: [] },
      select: { id: true },
    })
    const group = await db.smallGroup.create({
      data: { name: "Group A", leaderId: leader.id, status: "Active" },
      select: { id: true },
    })
    const guest = await db.guest.create({
      data: {
        firstName: "Ella",
        lastName: "Santos",
        phone: "+63 917 222 3333",
        language: [],
        ageRangeBucketId: bucket.id,
      },
      select: { id: true },
    })

    const result = await promoteGuestToMember(guest.id, group.id)
    expect(result.success).toBe(true)

    const promoted = await db.guest.findUniqueOrThrow({
      where: { id: guest.id },
      select: { memberId: true },
    })
    expect(promoted.memberId).not.toBeNull()

    const member = await db.member.findUniqueOrThrow({
      where: { id: promoted.memberId as string },
      select: { ageRangeBucketId: true },
    })
    expect(member.ageRangeBucketId).toBe(bucket.id)
  })

  it("leaves the bracket null when the guest never picked one", async () => {
    const leader = await db.member.create({
      data: { firstName: "Lead", lastName: "Er", dateJoined: new Date(), language: [] },
      select: { id: true },
    })
    const group = await db.smallGroup.create({
      data: { name: "Group B", leaderId: leader.id, status: "Active" },
      select: { id: true },
    })
    const guest = await db.guest.create({
      data: { firstName: "No", lastName: "Bracket", language: [] },
      select: { id: true },
    })

    expect((await promoteGuestToMember(guest.id, group.id)).success).toBe(true)

    const promoted = await db.guest.findUniqueOrThrow({
      where: { id: guest.id },
      select: { memberId: true },
    })
    const member = await db.member.findUniqueOrThrow({
      where: { id: promoted.memberId as string },
      select: { ageRangeBucketId: true },
    })
    expect(member.ageRangeBucketId).toBeNull()
  })
})
