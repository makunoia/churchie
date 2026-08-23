// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { type ColumnDef } from "@tanstack/react-table"

import { DataTable } from "@/components/ui/data-table"
import { TablePreferencesProvider } from "@/components/tables/table-preferences-provider"

/**
 * `hidePagination` means "show the whole list", not "hide the footer".
 *
 * The regression it pins: the flag hid the footer only. The pagination row
 * model stayed installed at the default `pageSize: 10`, so a session with more
 * than ten breakout groups rendered the first ten with no control left to reach
 * the rest — while the toolbar, counting the *filtered* model, named all of
 * them. The card list beside it maps its data directly, so a narrow window
 * showed every group and a wide one silently dropped the overflow.
 */

vi.mock("@/lib/tables/actions", () => ({
  saveTablePreference: vi.fn(async () => ({ success: true }) as const),
  resetTablePreference: vi.fn(async () => ({ success: true }) as const),
}))

beforeAll(() => {
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

type Row = { id: string; name: string }

const columns: ColumnDef<Row>[] = [
  {
    accessorKey: "name",
    header: "Name",
    meta: { label: "Name", width: "name", locked: true },
    cell: ({ row }) => row.original.name,
  },
]

/** Fourteen groups — the shape of a large session's breakouts tab. */
function groups(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `g${i + 1}`, name: `Group ${i + 1}` }))
}

function renderTable(props: Partial<React.ComponentProps<typeof DataTable<Row, unknown>>>) {
  const data = props.data ?? groups(14)
  return render(
    <TablePreferencesProvider initial={{}}>
      <DataTable tableKey="test.groups" columns={columns} {...props} data={data} />
    </TablePreferencesProvider>,
  )
}

function bodyNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("tbody tr td:first-child")).map(
    (c) => c.textContent ?? "",
  )
}

describe("DataTable under hidePagination", () => {
  it("renders every row, not the first page of them", () => {
    const { container } = renderTable({ hidePagination: true })
    const names = bodyNames(container)

    expect(names).toHaveLength(14)
    expect(names.at(0)).toBe("Group 1")
    expect(names.at(-1)).toBe("Group 14")
  })

  it("shows as many rows as the toolbar says are there", () => {
    const { container } = renderTable({
      hidePagination: true,
      rowLabel: { one: "group", many: "groups" },
    })
    const strip = container.querySelector("div.border-b") as HTMLElement

    expect(strip.textContent).toContain("14 groups")
    expect(bodyNames(container)).toHaveLength(14)
  })

  it("ignores initialPageSize rather than capping at it", () => {
    const { container } = renderTable({ hidePagination: true, initialPageSize: 5 })
    expect(bodyNames(container)).toHaveLength(14)
  })

  it("renders no pagination footer", () => {
    const { container, queryByText } = renderTable({ hidePagination: true })
    expect(queryByText(/rows per page/i)).toBeNull()
    expect(container.textContent).not.toMatch(/Page \d+ of \d+/)
  })

  it("survives an empty list, where a zero page size would be invalid", () => {
    const { container } = renderTable({ hidePagination: true, data: [] })
    expect(bodyNames(container)).toHaveLength(0)
  })
})

describe("DataTable with its footer", () => {
  it("still pages, at the default ten", () => {
    const { container } = renderTable({})
    expect(bodyNames(container)).toHaveLength(10)
  })

  it("still honours initialPageSize", () => {
    const { container } = renderTable({ initialPageSize: 5 })
    expect(bodyNames(container)).toHaveLength(5)
  })
})
