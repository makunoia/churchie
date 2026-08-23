"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { IconPencil, IconTrash } from "@tabler/icons-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MultiSelect } from "@/components/ui/multi-select"
import { PersonCombobox } from "@/components/ui/person-combobox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LANGUAGE_OPTIONS } from "@/lib/constants/group-options"
import { updateBreakoutGroup, deleteBreakoutGroup } from "@/app/(dashboard)/events/breakout-actions"
import {
  CLEARED_PROFILE_FORM,
  GENDER_FOCUS_LABELS,
  missingTimothyFields,
} from "@/lib/breakouts/profile"
import { FacilitatorLeadership } from "@/components/breakouts/facilitator-leadership"
import { CatchMechGroupField } from "@/components/breakouts/catch-mech-group-field"
import { BreakoutEnabledSwitch } from "../enabled-switch"
import type { BreakoutSurface } from "@/lib/breakouts/owner"

/** Shown, not inherited — a breakout group's criteria are its own. */
type LedGroup = {
  id: string
  name: string
}

type Volunteer = {
  id: string
  member: { id: string; firstName: string; lastName: string; ledGroups: LedGroup[] }
}

export type EditableGroupData = {
  id: string
  name: string
  facilitatorId: string | null
  memberLimit: number | null
  manualAssignOnly: boolean
  linkedSmallGroupId: string | null
  lifeStages: { id: string }[]
  genderFocus: string | null
  language: string[]
  ageRangeMin: number | null
  ageRangeMax: number | null
}
function EditDialog({
  open,
  onOpenChange,
  group,
  surface,
  lifeStages,
  volunteers,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  group: EditableGroupData
  surface: BreakoutSurface
  lifeStages: { id: string; name: string }[]
  volunteers: Volunteer[]
}) {
  const [form, setForm] = React.useState({
    name: "",
    memberLimit: "",
    manualAssignOnly: false,
    facilitatorId: "",
    lifeStageIds: [] as string[],
    genderFocus: "",
    language: [] as string[],
    ageRangeMin: "",
    ageRangeMax: "",
  })
  const [sourceGroupId, setSourceGroupId] = React.useState("")
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSourceGroupId(group.linkedSmallGroupId ?? "")
      setForm({
        name: group.name,
        memberLimit: group.memberLimit?.toString() ?? "",
        manualAssignOnly: group.manualAssignOnly,
        facilitatorId: group.facilitatorId ?? "",
        lifeStageIds: group.lifeStages.map((ls) => ls.id),
        genderFocus: group.genderFocus ?? "",
        language: group.language ?? [],
        ageRangeMin: group.ageRangeMin?.toString() ?? "",
        ageRangeMax: group.ageRangeMax?.toString() ?? "",
      })
    }
  }, [open, group])

  // Swapping one facilitator for another moves only the Catch Mech routing
  // target: the matching criteria are this group's own and a swap never
  // rewrites them. *Emptying* the slot is the other case — the group is left
  // with no facilitator, so it keeps no criteria either. The server clears them
  // regardless (`updateBreakoutGroup`); blanking the fields here keeps the form
  // showing what is about to be saved.
  function handleVolunteerChange(volunteerId: string) {
    const vol = volunteers.find((v) => v.id === volunteerId)
    const led = vol?.member.ledGroups ?? []
    setSourceGroupId(led.length === 1 ? led[0].id : "")
    setForm((f) => ({
      ...f,
      facilitatorId: volunteerId,
      ...(volunteerId === "" && group.facilitatorId ? CLEARED_PROFILE_FORM : {}),
    }))
  }

  const selectedVol = volunteers.find((v) => v.id === form.facilitatorId) ?? null
  const ledGroups = selectedVol?.member.ledGroups ?? []
  const isFacilitatorTimothy = !!form.facilitatorId && ledGroups.length === 0

  function field(key: string) {
    return {
      value: form[key as keyof typeof form] as string,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value })),
    }
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error("Group name is required"); return }
    if (isFacilitatorTimothy) {
      const missing = missingTimothyFields(form)
      if (missing.length > 0) {
        toast.error(`Timothy profile requires: ${missing.join(", ")}`)
        return
      }
    }
    setSaving(true)
    const result = await updateBreakoutGroup(group.id, surface.owner, {
      name: form.name.trim(),
      facilitatorId: form.facilitatorId || null,
      memberLimit: form.memberLimit ? Number(form.memberLimit) : null,
      manualAssignOnly: form.manualAssignOnly,
      linkedSmallGroupId: sourceGroupId || null,
      lifeStageIds: form.lifeStageIds,
      genderFocus: (form.genderFocus as "Male" | "Female" | "Mixed") || null,
      language: form.language,
      ageRangeMin: form.ageRangeMin ? Number(form.ageRangeMin) : null,
      ageRangeMax: form.ageRangeMax ? Number(form.ageRangeMax) : null,
    })
    setSaving(false)
    if (result.success) {
      toast.success("Breakout group updated")
      onOpenChange(false)
    } else {
      toast.error(result.error)
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="sm:max-w-md flex flex-col">
        <DrawerHeader>
          <DrawerTitle>Edit breakout group</DrawerTitle>
          <DrawerDescription>Update the group&apos;s details and matching profile.</DrawerDescription>
        </DrawerHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-2 space-y-6">
          {/* ── Basic details ── */}
          <div className="space-y-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Group Details
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="edit-bg-name">Name <span className="text-destructive">*</span></Label>
              <Input id="edit-bg-name" placeholder="e.g. Breakout A" autoFocus {...field("name")} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-bg-limit">Member Limit</Label>
              <Input id="edit-bg-limit" type="number" min={1} placeholder="Leave blank for unlimited" {...field("memberLimit")} />
            </div>

            {/* Not under Matching Profile below: that section is captioned "used
                for auto-assign", and this setting is what switches auto-assign
                off for this table. It decides which routes reach the group, not
                which people fit it. */}
            <div className="flex items-start gap-2.5">
              <Checkbox
                id="edit-bg-manual-only"
                checked={form.manualAssignOnly}
                onCheckedChange={(v) => setForm((f) => ({ ...f, manualAssignOnly: v === true }))}
              />
              <div className="space-y-0.5">
                <Label htmlFor="edit-bg-manual-only" className="font-normal">Manual assignment only</Label>
                <p className="text-xs text-muted-foreground">
                  Never suggested and never auto-assigned. Staff and registrants can still choose it.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Facilitator</Label>
              <PersonCombobox
                options={volunteers.map((v) => ({ value: v.id, label: `${v.member.firstName} ${v.member.lastName}` }))}
                value={form.facilitatorId}
                onValueChange={handleVolunteerChange}
                placeholder="Unassigned"
                clearable
                clearLabel="Unassigned"
              />
              {/* Context, not a control — the criteria below are this group's own
                  whichever DGroup the facilitator leads. Inside the field so it
                  reads as this select's footnote, not a stray line. */}
              {form.facilitatorId && !isFacilitatorTimothy && (
                <FacilitatorLeadership ledGroups={ledGroups} linkGroups={false} />
              )}
            </div>

            {form.facilitatorId && ledGroups.length > 1 && (
              <CatchMechGroupField
                id="edit-bg-catch-mech"
                ledGroups={ledGroups}
                value={sourceGroupId}
                onValueChange={setSourceGroupId}
              />
            )}

            {isFacilitatorTimothy && (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                This volunteer does not lead a DGroup yet (Timothy). Set the profile below — it will be used to create their DGroup when their first member is confirmed.
              </p>
            )}
          </div>

          {/* ── Matching profile ──
              Always editable. It used to be swapped for a read-only grid the
              moment the facilitator led a DGroup, because the criteria were a
              copy of that DGroup; they are the group's own now. */}
          <div className="space-y-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {isFacilitatorTimothy
                ? <>Future DGroup Profile <span className="normal-case font-normal text-destructive">(Timothy — required)</span></>
                : <>Matching Profile <span className="normal-case font-normal">(used for auto-assign)</span></>
              }
            </p>

            <div className="space-y-1.5">
              <Label>Life Stages {isFacilitatorTimothy && <span className="text-destructive">*</span>}</Label>
              <MultiSelect
                className="w-full"
                placeholder="Any"
                options={lifeStages.map((ls) => ({ value: ls.id, label: ls.name }))}
                value={form.lifeStageIds}
                onChange={(v) => setForm((f) => ({ ...f, lifeStageIds: v }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Gender Focus {isFacilitatorTimothy && <span className="text-destructive">*</span>}</Label>
              <Select value={form.genderFocus} onValueChange={(v) => setForm((f) => ({ ...f, genderFocus: v }))}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {Object.entries(GENDER_FOCUS_LABELS).map(([v, label]) => (
                    <SelectItem key={v} value={v}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Language {isFacilitatorTimothy && <span className="text-destructive">*</span>}</Label>
              <MultiSelect options={LANGUAGE_OPTIONS} value={form.language} onChange={(v) => setForm((f) => ({ ...f, language: v }))} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Min Age {isFacilitatorTimothy && <span className="text-destructive">*</span>}</Label>
                <Input type="number" min={0} placeholder="—" {...field("ageRangeMin")} />
              </div>
              <div className="space-y-1.5">
                <Label>Max Age {isFacilitatorTimothy && <span className="text-destructive">*</span>}</Label>
                <Input type="number" min={0} placeholder="—" {...field("ageRangeMax")} />
              </div>
            </div>
          </div>
        </div>

        <DrawerFooter>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}

export function GroupActions({
  group,
  surface,
  lifeStages,
  volunteers,
  isEnabled,
}: {
  group: EditableGroupData
  surface: BreakoutSurface
  lifeStages: { id: string; name: string }[]
  volunteers: Volunteer[]
  /** Separate from `group` because it isn't part of the edit form — it's a switch, not a field. */
  isEnabled: boolean
}) {
  const router = useRouter()
  const [editOpen, setEditOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  async function handleDelete() {
    setDeleting(true)
    const result = await deleteBreakoutGroup(group.id, surface.owner)
    setDeleting(false)
    if (result.success) {
      toast.success("Breakout group deleted")
      router.push(`${surface.basePath}/breakouts`)
    } else {
      toast.error(result.error)
    }
  }

  return (
    <>
      <BreakoutEnabledSwitch
        key={`${group.id}-${isEnabled}`}
        groupId={group.id}
        surface={surface}
        isEnabled={isEnabled}
        groupName={group.name}
        showLabel
      />
      <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
        <IconPencil className="size-4" />
        Edit
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() => setDeleteOpen(true)}
      >
        <IconTrash className="size-4" />
        Delete
      </Button>

      <EditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        group={group}
        surface={surface}
        lifeStages={lifeStages}
        volunteers={volunteers}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete breakout group?</DialogTitle>
            <DialogDescription>
              This will remove <span className="font-medium">{group.name}</span> and all its member
              assignments. Registrants will not be deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
