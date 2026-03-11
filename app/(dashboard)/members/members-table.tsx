"use client"

import { DataTable } from "@/components/ui/data-table"
import { IconUsers } from "@tabler/icons-react"
import { buildColumns, type MemberRow } from "./columns"

export function MembersTable({
  members,
  lifeStages,
}: {
  members: MemberRow[]
  lifeStages: { id: string; name: string }[]
}) {
  const columns = buildColumns(lifeStages)

  return (
    <DataTable
      columns={columns}
      data={members}
      emptyState={
        <>
          <IconUsers className="size-8" />
          <p className="text-sm">No members yet</p>
        </>
      }
    />
  )
}
