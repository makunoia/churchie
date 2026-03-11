import { db } from "@/lib/db"
import { type MemberRow } from "./columns"
import { MembersTable } from "./members-table"
import { MembersToolbar } from "./toolbar"

async function getMembers(): Promise<MemberRow[]> {
  const members = await db.member.findMany({
    orderBy: { dateJoined: "desc" },
    include: {
      lifeStage: { select: { id: true, name: true } },
      smallGroup: { select: { name: true } },
    },
  })

  return members.map((m) => ({
    id: m.id,
    firstName: m.firstName,
    lastName: m.lastName,
    email: m.email,
    phone: m.phone,
    smallGroupName: m.smallGroup?.name ?? null,
    lifeStage: m.lifeStage?.name ?? null,
    dateJoined: m.dateJoined.toLocaleDateString("en-PH", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
    // For edit pre-fill
    address: m.address,
    notes: m.notes,
    lifeStageId: m.lifeStageId,
    gender: m.gender,
    language: m.language,
    birthDate: m.birthDate
      ? m.birthDate.toISOString().split("T")[0]
      : null,
    workCity: m.workCity,
    workIndustry: m.workIndustry,
    meetingPreference: m.meetingPreference,
  }))
}

async function getLifeStages() {
  return db.lifeStage.findMany({
    orderBy: { order: "asc" },
    select: { id: true, name: true },
  })
}

export default async function MembersPage() {
  const [members, lifeStages] = await Promise.all([
    getMembers(),
    getLifeStages(),
  ])

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Members</h2>
          <p className="text-sm text-muted-foreground">
            Manage church member records
          </p>
        </div>
        <MembersToolbar lifeStages={lifeStages} />
      </div>

      <MembersTable members={members} lifeStages={lifeStages} />
    </div>
  )
}
