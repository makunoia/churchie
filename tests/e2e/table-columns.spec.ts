import type { Page } from "@playwright/test"

import { test, expect } from "./fixtures/admin-session"

/**
 * Block until the app's own face has actually loaded.
 *
 * `document.fonts.ready` alone is not enough: it resolves immediately when no
 * load is *pending*, which includes the moment before the first glyph has asked
 * for one. Anything measured in that window is measured against the fallback,
 * so a width assertion can pass or fail for a reason that has nothing to do
 * with the code under test.
 */
async function waitForAppFont(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.load("14px GeistSans")
    await document.fonts.ready
  })
}

/**
 * The column picker, end to end and across a reload.
 *
 * The whole reason column choices live in the database rather than in component
 * state is that they must survive leaving the page. That is exactly the claim a
 * unit test cannot make, so it is the one this spec exists to check.
 */

test.describe("Table column picker", () => {
  test("hiding a column survives a reload", async ({ adminPage: page }) => {
    await page.goto("/members")

    const table = page.locator("table").first()
    await expect(table.getByRole("columnheader", { name: "Email" })).toBeVisible()

    await page.getByRole("button", { name: "Columns", exact: true }).click()
    const drawer = page.getByRole("dialog")
    await expect(drawer).toBeVisible()

    await drawer.getByRole("checkbox", { name: "Email" }).click()
    await expect(table.getByRole("columnheader", { name: "Email" })).toHaveCount(0)

    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()

    await page.reload()
    // The saved layout is read in the dashboard layout, so it is applied on the
    // server — the column should never appear, not appear and then vanish.
    await expect(page.locator("table").first()).toBeVisible()
    await expect(page.locator("table").first().getByRole("columnheader", { name: "Email" })).toHaveCount(0)
    await expect(page.locator("table").first().getByRole("columnheader", { name: "Name" })).toBeVisible()
  })

  test("an opt-in column can be added and stays added", async ({ adminPage: page }) => {
    await page.goto("/members")

    await page.getByRole("button", { name: "Columns", exact: true }).click()
    const drawer = page.getByRole("dialog")
    await drawer.getByRole("checkbox", { name: "Show Work City" }).click()
    await page.keyboard.press("Escape")

    await expect(
      page.locator("table").first().getByRole("columnheader", { name: "Work City" }),
    ).toBeVisible()

    await page.reload()
    await expect(
      page.locator("table").first().getByRole("columnheader", { name: "Work City" }),
    ).toBeVisible()
  })

  test("the identifier column is never offered for hiding", async ({ adminPage: page }) => {
    await page.goto("/members")
    await page.getByRole("button", { name: "Columns", exact: true }).click()

    const drawer = page.getByRole("dialog")
    // Name is listed, but as a locked row rather than a toggle.
    await expect(drawer.getByRole("checkbox", { name: "Name" })).toHaveCount(0)
    await expect(drawer.getByText("Always shown")).toHaveCount(1)
    await expect(drawer.getByText("Name", { exact: true })).toBeVisible()

    // The selection checkbox and the row-actions menu are locked too, but they
    // are plumbing rather than choices, so they aren't listed at all.
    await expect(drawer.getByText("select", { exact: true })).toHaveCount(0)
    await expect(drawer.getByText("actions", { exact: true })).toHaveCount(0)
  })

  test("a mobile number copies in full", async ({ adminPage: page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await page.goto("/members")

    await page.getByRole("button", { name: /copy mobile/i }).first().click()

    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toMatch(/^\+63 /)
  })
})

/**
 * The table's chrome, measured in a real browser — which is the only place the
 * two defects it fixes were visible.
 */
test.describe("Table chrome", () => {
  test("the toolbar states how many rows are on screen", async ({ adminPage: page }) => {
    await page.goto("/members")

    const table = page.locator("table").first()
    await expect(table).toBeVisible()
    const rows = await table.locator("tbody tr").count()

    // The strip used to be empty on its left, which is what this line fills.
    await expect(page.getByText(new RegExp(`^${rows} members?$`))).toBeVisible()
  })

  test("the table renders in the app's own typeface, not the reader's", async ({
    adminPage: page,
  }) => {
    await page.goto("/members")
    await expect(page.locator("table").first()).toBeVisible()
    await waitForAppFont(page)

    // The defect this pins, and the reason the width test below can be trusted
    // at all. `GeistSans.variable` puts `--font-geist-sans` on <body> and
    // `@theme inline` maps `--font-sans` onto it, but nothing ever set
    // `font-family` from either — and Tailwind's preflight targets <html>,
    // where the variable does not exist. So the app rendered in whatever
    // `ui-sans-serif` the reader's OS supplies and Geist was never fetched.
    //
    // The column floors are measured pixel widths, which makes them a claim
    // about a specific face. Left to the OS, that face was SF Pro on a laptop
    // and something wider on a Linux CI runner, so the same Members table fit
    // in one place and clipped its dates and phone numbers in the other.
    const font = await page
      .locator("tbody tr td")
      .first()
      .evaluate((cell) => getComputedStyle(cell).fontFamily)
    expect(font).toMatch(/GeistSans/)

    // Named *and* actually loaded — a font-family naming a face the browser
    // never fetched falls through to the next entry in the stack silently.
    const status = await page.evaluate(
      () => Array.from(document.fonts).find((face) => face.family === "GeistSans")?.status,
    )
    expect(status).toBe("loaded")
  })

  test("a column is as wide as its token says, not as wide as its neighbours", async ({
    adminPage: page,
  }) => {
    await page.goto("/members")

    const table = page.locator("table").first()
    await expect(table).toBeVisible()

    // Widths are proportions until the table has measured its container, then
    // pixels with the floors resolved. Wait for the settled state — that is the
    // one the admin looks at.
    await expect
      .poll(async () =>
        table.evaluate((node) =>
          Array.from(node.querySelectorAll("col")).every((col) =>
            (col as HTMLElement).style.width.endsWith("px"),
          ),
        ),
      )
      .toBe(true)

    const widths = await table.evaluate((node) => {
      const byLabel: Record<string, number> = {}
      for (const head of Array.from(node.querySelectorAll("thead th"))) {
        const label = (head.textContent ?? "").trim()
        if (label) byLabel[label] = head.getBoundingClientRect().width
      }
      return byLabel
    })

    // The defect this pins: `columnStyles` emitted `max(…, calc(…))`, which
    // Chrome refuses for a `<col>` under `table-layout: fixed`. It fell back to
    // `auto`, fixed layout split the leftover space equally, and every one of
    // these came out at exactly the same width — so an Email column was as
    // narrow as a Life Stage badge on every screen in the app.
    expect(new Set(Object.values(widths)).size).toBeGreaterThan(1)
    expect(widths.Email).toBeGreaterThan(widths.Name)
    expect(widths.Name).toBeGreaterThan(widths["Life Stage"])

    // Columns that aren't up against a floor keep the declared ratio, 240 : 220.
    expect(widths.Email / widths.Name).toBeCloseTo(240 / 220, 1)

    // And the two values that are worthless when clipped are not clipped: a
    // date column at its bare proportion renders "Aug 20, 20…", and a phone
    // number missing its last digits looks like one you could dial. Asserted as
    // "does this cell fit its contents" rather than against the floors' current
    // numbers, since that is what the floors are *for*.
    // Text metrics decide this one, so wait for the real face — measured
    // against the fallback font it can pass or fail for the wrong reason.
    await waitForAppFont(page)

    const clipped = await table.evaluate((node) => {
      const heads = Array.from(node.querySelectorAll("thead th")).map((th) =>
        (th.textContent ?? "").trim(),
      )
      const cells = Array.from(node.querySelectorAll("tbody tr")[0]?.querySelectorAll("td") ?? [])
      return cells
        .filter((_, index) => ["Mobile", "Date Joined"].includes(heads[index]))
        .filter((cell) => {
          // Whatever is actually doing the truncating — the cell, or the span
          // inside the copy button, which sits next to an icon the column has
          // to leave room for.
          const boxes = [cell, ...Array.from(cell.querySelectorAll("*"))]
          return boxes.some((box) => box.scrollWidth > box.clientWidth + 1)
        })
        .map((cell) => (cell.textContent ?? "").trim())
    })
    expect(clipped).toEqual([])
  })

  test("every value sits under its own header", async ({ adminPage: page }) => {
    await page.goto("/members")

    const table = page.locator("table").first()
    await expect(table).toBeVisible()

    const offsets = await table.evaluate((node) => {
      const box = (el: Element) => {
        const rect = el.getBoundingClientRect()
        return { x: Math.round(rect.x), width: Math.round(rect.width) }
      }
      const row = node.querySelector("tbody tr")
      return {
        heads: Array.from(node.querySelectorAll("thead th")).map(box),
        cells: Array.from(row?.querySelectorAll("td") ?? []).map(box),
      }
    })

    expect(offsets.cells).toHaveLength(offsets.heads.length)
    expect(offsets.cells).toEqual(offsets.heads)
  })

  test("the row-actions trigger clears the table's right edge and stays clickable", async ({
    adminPage: page,
  }) => {
    await page.goto("/members")

    const table = page.locator("table").first()
    await expect(table).toBeVisible()

    const trigger = page.getByRole("button", { name: "Open menu" }).first()
    const button = await trigger.boundingBox()
    const bounds = await table.boundingBox()
    if (!button || !bounds) throw new Error("could not measure the actions cell")

    // On the old 44px `micro` column the 32px trigger overflowed its own cell
    // and was clipped flush against the border. It now sits on a real gutter.
    const gutter = bounds.x + bounds.width - (button.x + button.width)
    expect(gutter).toBeGreaterThanOrEqual(6)
    expect(button.width).toBeGreaterThanOrEqual(30)

    // And the whole trigger is reachable — including its right edge, which the
    // clipped version had lost.
    await page.mouse.click(button.x + button.width - 2, button.y + button.height / 2)
    await expect(page.getByRole("menu")).toBeVisible()
  })
})
