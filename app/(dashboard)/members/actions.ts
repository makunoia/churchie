"use server"

import { revalidatePath } from "next/cache"
import { Prisma } from "@/app/generated/prisma/client"
import { db } from "@/lib/db"
import { memberSchema, type MemberFormValues } from "@/lib/validations/member"

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string }

export async function createMember(
  raw: MemberFormValues
): Promise<ActionResult<{ id: string }>> {
  const parsed = memberSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    }
  }

  try {
    const member = await db.member.create({
      data: {
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        address: parsed.data.address ?? null,
        dateJoined: parsed.data.dateJoined,
        notes: parsed.data.notes ?? null,
        lifeStageId: parsed.data.lifeStageId ?? null,
        gender: parsed.data.gender ?? null,
        language: parsed.data.language ?? null,
        birthDate: parsed.data.birthDate ?? null,
        workCity: parsed.data.workCity ?? null,
        workIndustry: parsed.data.workIndustry ?? null,
        meetingPreference: parsed.data.meetingPreference ?? null,
      },
      select: { id: true },
    })
    revalidatePath("/members")
    return { success: true, data: { id: member.id } }
  } catch (e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { success: false, error: "A member with this email already exists" }
    }
    return { success: false, error: "Failed to create member" }
  }
}

export async function updateMember(
  id: string,
  raw: MemberFormValues
): Promise<ActionResult> {
  const parsed = memberSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    }
  }

  try {
    await db.member.update({
      where: { id },
      data: {
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        address: parsed.data.address ?? null,
        dateJoined: parsed.data.dateJoined,
        notes: parsed.data.notes ?? null,
        lifeStageId: parsed.data.lifeStageId ?? null,
        gender: parsed.data.gender ?? null,
        language: parsed.data.language ?? null,
        birthDate: parsed.data.birthDate ?? null,
        workCity: parsed.data.workCity ?? null,
        workIndustry: parsed.data.workIndustry ?? null,
        meetingPreference: parsed.data.meetingPreference ?? null,
      },
    })
    revalidatePath("/members")
    return { success: true, data: undefined }
  } catch (e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { success: false, error: "A member with this email already exists" }
    }
    return { success: false, error: "Failed to update member" }
  }
}

export async function deleteMember(id: string): Promise<ActionResult> {
  try {
    await db.member.delete({ where: { id } })
    revalidatePath("/members")
    return { success: true, data: undefined }
  } catch {
    return { success: false, error: "Failed to delete member" }
  }
}
