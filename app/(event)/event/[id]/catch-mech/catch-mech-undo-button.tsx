"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { IconArrowBackUp, IconLoader } from "@tabler/icons-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { reopenCatchMechRequest } from "./matching-actions"

type Props = {
  requestId: string
  eventId: string
  /** "Confirmed" or "Rejected" — drives the confirmation copy */
  decision: "Confirmed" | "Rejected"
}

export function CatchMechUndoButton({ requestId, eventId, decision }: Props) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)

  async function handleConfirm() {
    setPending(true)
    const res = await reopenCatchMechRequest(requestId, eventId)
    setPending(false)
    if (res.success) {
      toast.success("Decision undone — moved back to Pending")
      setOpen(false)
      router.refresh()
    } else {
      toast.error(res.error)
    }
  }

  const body =
    decision === "Confirmed"
      // The guest half is conditional: `undoCatchMechDecision` only unwinds a promotion
      // while the guest row is still there. A duplicate-profile merge deletes it, and
      // then the undo keeps the member record rather than resurrecting an identity the
      // admin deliberately merged away.
      ? "This removes the person from the DGroup and moves them back to Pending. If they were promoted from a guest and that guest record still exists, their member record is deleted and the guest is restored."
      : "This reopens the rejection and moves the person back to Pending, awaiting the leader's decision again."

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          title="Undo decision"
        >
          <IconArrowBackUp className="size-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Undo this {decision.toLowerCase()} decision?</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              void handleConfirm()
            }}
            disabled={pending}
          >
            {pending ? <IconLoader className="size-4 animate-spin" /> : null}
            Undo
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
