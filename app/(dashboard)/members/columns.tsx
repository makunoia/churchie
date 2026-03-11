"use client"

import * as React from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { IconDots, IconPencil, IconTrash } from "@tabler/icons-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { deleteMember } from "./actions"
import { MemberDialog } from "./member-dialog"

export type MemberRow = {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  smallGroupName: string | null
  lifeStage: string | null
  dateJoined: string
  // For edit form pre-fill
  address: string | null
  notes: string | null
  lifeStageId: string | null
  gender: string | null
  language: string | null
  birthDate: string | null
  workCity: string | null
  workIndustry: string | null
  meetingPreference: string | null
}

function RowActions({
  row,
  lifeStages,
}: {
  row: MemberRow
  lifeStages: { id: string; name: string }[]
}) {
  const [editOpen, setEditOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  async function handleDelete() {
    setDeleting(true)
    const result = await deleteMember(row.id)
    setDeleting(false)
    if (result.success) {
      toast.success("Member deleted")
      setDeleteOpen(false)
    } else {
      toast.error(result.error)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <span className="sr-only">Open menu</span>
            <IconDots className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <IconPencil className="mr-2 size-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setDeleteOpen(true)}
            className="text-destructive focus:text-destructive"
          >
            <IconTrash className="mr-2 size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <MemberDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        member={row}
        lifeStages={lifeStages}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete member</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium">
                {row.firstName} {row.lastName}
              </span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function buildColumns(
  lifeStages: { id: string; name: string }[]
): ColumnDef<MemberRow>[] {
  return [
    {
      accessorFn: (row) => `${row.firstName} ${row.lastName}`,
      id: "name",
      header: "Name",
    },
    {
      accessorKey: "email",
      header: "Email",
      cell: ({ row }) =>
        row.original.email ?? (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: "phone",
      header: "Mobile",
      cell: ({ row }) =>
        row.original.phone ?? (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: "smallGroupName",
      header: "Small Group",
      cell: ({ row }) =>
        row.original.smallGroupName ?? (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: "lifeStage",
      header: "Life Stage",
      cell: ({ row }) =>
        row.original.lifeStage ?? (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: "dateJoined",
      header: "Date Joined",
      cell: ({ row }) =>
        new Date(row.original.dateJoined).toLocaleDateString("en-PH", {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <RowActions row={row.original} lifeStages={lifeStages} />
      ),
    },
  ]
}
