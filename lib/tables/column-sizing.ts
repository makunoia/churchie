/**
 * The shared width vocabulary every table column speaks.
 *
 * Before this existed, a column was as wide as whatever happened to be in it:
 * `components/ui/table.tsx` sets `whitespace-nowrap` on every head and cell and
 * the table ran at the browser default `table-layout: auto`, so "Email" was one
 * width on Members, another on Guests, and a third on Registrants. The handful
 * of columns that did pin a width picked from four different conventions for
 * "narrow icon column" alone (`w-0`, `w-8`, `w-10`, `w-14`).
 *
 * A column now names what it *is* — `width: "phone"` — and every table that
 * shows a phone number renders it identically.
 */

/**
 * `size` is the *share* of the table a column claims, not a pixel width; `min`
 * is the floor below which the table stops shrinking and its container scrolls.
 *
 * Two columns carrying the same token therefore always come out the same width
 * as each other, and two tables built from similar tokens line up — which is
 * the actual complaint this vocabulary answers.
 *
 * There is deliberately no ceiling. An earlier version clamped each column to a
 * maximum, which meant a three-column table left a few hundred pixels of slack
 * that the browser then redistributed *equally* across the columns — distorting
 * the very proportions the tokens exist to state. Purely proportional always
 * fills the table and always keeps the declared ratios.
 *
 * The floors are tight on purpose: the narrowest each kind of value is still
 * readable, not the width it would prefer. They are summed into the table's
 * `min-width`, so a generous floor doesn't buy a roomier column, it buys a
 * horizontal scrollbar on a screen that could have shown everything.
 */
export const COLUMN_WIDTHS = {
  /** Checkbox, expand chevron — fixed, never flexes. */
  micro: { size: 44, min: 44, fixed: true },
  /**
   * The trailing row-actions "⋯". Wide enough for the 32px icon trigger *plus*
   * its gutter — on `micro` the button was 32px in a 12px content box, so it
   * overflowed the cell, got clipped by `truncate`, and lost the right edge of
   * its own hit area against the card border.
   */
  actions: { size: 52, min: 52, fixed: true },
  /** Counts, Yes/No, short numerics. */
  narrow: { size: 88, min: 64 },
  /** A single badge. */
  status: { size: 140, min: 96 },
  /**
   * A formatted date, optionally with a time beneath it. The floor is measured
   * rather than guessed, and measured against the *widest* date rather than a
   * typical one: `May 00, 2026` is 90.5px at the table's type size — May is the
   * widest month and 0 the widest digit — plus the cell's 32px inset. A date is
   * worthless clipped (`May 20, 20…` says nothing the header didn't), so it
   * holds its floor before it truncates.
   *
   * The widest date the column can actually be handed is `May 20, 2000` at
   * 91.5px — widest month, widest two-digit day, widest year — so the floor
   * carries a couple of pixels over that. The previous 120 was 88px for
   * `Aug 20, 2026` and not a pixel more, which `Nov 20, 2026` already
   * overflowed. A floor with no headroom is a floor that only holds for the
   * one string it was measured against.
   */
  date: { size: 132, min: 126 },
  /**
   * `"+63 XXX XXX XXXX"` is a fixed shape and shouldn't ever wrap or clip — a
   * truncated phone number is worse than useless, since it still looks like one
   * you could dial. 129px for the widest set of digits (0 is the widest glyph
   * in the face, and an all-zero number is 44px wider than one of 1s), the
   * cell's 32px inset, and the 20px the copy affordance holds open beside them
   * — `CopyableText` keeps its icon in the layout and only fades it in, so the
   * text box is that much narrower than the column it sits in. Plus the same
   * few pixels of slack the date column carries, and for the same reason: at
   * exactly 180 the number filled its box to the pixel and clipped the moment
   * anything measured a hair wider.
   */
  phone: { size: 184, min: 184 },
  /** A person's or group's name. */
  name: { size: 220, min: 140 },
  email: { size: 240, min: 150 },
  /** The default for free text with no stronger claim. */
  text: { size: 200, min: 110 },
  /** Notes, addresses — the column that should absorb the most space. */
  wide: { size: 320, min: 160 },
} as const

export type ColumnWidth = keyof typeof COLUMN_WIDTHS

/** The token a column falls back to when it names none. */
export const DEFAULT_COLUMN_WIDTH: ColumnWidth = "text"

export function columnWidth(width: ColumnWidth | undefined) {
  return COLUMN_WIDTHS[width ?? DEFAULT_COLUMN_WIDTH]
}

/**
 * The narrowest the table may render before its container starts scrolling.
 *
 * The sum of the visible columns' floors. `table-layout: fixed` distributes
 * space proportionally, which is what makes columns consistent — but left alone
 * it will also squeeze a name column to nothing on a narrow screen. Pinning the
 * table's `min-width` here means it degrades into a horizontal scroll instead.
 *
 * The sum is the right figure because `resolveColumnWidths` holds every column
 * at its floor before it lets any of them go under: at the moment the floors
 * are all that is left, they are also all there is to add up. Below that the
 * columns stop shrinking and the container takes over.
 */
export function tableMinWidth(widths: (ColumnWidth | undefined)[]): number {
  return widths.reduce<number>((total, width) => total + columnWidth(width).min, 0)
}

/** A column that never flexes: the checkbox, the chevron, the "⋯" menu. */
function isFixed(width: ColumnWidth | undefined): boolean {
  return "fixed" in columnWidth(width)
}

/**
 * Every column's width in pixels, given the space the table has to fill.
 *
 * Proportional, with each column's floor honoured — which takes an actual pass
 * rather than a formula, because a column pinned to its floor is no longer
 * taking a share, and what it leaves behind changes everyone else's. So: hand
 * out the space in proportion to `size`, pin anything that lands under its
 * floor, and share what's left among the columns still flexing. Repeat until a
 * round pins nothing.
 *
 * When even the floors don't fit, every column sits at its floor and the total
 * comes to `tableMinWidth` — wider than the container, which is exactly when
 * the container should scroll.
 */
export function resolveColumnWidths(
  widths: (ColumnWidth | undefined)[],
  available: number,
): number[] {
  type Resolved = { size: number; min: number; fixed: boolean; value: number }
  const resolved: Resolved[] = widths.map((width) => {
    const w = columnWidth(width)
    return { size: w.size, min: w.min, fixed: isFixed(width), value: w.size }
  })

  let remaining =
    available - resolved.filter((c) => c.fixed).reduce((total, c) => total + c.size, 0)
  let flexing = resolved.filter((c) => !c.fixed)

  while (flexing.length > 0) {
    const flexTotal = flexing.reduce((total, c) => total + c.size, 0)
    const floored = flexing.filter((c) => (c.size / flexTotal) * remaining < c.min)
    if (floored.length === 0) {
      for (const column of flexing) column.value = (column.size / flexTotal) * remaining
      break
    }
    for (const column of floored) {
      column.value = column.min
      remaining -= column.min
    }
    flexing = flexing.filter((c) => !floored.includes(c))
  }

  // Rounded cumulatively rather than column by column, so the rounding error
  // cannot accumulate: eight columns each rounded up by a hair came to a table
  // one pixel wider than its container, which is a horizontal scrollbar on a
  // list that fits.
  let exact = 0
  let placed = 0
  return resolved.map((c) => {
    exact += c.value
    const edge = Math.round(exact)
    const width = edge - placed
    placed = edge
    return width
  })
}

/**
 * The `<col>` width for each column, as CSS.
 *
 * Two forms, and the reason for both is that a `<col>` width under
 * `table-layout: fixed` has to be a plain length or a plain percentage. Chrome
 * drops any value built with `calc()` or `max()` and falls back to `auto`,
 * which in fixed layout means "split the leftover space equally". The first
 * version of this file emitted `max(140px, calc((100% - 96px) * 0.1964))` per
 * column, so *every* flexible column silently went to auto and came out the
 * same width as its neighbours: a Members table drew Name, Email, Mobile,
 * DGroup, Life Stage and Date Joined at 140px each, and the vocabulary these
 * tokens exist to state had no effect on screen at all.
 *
 * So the arithmetic has to happen before the CSS does:
 *
 * - **With `available`** — the measured width of the table's container — the
 *   floors are resolved here (`resolveColumnWidths`) and each column gets plain
 *   pixels. This is the real answer, and the only one that can keep a date
 *   column wide enough to hold `Aug 20, 2026` rather than `Aug 20, 20…`.
 * - **Without it** — server render, and the first client paint — each flexible
 *   column takes its share of `size` as a bare percentage. The browser fits
 *   those into whatever the fixed columns leave, so the declared *ratios* are
 *   right immediately and only the floors wait for the measurement.
 */
export function columnStyles(
  widths: (ColumnWidth | undefined)[],
  available?: number | null,
): { width: string }[] {
  if (available != null && available > 0) {
    return resolveColumnWidths(widths, available).map((width) => ({
      width: `${width}px`,
    }))
  }

  const flexTotal = widths
    .filter((w) => !isFixed(w))
    .reduce((total, width) => total + columnWidth(width).size, 0)

  return widths.map((width) => {
    const w = columnWidth(width)
    if (isFixed(width) || flexTotal === 0) return { width: `${w.size}px` }
    return { width: `${((w.size / flexTotal) * 100).toFixed(4)}%` }
  })
}
