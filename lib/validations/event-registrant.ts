import { z } from "zod"
import { formatPhilippinePhone } from "@/lib/utils"
import { isExternalSatellite } from "@/lib/constants/ccf-satellites"
import { optionalBirthMonth, optionalBirthYear } from "@/lib/validations/birth-date"

// Public registration payload — shared by the single-event form (createRegistrant)
// and the cluster shared form (registerForCluster). Lives outside the "use server"
// action files so both can import the value.
export const registrantSchema = z.object({
  firstName: z.string().min(1, "First name is required").trim(),
  lastName: z.string().min(1, "Last name is required").trim(),
  nickname: z.string().nullish().transform((v) => (v === "" || v == null ? null : v.trim())),
  email: z.string().nullish()
    .transform((v) => v?.trim() || null)
    .pipe(z.email({ error: "Please enter a valid email address." }).nullable()),
  mobileNumber: z.string().nullish().transform((v) => (v === "" || v == null ? null : formatPhilippinePhone(v.trim()))),
  // Birthday — used as fallback matching field when no mobile or email
  birthMonth: optionalBirthMonth,
  birthYear: optionalBirthYear,
  // Coarse age bracket (CCF-123) — an alternative to birth year, not a replacement.
  ageRangeBucketId: z.string().optional().nullable().transform((v) => v || null),
  // Optional matching fields — collected when the event's Small Group registration module is enabled
  lifeStageId: z.string().optional().nullable().transform((v) => v || null),
  gender: z.enum(["Male", "Female"]).optional().nullable(),
  language: z.array(z.string()).optional().default([]),
  meetingPreference: z.enum(["Online", "Hybrid", "InPerson"]).optional().nullable(),
  workCity: z.string().optional().nullable().transform((v) => v || null),
  scheduleDayOfWeek: z.number().int().min(0).max(6).optional().nullable(),
  scheduleTimeStart: z.string().optional().nullable().transform((v) => v || null),
  scheduleTimeEnd: z.string().optional().nullable().transform((v) => v || null),
  claimedSmallGroupId: z.string().optional().nullable().transform((v) => v || null),
  // "…and my DGroup is at another CCF satellite" — the alternative answer when
  // the registrant's group isn't one of ours, so there is no id to send.
  claimedSatellite: z.string().optional().nullable().transform((v) => v || null),
  // "I want to join a DGroup" (CCF-101). Nullable because the payload sanitizer
  // neutralises a disabled field by setting it to null, not false.
  wantsSmallGroup: z.boolean().optional().nullable().transform((v) => v ?? false),
  // Optional dietary fields — collected when the Dietary registration module is enabled
  dietaryPreference: z
    .enum([
      "Vegetarian", "Vegan", "Halal", "Kosher",
      "GlutenFree", "DairyFree", "NutFree", "Pescatarian", "Other",
    ])
    .optional()
    .nullable(),
  dietaryOther: z.string().optional().nullable().transform((v) => v || null),
  // Optional payment reference — collected when the Payment registration module is enabled
  paymentReference: z.string().optional().nullable().transform((v) => v || null),
})
  .transform((data) =>
    // A claimed DGroup is either one of ours or one at another satellite, never
    // both. Naming a satellite wins, so stale client state (a group picked
    // before the person switched answers) can't survive as a bogus link.
    data.claimedSatellite ? { ...data, claimedSmallGroupId: null } : data
  )
  .refine(
    (data) => data.claimedSatellite == null || isExternalSatellite(data.claimedSatellite),
    { message: "Unknown CCF satellite", path: ["claimedSatellite"] }
  )

export type RegistrantData = z.infer<typeof registrantSchema>
export type RegistrantInput = z.input<typeof registrantSchema>
