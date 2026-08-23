"use client"

import * as React from "react"
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TableColumnsDrawer } from "@/components/tables/table-columns-drawer"
import { useTablePreference } from "@/components/tables/table-preferences-provider"
import { columnStyles, tableMinWidth } from "@/lib/tables/column-sizing"
import { plural } from "@/lib/format/plural"
import {
  resolveTableColumns,
  type TableColumnSpec,
} from "@/lib/tables/preferences"
import { cn } from "@/lib/utils"

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  emptyState?: React.ReactNode
  /**
   * Identifies this *kind* of table for the saved column layout — "members",
   * "event.registrants". Never include a record id: an admin who arranges the
   * registrant columns wants that arrangement on the next event too.
   *
   * Omit only for a table nobody should be able to customise (an embedded
   * summary); the column picker disappears with it.
   */
  tableKey?: string
  /** Rendered beside the Columns button, at the right end of the toolbar. */
  toolbar?: React.ReactNode
  /**
   * The noun the toolbar's row count uses — `{ one: "event", many: "events" }`.
   * Irregular plurals are spelled out rather than derived, so a list of
   * families doesn't count "familys". Defaults to rows.
   */
  rowLabel?: { one: string; many: string }
  /**
   * Show the whole list at once: no pagination footer, and no page cap on the
   * rows either. It is for short, fixed-length tables — a bus manifest, one
   * session's breakout groups — where a footer would be chrome for a single
   * page. Both halves matter: hiding only the footer left the row model still
   * capped at `initialPageSize` with the remaining rows unreachable.
   */
  hidePagination?: boolean
  /** Rows per page. Ignored under `hidePagination`, which shows every row. */
  initialPageSize?: number
  /** Sub-rows, for tables that expand a row into detail. */
  getSubRows?: (row: TData) => TData[] | undefined
  /**
   * Makes the whole row activatable — for tables whose row opens a detail
   * sheet rather than navigating. Columns marked `meta.stopRowClick` (the
   * checkbox, the "⋯" menu) keep their clicks to themselves.
   */
  onRowClick?: (row: TData) => void
  /**
   * Detail rendered in a full-width row beneath this one, or `null` when the
   * row is collapsed. Expansion state stays with the caller: these panels hold
   * a differently-shaped table rather than more rows of the same shape, so
   * TanStack's own sub-row model doesn't describe them.
   */
  renderSubRow?: (row: TData) => React.ReactNode
}

/**
 * The one table.
 *
 * Three things it does that the previous version did not:
 *
 * 1. **Sizes columns from a shared vocabulary.** A `<colgroup>` built from each
 *    column's `meta.width` plus `table-fixed` means an Email column is the same
 *    width on every screen. Before, the primitive's blanket `whitespace-nowrap`
 *    over `table-layout: auto` sized every column to whatever data it happened
 *    to hold, so no two screens agreed and one long address pushed the whole
 *    table into a horizontal scroll.
 * 2. **Lets the admin choose the columns**, persisted to their account.
 * 3. **Owns its own toolbar**, so the picker costs a screen nothing but a
 *    `tableKey` — and doesn't spend one of the three slots `PageActions` allows
 *    in the page header.
 */
export function DataTable<TData, TValue>({
  columns,
  data,
  emptyState,
  tableKey,
  toolbar,
  rowLabel = { one: "row", many: "rows" },
  hidePagination = false,
  initialPageSize = 10,
  getSubRows,
  onRowClick,
  renderSubRow,
}: DataTableProps<TData, TValue>) {
  "use no memo"
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize: initialPageSize })
  // The space the table has to fill. Column floors can only be honoured against
  // a real number, and `table-layout: fixed` will not take a `calc()` — see
  // `columnStyles`. Null until measured, which is what the server renders with.
  const frame = React.useRef<HTMLDivElement>(null)
  const available = useAvailableWidth(frame)

  const { preference, setPreference, resetPreference } = useTablePreference(tableKey ?? "")

  // A table that hides its footer has to actually show every row: there is no
  // control left to reach a second page with. One page big enough for the whole
  // list is how that is said to TanStack — `pageSize` must stay ≥ 1, and the
  // count is of top-level rows, which is what pagination measures.
  const effectivePagination = hidePagination
    ? { pageIndex: 0, pageSize: Math.max(data.length, 1) }
    : pagination

  // What the picker needs to know, derived from each column's own `meta` so a
  // column is described in exactly one place.
  const specs = React.useMemo<TableColumnSpec[]>(
    () =>
      columns.flatMap((column) => {
        const id = columnId(column)
        if (!id) return []
        const meta = column.meta
        return [
          {
            id,
            label: meta?.label ?? (typeof column.header === "string" ? column.header : id),
            // A column with no picker label is plumbing (the checkbox, the "⋯"
            // menu): always locked, and left out of the picker rather than
            // listed as a mystery row named after its internal id.
            locked: meta?.locked ?? !meta?.label,
            optIn: meta?.optIn ?? false,
            structural: !meta?.label,
          },
        ]
      }),
    [columns],
  )

  const layout = React.useMemo(
    () => resolveTableColumns(specs, tableKey ? preference : null),
    [specs, preference, tableKey],
  )

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnFilters,
      columnVisibility: layout.visibility,
      columnOrder: layout.order,
      pagination: effectivePagination,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onPaginationChange: setPagination,
    getSubRows,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  })

  const visibleColumns = table.getVisibleLeafColumns()
  const widths = visibleColumns.map((c) => c.columnDef.meta?.width)
  const minWidth = tableMinWidth(widths)
  const styles = columnStyles(widths, available)
  const rows = table.getRowModel().rows
  const compact = layout.density === "Compact"
  // What's actually on screen, not what was handed in: on a tree table this is
  // the top-level rows, so a list of people counts people rather than
  // people-plus-their-children.
  const rowCount = table.getFilteredRowModel().rows.length

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-lg border">
      {(tableKey || toolbar) && (
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          {/* The strip used to be `justify-end` with nothing but the picker in
              it, so its left half was empty on every screen in the app. The
              count is what the row of chrome is for: how much list you're
              looking at. How much of it you've *selected* is the page header's
              job — `SelectionSummary` already says that, and saying it twice
              three inches apart helps nobody. */}
          <p className="text-sm text-muted-foreground tabular-nums">
            {plural(rowCount, rowLabel.one, rowLabel.many)}
          </p>
          <div className="flex items-center gap-2">
            {toolbar}
            {tableKey && (
              <TableColumnsDrawer
                specs={specs}
                preference={preference}
                onChange={setPreference}
                onReset={resetPreference}
              />
            )}
          </div>
        </div>
      )}

      <div ref={frame} className="flex min-h-0 flex-1 flex-col">
        <Table
          data-density={layout.density}
          containerClassName="min-h-0 flex-1"
          className="table-fixed"
          style={{ minWidth }}
        >
          {/* The whole point of the rewrite: widths come from the column's
              declared token, not from whatever text landed in the cells. */}
          <colgroup>
            {visibleColumns.map((column, index) => (
              <col key={column.id} style={styles[index]} />
            ))}
          </colgroup>
          <TableHeader className="sticky top-0 z-10 bg-muted">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(
                      "truncate",
                      compact && "h-8",
                      header.column.columnDef.meta?.width === "actions" &&
                        ACTIONS_CELL_CLASS,
                      header.column.columnDef.meta?.align === "right" && "text-right",
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          {rows.length > 0 && (
            <TableBody>
              {rows.map((row) => {
                const subRow = renderSubRow?.(row.original)
                return (
                  <React.Fragment key={row.id}>
                    {/* `group/row` is what reveals the per-cell copy buttons;
                        see components/ui/copyable-text.tsx. */}
                    <TableRow
                      className={cn("group/row", onRowClick && "cursor-pointer")}
                      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const meta = cell.column.columnDef.meta
                        return (
                          <TableCell
                            key={cell.id}
                            onClick={
                              meta?.stopRowClick
                                ? (event) => event.stopPropagation()
                                : undefined
                            }
                            className={cn(
                              compact ? "py-1.5" : "py-3",
                              meta?.noTruncate ? "whitespace-normal" : "truncate",
                              meta?.width === "actions" && ACTIONS_CELL_CLASS,
                              meta?.align === "right" && "text-right",
                            )}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                    {subRow && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={visibleColumns.length} className="p-0">
                          {subRow}
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                )
              })}
            </TableBody>
          )}
        </Table>
        {rows.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
            {emptyState ?? <p className="text-sm">No results.</p>}
          </div>
        )}
      </div>

      {!hidePagination && (
        <div className="flex items-center justify-end border-t px-4 py-3">
          <div className="flex items-center gap-4">
            <div className="hidden items-center gap-2 lg:flex">
              <Label htmlFor="rows-per-page" className="text-sm text-muted-foreground">
                Rows per page
              </Label>
              <Select
                value={`${table.getState().pagination.pageSize}`}
                onValueChange={(value) => table.setPageSize(Number(value))}
              >
                <SelectTrigger size="sm" className="w-16" id="rows-per-page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="top">
                  {[10, 20, 50].map((pageSize) => (
                    <SelectItem key={pageSize} value={`${pageSize}`}>
                      {pageSize}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <span className="text-sm text-muted-foreground">
              Page {table.getState().pagination.pageIndex + 1} of{" "}
              {Math.max(1, table.getPageCount())}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="hidden size-8 lg:flex"
                onClick={() => table.setPageIndex(0)}
                disabled={!table.getCanPreviousPage()}
              >
                <span className="sr-only">Go to first page</span>
                <IconChevronsLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                <span className="sr-only">Go to previous page</span>
                <IconChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                <span className="sr-only">Go to next page</span>
                <IconChevronRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="hidden size-8 lg:flex"
                onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                disabled={!table.getCanNextPage()}
              >
                <span className="sr-only">Go to last page</span>
                <IconChevronsRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The trailing "⋯" cell's own inset, in place of the shared `px-4`.
 *
 * 52px column − 8px padding leaves the 32px trigger's edge 8px off the card
 * border, which puts its centred 16px glyph exactly 16px in — the same optical
 * gutter as the first column's text on the other side of the table.
 *
 * `px-2` rather than `pl-1 pr-2`: `cn` merges a *shorthand* away cleanly, while
 * a one-sided override leaves `px-4` in the class list and hands the outcome to
 * stylesheet order.
 */
const ACTIONS_CELL_CLASS = "px-2 text-right"

/**
 * The measured inner width of an element, and `null` before it has one.
 *
 * `null` rather than a guessed number on purpose: it is what tells
 * `columnStyles` to fall back to percentages, which is the right answer on the
 * server and for the first paint. A guess would put the columns at the wrong
 * pixels and then move them.
 *
 * Layout effect, so the measurement lands in the same frame the table first
 * paints in. `ResizeObserver` is absent in jsdom, where there is no layout to
 * measure anyway — the percentage form stands.
 */
function useAvailableWidth(ref: React.RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = React.useState<number | null>(null)

  React.useLayoutEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])

  return width
}

/** TanStack derives an id from `id`, then `accessorKey`; mirror that here. */
function columnId<TData, TValue>(column: ColumnDef<TData, TValue>): string | null {
  if (column.id) return column.id
  if ("accessorKey" in column && typeof column.accessorKey === "string") {
    return column.accessorKey
  }
  return null
}
