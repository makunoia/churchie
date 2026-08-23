"use client"

import * as React from "react"
import Link from "next/link"
import {
  IconDots,
  // IconLoader, // CCF-124: re-enable with the Auto-Assign button
  IconPencil,
  IconPlus,
  // IconSparkles, // CCF-124: re-enable with the Auto-Assign button
  IconTrash,
  IconUpload,
  IconUsers,
} from "@tabler/icons-react"
import { type ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DataTable } from "@/components/ui/data-table"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MultiSelect } from "@/components/ui/multi-select"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PageHeader, PageActions, type PageAction } from "@/components/page-header"
import { FilterBar, FilterField } from "@/components/filter-bar"
import { ImportWizard } from "@/components/import/import-wizard"
import { LANGUAGE_OPTIONS } from "@/lib/constants/group-options"
import {
  CLEARED_PROFILE_FORM,
  GENDER_FOCUS_LABELS,
  formatAgeRange,
  missingTimothyFields,
} from "@/lib/breakouts/profile"
import { FacilitatorLeadership } from "@/components/breakouts/facilitator-leadership"
import { CatchMechGroupField } from "@/components/breakouts/catch-mech-group-field"
import {
  createBreakoutGroup,
  updateBreakoutGroup,
  deleteBreakoutGroup,
  // autoAssignBreakouts, // CCF-124: re-enable with the Auto-Assign button
} from "@/app/(dashboard)/events/breakout-actions"
import { breakoutOccupancy } from "@/lib/breakouts/occupancy"
import { isClusterOwner, type BreakoutSurface } from "@/lib/breakouts/owner"
import { BreakoutEnabledSwitch } from "./enabled-switch"
import { checkBreakoutDuplicates, importBreakoutGroups } from "./import-actions"

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Shown, not inherited — a breakout group's criteria are its own. */
type LedGroup = {
  id: string
  name: string
}

type Volunteer = {
  id: string
  member: { id: string; firstName: string; lastName: string; ledGroups: LedGroup[] }
}

export type BreakoutGroupRow = {
  id: string
  name: string
  facilitatorId: string | null
  facilitator: { id: string; member: { id: string; firstName: string; lastName: string; ledGroups: LedGroup[] } } | null
  coFacilitatorId: string | null
  coFacilitator: { id: string; member: { id: string; firstName: string; lastName: string; ledGroups: LedGroup[] } } | null
  memberLimit: number | null
  memberCount: number
  isEnabled: boolean
  manualAssignOnly: boolean
  linkedSmallGroupId: string | null
  linkedSmallGroup: { id: string; name: string } | null
  lifeStages: { id: string; name: string }[]
  genderFocus: string | null
  language: string[]
  ageRangeMin: number | null
  ageRangeMax: number | null
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function volunteerName(v: { member: { firstName: string; lastName: string } }) {
  return `${v.member.firstName} ${v.member.lastName}`
}

// ─── Group form drawer (create / edit) ─────────────────────────────────────────

const EMPTY_FORM = {
  name: "",
  memberLimit: "",
  manualAssignOnly: false,
  facilitatorId: "",
  lifeStageIds: [] as string[],
  genderFocus: "",
  language: [] as string[],
  ageRangeMin: "",
  ageRangeMax: "",
}

type GroupFormDialogProps = {
  open: boolean
  onOpenChange: (v: boolean) => void
  surface: BreakoutSurface
  group?: BreakoutGroupRow
  lifeStages: { id: string; name: string }[]
  volunteers: Volunteer[]
  defaultLifeStageIds?: string[]
}

function GroupFormDialog({ open, onOpenChange, surface, group, lifeStages, volunteers, defaultLifeStageIds = [] }: GroupFormDialogProps) {
  const isEdit = !!group
  const [form, setForm] = React.useState(EMPTY_FORM)
  const [sourceGroupId, setSourceGroupId] = React.useState("")
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSourceGroupId(group?.linkedSmallGroupId ?? "")
      setForm(
        group
          ? {
              name: group.name,
              memberLimit: group.memberLimit?.toString() ?? "",
              manualAssignOnly: group.manualAssignOnly,
              facilitatorId: group.facilitatorId ?? "",
              lifeStageIds: group.lifeStages.map((ls) => ls.id),
              genderFocus: group.genderFocus ?? "",
              language: group.language ?? [],
              ageRangeMin: group.ageRangeMin?.toString() ?? "",
              ageRangeMax: group.ageRangeMax?.toString() ?? "",
            }
          : { ...EMPTY_FORM, lifeStageIds: defaultLifeStageIds }
      )
    }
  }, [open, group, defaultLifeStageIds])

  // Swapping one facilitator for another moves only the Catch Mech routing
  // target — the matching criteria are this group's own and a swap never
  // rewrites them. Emptying the slot on an existing group is the other case: it
  // clears the profile server-side (`updateBreakoutGroup`), so the fields are
  // blanked here to match. On a new group there is nothing to clear.
  function handleVolunteerChange(volunteerId: string) {
    const vol = volunteers.find((v) => v.id === volunteerId)
    const led = vol?.member.ledGroups ?? []
    setSourceGroupId(led.length === 1 ? led[0].id : "")
    setForm((f) => ({
      ...f,
      facilitatorId: volunteerId,
      ...(volunteerId === "" && group?.facilitatorId ? CLEARED_PROFILE_FORM : {}),
    }))
  }

  const selectedVolunteer = volunteers.find((v) => v.id === form.facilitatorId) ?? null
  const ledGroups = selectedVolunteer?.member.ledGroups ?? []
  const isFacilitatorTimothy = !!form.facilitatorId && ledGroups.length === 0

  function field(key: keyof typeof EMPTY_FORM) {
    return {
      value: form[key] as string,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value })),
    }
  }

  async function handleSubmit() {
    if (!form.name.trim()) { toast.error("Group name is required"); return }
    if (isFacilitatorTimothy) {
      const missing = missingTimothyFields(form)
      if (missing.length > 0) {
        toast.error(`Timothy profile requires: ${missing.join(", ")}`)
        return
      }
    }
    setSaving(true)
    const data = {
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
    }
    const result = isEdit
      ? await updateBreakoutGroup(group.id, surface.owner, data)
      : await createBreakoutGroup(surface.owner, data)
    setSaving(false)
    if (result.success) {
      toast.success(isEdit ? "Breakout group updated" : "Breakout group created")
      onOpenChange(false)
    } else {
      toast.error(result.error)
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="sm:max-w-md flex flex-col">
        <DrawerHeader>
          <DrawerTitle>{isEdit ? "Edit breakout group" : "New breakout group"}</DrawerTitle>
          <DrawerDescription>
            {isEdit
              ? "Update the group's details and matching profile."
              : "Create a new group. You can assign facilitators and registrants after saving."}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-2 space-y-6">
          {/* ── Basic details ── */}
          <div className="space-y-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Group Details
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="bg-name">Name <span className="text-destructive">*</span></Label>
              <Input id="bg-name" placeholder="e.g. Breakout A" autoFocus {...field("name")} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bg-limit">Member Limit</Label>
              <Input id="bg-limit" type="number" min={1} placeholder="Leave blank for unlimited" {...field("memberLimit")} />
            </div>

            {/* Not under Matching Profile below: that section is captioned "used
                for auto-assign", and this setting is what switches auto-assign
                off for this table. It decides which routes reach the group, not
                which people fit it. */}
            <div className="flex items-start gap-2.5">
              <Checkbox
                id="bg-manual-only"
                checked={form.manualAssignOnly}
                onCheckedChange={(v) => setForm((f) => ({ ...f, manualAssignOnly: v === true }))}
              />
              <div className="space-y-0.5">
                <Label htmlFor="bg-manual-only" className="font-normal">Manual assignment only</Label>
                <p className="text-xs text-muted-foreground">
                  Never suggested and never auto-assigned. Staff and registrants can still choose it.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bg-facilitator">Facilitator</Label>
              <Select value={form.facilitatorId} onValueChange={(v) => handleVolunteerChange(v === "_none" ? "" : v)}>
                <SelectTrigger id="bg-facilitator"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">Unassigned</SelectItem>
                  {volunteers.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{volunteerName(v)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Context, not a control — the criteria below are this group's own
                  whichever DGroup the facilitator leads. Inside the field so it
                  reads as this select's footnote, not a stray line. */}
              {form.facilitatorId && !isFacilitatorTimothy && (
                <FacilitatorLeadership ledGroups={ledGroups} linkGroups={false} />
              )}
            </div>

            {form.facilitatorId && ledGroups.length > 1 && (
              <CatchMechGroupField
                id="bg-catch-mech"
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
                <Label htmlFor="bg-agemin">Min Age {isFacilitatorTimothy && <span className="text-destructive">*</span>}</Label>
                <Input id="bg-agemin" type="number" min={0} placeholder="—" {...field("ageRangeMin")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bg-agemax">Max Age {isFacilitatorTimothy && <span className="text-destructive">*</span>}</Label>
                <Input id="bg-agemax" type="number" min={0} placeholder="—" {...field("ageRangeMax")} />
              </div>
            </div>
          </div>
        </div>

        <DrawerFooter>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create group"}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}

// ─── Delete dialog ──────────────────────────────────────────────────────────────

function DeleteGroupDialog({
  group,
  onOpenChange,
  surface,
}: {
  group: BreakoutGroupRow | null
  onOpenChange: (open: boolean) => void
  surface: BreakoutSurface
}) {
  const [deleting, setDeleting] = React.useState(false)

  async function handleDelete() {
    if (!group) return
    setDeleting(true)
    const result = await deleteBreakoutGroup(group.id, surface.owner)
    setDeleting(false)
    if (result.success) {
      toast.success("Breakout group deleted")
      onOpenChange(false)
    } else {
      toast.error(result.error)
    }
  }

  return (
    <Dialog open={!!group} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete breakout group?</DialogTitle>
          <DialogDescription>
            This will remove <span className="font-medium">{group?.name}</span> and all its member
            assignments. Registrants will not be deleted.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>Cancel</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Row actions ────────────────────────────────────────────────────────────────

function RowActions({
  row,
  onEdit,
  onDelete,
}: {
  row: BreakoutGroupRow
  onEdit: (group: BreakoutGroupRow) => void
  onDelete: (group: BreakoutGroupRow) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8">
          <span className="sr-only">Open menu</span>
          <IconDots className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onEdit(row)}>
          <IconPencil className="mr-2 size-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => onDelete(row)}
          className="text-destructive focus:text-destructive"
        >
          <IconTrash className="mr-2 size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ─── Columns ────────────────────────────────────────────────────────────────────

export function buildColumns(
  surface: BreakoutSurface,
  onEdit: (group: BreakoutGroupRow) => void,
  onDelete: (group: BreakoutGroupRow) => void,
  onNavigate?: () => void,
): ColumnDef<BreakoutGroupRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      meta: { label: "Name", width: "name", locked: true, noTruncate: true },
      // The badge, not just the switch: a row you are scanning past should say
      // it is out of play without your eye having to reach the last column. The
      // same goes for a table held back for manual assignment, which has no
      // switch at all — it is set inside the edit drawer, so the badge is the
      // only place the state is visible from the list.
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Link
            href={`${surface.basePath}/breakouts/${row.original.id}`}
            onClick={onNavigate}
            className={`font-medium underline decoration-dashed underline-offset-2 decoration-foreground/50 hover:decoration-foreground transition-colors${
              row.original.isEnabled ? "" : " text-muted-foreground"
            }`}
          >
            {row.original.name}
          </Link>
          {!row.original.isEnabled && (
            <Badge variant="outline" className="text-xs text-muted-foreground">Off</Badge>
          )}
          {/* Only alongside an *on* group: "Off" already says nothing arrives
              automatically, so both badges together would say it twice. */}
          {row.original.isEnabled && row.original.manualAssignOnly && (
            <Badge variant="outline" className="text-xs text-muted-foreground">Manual only</Badge>
          )}
        </div>
      ),
    },
    {
      id: "facilitator",
      header: "Facilitator",
      meta: { label: "Facilitator", width: "name" },
      accessorFn: (row) => row.facilitator ? volunteerName(row.facilitator) : "",
      cell: ({ row }) =>
        row.original.facilitator ? (
          <span>{volunteerName(row.original.facilitator)}</span>
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        ),
    },
    {
      id: "coFacilitator",
      header: "Co-Facilitator",
      // Off by default: the slot is empty on most tables, and a column of
      // "Unassigned" earns nothing. It is offered because a co-facilitator is a
      // real staffing fact — they may answer for the table in Catch Mech, and a
      // day staffed in pairs wants to see both names without opening each group.
      meta: { label: "Co-Facilitator", width: "name", optIn: true },
      accessorFn: (row) => (row.coFacilitator ? volunteerName(row.coFacilitator) : ""),
      cell: ({ row }) =>
        row.original.coFacilitator ? (
          <span>{volunteerName(row.original.coFacilitator)}</span>
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        ),
    },
    {
      id: "members",
      header: "Members",
      // Left, though `align: "right"` is the rule for counts, because this cell
      // is not a bare count: it is an occupancy plus an optional "Full" badge,
      // laid out in a flex row. Right-aligning it would have cost twice over —
      // a block-level box lays its children out from the left whatever the
      // cell's `text-align` says, which is why "3 / 8" sat a column-width to
      // the left of its own "Members" header; and had it followed, every row
      // carrying a badge would push its number left, so the figures would stop
      // lining up with each other, which is the only reason to right-align a
      // number in the first place.
      meta: { label: "Members", width: "narrow" },
      accessorFn: (row) => row.memberCount,
      cell: ({ row }) => {
        const occupancy = breakoutOccupancy(row.original)
        return (
          <div className="flex items-center gap-1.5">
            <span className="tabular-nums">{occupancy.label}</span>
            {occupancy.isFull && (
              <Badge variant="outline" className="text-xs text-muted-foreground">Full</Badge>
            )}
          </div>
        )
      },
    },
    // The matching profile, one column per factor and in the same order the
    // detail card lists them (`profileRows`). Unset reads "Any", not "—": on a
    // breakout group an empty factor means "matches everyone", and a dash would
    // have an admin scanning the column read it as "nobody filled this in".
    // Life Stage is the one that earns its place by default — the other three
    // are opt-in, because most days a table's name already implies them.
    {
      id: "lifeStage",
      header: "Life Stage",
      meta: { label: "Life Stage", width: "status" },
      accessorFn: (row) => row.lifeStages.map((ls) => ls.name).join(", "),
      cell: ({ row }) =>
        row.original.lifeStages.length > 0 ? (
          <span>{row.original.lifeStages.map((ls) => ls.name).join(", ")}</span>
        ) : (
          <span className="text-muted-foreground">Any</span>
        ),
    },
    {
      id: "genderFocus",
      header: "Gender Focus",
      meta: { label: "Gender Focus", width: "status", optIn: true },
      accessorFn: (row) =>
        row.genderFocus ? (GENDER_FOCUS_LABELS[row.genderFocus] ?? row.genderFocus) : "",
      cell: ({ row }) =>
        row.original.genderFocus ? (
          <span>{GENDER_FOCUS_LABELS[row.original.genderFocus] ?? row.original.genderFocus}</span>
        ) : (
          <span className="text-muted-foreground">Any</span>
        ),
    },
    {
      id: "language",
      header: "Language",
      meta: { label: "Language", width: "text", optIn: true },
      accessorFn: (row) => row.language.join(", "),
      cell: ({ row }) =>
        row.original.language.length > 0 ? (
          <span>{row.original.language.join(", ")}</span>
        ) : (
          <span className="text-muted-foreground">Any</span>
        ),
    },
    {
      id: "ageRange",
      header: "Age Range",
      // Sorts on the lower bound, so an open-ended range still lands where an
      // admin expects; "Any" (both bounds unset) sorts last rather than as 0.
      meta: { label: "Age Range", width: "narrow", optIn: true },
      accessorFn: (row) =>
        row.ageRangeMin ?? row.ageRangeMax ?? Number.POSITIVE_INFINITY,
      cell: ({ row }) => {
        const value = formatAgeRange(row.original.ageRangeMin, row.original.ageRangeMax)
        return value === "Any" ? (
          <span className="text-muted-foreground">Any</span>
        ) : (
          <span className="tabular-nums">{value}</span>
        )
      },
    },
    {
      id: "enabled",
      header: "Enabled",
      meta: { label: "Enabled", width: "narrow" },
      accessorFn: (row) => (row.isEnabled ? 1 : 0),
      cell: ({ row }) => (
        <BreakoutEnabledSwitch
          key={`${row.original.id}-${row.original.isEnabled}`}
          groupId={row.original.id}
          surface={surface}
          isEnabled={row.original.isEnabled}
          groupName={row.original.name}
        />
      ),
    },
    {
      id: "actions",
      meta: { width: "actions", locked: true },
      cell: ({ row }) => (
        <RowActions
          row={row.original}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ),
    },
  ]
}

// ─── Main table component ───────────────────────────────────────────────────────

type Props = {
  surface: BreakoutSurface
  breakoutGroups: BreakoutGroupRow[]
  registrantCount: number
  unassignedCount: number
  volunteers: Volunteer[]
  lifeStages: { id: string; name: string }[]
  defaultLifeStageIds?: string[]
  canImport?: boolean
  /**
   * Surface-specific header actions (e.g. a cluster day's "Carry over breakouts").
   * They join the "⋯" menu beside New Group rather than each surface growing its
   * own button row above the table.
   */
  extraActions?: PageAction[]
}

export function BreakoutGroupsTable({
  surface,
  breakoutGroups,
  registrantCount,
  unassignedCount,
  volunteers,
  lifeStages,
  defaultLifeStageIds = [],
  canImport = false,
  extraActions = [],
}: Props) {
  const [search, setSearch] = React.useState("")
  const [lifeStageFilter, setLifeStageFilter] = React.useState("_all")
  const [statusFilter, setStatusFilter] = React.useState<"_all" | "enabled" | "disabled">("_all")
  const [createOpen, setCreateOpen] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const [editingGroup, setEditingGroup] = React.useState<BreakoutGroupRow | null>(null)
  const [deletingGroup, setDeletingGroup] = React.useState<BreakoutGroupRow | null>(null)
  // CCF-124: auto-assign UI hidden — const [autoAssigning, setAutoAssigning] = React.useState(false)

  const filtered = React.useMemo(() => {
    let rows = breakoutGroups
    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter(
        (g) =>
          g.name.toLowerCase().includes(q) ||
          (g.facilitator && volunteerName(g.facilitator).toLowerCase().includes(q))
      )
    }
    if (lifeStageFilter !== "_all") {
      rows = rows.filter((g) => g.lifeStages.some((ls) => ls.id === lifeStageFilter))
    }
    if (statusFilter !== "_all") {
      rows = rows.filter((g) => g.isEnabled === (statusFilter === "enabled"))
    }
    return rows
  }, [breakoutGroups, search, lifeStageFilter, statusFilter])

  const hasFilters = search.trim() !== "" || lifeStageFilter !== "_all" || statusFilter !== "_all"

  const saveBreakoutIds = React.useCallback(() => {
    sessionStorage.setItem("breakoutListIds", JSON.stringify(filtered.map((g) => g.id)))
  }, [filtered])

  const columns = React.useMemo(
    () => buildColumns(surface, setEditingGroup, setDeletingGroup, saveBreakoutIds),
    [surface, saveBreakoutIds]
  )

  // CCF-124: auto-assign handler hidden pending refinement — re-enable with the button below.
  // async function handleAutoAssign() {
  //   setAutoAssigning(true)
  //   const result = await autoAssignBreakouts(surface.owner)
  //   setAutoAssigning(false)
  //   if (result.success) {
  //     const { assigned, skipped } = result.data
  //     if (assigned === 0) {
  //       toast.info("No registrants could be assigned — all groups may be at capacity.")
  //     } else if (skipped > 0) {
  //       toast.success(`${assigned} registrant${assigned !== 1 ? "s" : ""} assigned. ${skipped} skipped (no suitable group with capacity).`)
  //     } else {
  //       toast.success(`${assigned} registrant${assigned !== 1 ? "s" : ""} auto-assigned.`)
  //     }
  //   } else {
  //     toast.error(result.error)
  //   }
  // }

  const headerActions: PageAction[] = [
    // CCF-124: Auto-Assign action temporarily hidden pending refinement of the
    // matching behavior. The flow (handleAutoAssign → autoAssignBreakouts) is
    // intact — uncomment to re-enable. See https://marknoya.atlassian.net/browse/CCF-124
    // ...(unassignedCount > 0 && breakoutGroups.length > 0
    //   ? [{
    //       label: autoAssigning ? "Assigning…" : "Auto-Assign",
    //       icon: autoAssigning ? (
    //         <IconLoader className="size-4 animate-spin" />
    //       ) : (
    //         <IconSparkles className="size-4" />
    //       ),
    //       onSelect: () => { void handleAutoAssign() },
    //       disabled: autoAssigning,
    //     }]
    //   : []),
    ...extraActions,
    ...(canImport
      ? [{
          label: "Import",
          icon: <IconUpload className="size-4" />,
          onSelect: () => setImportOpen(true),
          overflow: true,
        }]
      : []),
  ]

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Breakout Groups"
        description={
          unassignedCount === 0
            ? `All ${registrantCount} registrants assigned`
            : `${unassignedCount} of ${registrantCount} unassigned`
        }
        actions={
          <PageActions
            primary={{
              label: "New Group",
              icon: <IconPlus className="size-4" />,
              onSelect: () => setCreateOpen(true),
            }}
            actions={headerActions}
          />
        }
      />

      <FilterBar
        searchValue={search}
        searchPlaceholder="Search by name or facilitator…"
        onSearch={setSearch}
        activeCount={
          (lifeStageFilter !== "_all" ? 1 : 0) + (statusFilter !== "_all" ? 1 : 0)
        }
        onClear={() => {
          setSearch("")
          setLifeStageFilter("_all")
          setStatusFilter("_all")
        }}
      >
        <FilterField label="Life stage">
          <Select value={lifeStageFilter} onValueChange={setLifeStageFilter}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Life stage" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all">All life stages</SelectItem>
              {lifeStages.map((ls) => (
                <SelectItem key={ls.id} value={ls.id}>{ls.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="Status">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all">All groups</SelectItem>
              <SelectItem value="enabled">Enabled</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
      </FilterBar>

      {/* Table */}
      <div className="hidden md:flex md:flex-1 md:flex-col">
        <DataTable
          tableKey="event.breakout-members"
          rowLabel={{ one: "member", many: "members" }}
          columns={columns}
          data={filtered}
          emptyState={
            <>
              <IconUsers className="size-8" />
              <p className="text-sm">{hasFilters ? "No groups match your filters." : "No breakout groups yet."}</p>
            </>
          }
        />
      </div>

      {/* Mobile cards */}
      <div className="flex flex-col gap-2 md:hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
            <IconUsers className="size-8" />
            <p className="text-sm">{hasFilters ? "No groups match your filters." : "No breakout groups yet."}</p>
          </div>
        ) : (
          filtered.map((group) => (
            <Link
              key={group.id}
              href={`${surface.basePath}/breakouts/${group.id}`}
              onClick={saveBreakoutIds}
              className="rounded-lg border bg-card p-4 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <p className={`font-medium${group.isEnabled ? "" : " text-muted-foreground"}`}>
                  {group.name}
                  {group.isEnabled && group.manualAssignOnly && (
                    <Badge variant="outline" className="ml-2 align-middle text-xs font-normal text-muted-foreground">
                      Manual only
                    </Badge>
                  )}
                </p>
                <div onClick={(e) => e.stopPropagation()}>
                  <RowActions row={group} onEdit={setEditingGroup} onDelete={setDeletingGroup} />
                </div>
              </div>
              <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <span className="text-muted-foreground">Status</span>
                {/* preventDefault as well as stopPropagation: the whole card is a
                    Link, and stopping propagation alone still lets it navigate. */}
                <div onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
                  <BreakoutEnabledSwitch
                    key={`${group.id}-${group.isEnabled}`}
                    groupId={group.id}
                    surface={surface}
                    isEnabled={group.isEnabled}
                    groupName={group.name}
                    showLabel
                  />
                </div>
                <span className="text-muted-foreground">Facilitator</span>
                <span>{group.facilitator ? volunteerName(group.facilitator) : <span className="text-muted-foreground">Unassigned</span>}</span>
                <span className="text-muted-foreground">Members</span>
                <span className="flex items-center gap-1.5">
                  <span className="tabular-nums">{breakoutOccupancy(group).label}</span>
                  {breakoutOccupancy(group).isFull && (
                    <Badge variant="outline" className="text-xs text-muted-foreground">Full</Badge>
                  )}
                </span>
                {group.lifeStages.length > 0 && (
                  <>
                    <span className="text-muted-foreground">Life Stage</span>
                    <span>{group.lifeStages.map((ls) => ls.name).join(", ")}</span>
                  </>
                )}
              </div>
            </Link>
          ))
        )}
      </div>

      {/* Dialogs */}
      <GroupFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        surface={surface}
        lifeStages={lifeStages}
        volunteers={volunteers}
        defaultLifeStageIds={defaultLifeStageIds}
      />
      <GroupFormDialog
        open={!!editingGroup}
        onOpenChange={(open) => { if (!open) setEditingGroup(null) }}
        surface={surface}
        group={editingGroup ?? undefined}
        lifeStages={lifeStages}
        volunteers={volunteers}
        defaultLifeStageIds={defaultLifeStageIds}
      />
      <DeleteGroupDialog
        group={deletingGroup}
        onOpenChange={(open) => { if (!open) setDeletingGroup(null) }}
        surface={surface}
      />
      {/* CSV import is event-only. `importBreakoutGroups` matches facilitators
          against one event's volunteers and creates event-owned groups, and a
          Collab cluster's equivalent is Carry over, which copies a member event's
          tables in. Offering this here would silently create groups the cluster
          page then couldn't see. */}
      {canImport && !isClusterOwner(surface.owner) && (
        <ImportWizard
          config={{
            entity: "breakout-group",
            context: { eventId: surface.owner.eventId },
            useExistingEnriches: true,
          }}
          open={importOpen}
          onOpenChange={setImportOpen}
          onCheckDuplicates={(rows) =>
            checkBreakoutDuplicates({ eventId: (surface.owner as { eventId: string }).eventId }, rows)
          }
          onImport={(rows) =>
            importBreakoutGroups({ eventId: (surface.owner as { eventId: string }).eventId }, rows)
          }
        />
      )}
    </div>
  )
}
