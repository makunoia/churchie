import { vi } from "vitest"

const defaultSession = {
  user: {
    id: undefined,
    name: "Test Admin",
    email: "test@example.com",
    username: "test-admin",
    role: "SuperAdmin",
    permissions: [],
    eventAccess: [],
    totpEnabled: false,
    mustChangePassword: false,
    requiresTotpSetup: false,
  },
}

// server-only is a Next.js guard — it's a no-op in tests
vi.mock("server-only", () => ({}))

// next-auth cannot resolve next/server outside the Next.js runtime — mock the whole module
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue(defaultSession),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}))

// Mock Next.js cache APIs — not available outside the Next.js runtime
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  // Pass through to original fn — caching is a no-op in tests
  unstable_cache: vi.fn(<T extends (...args: unknown[]) => unknown>(fn: T) => fn),
}))

/**
 * The app router's hooks, which throw "invariant expected app router to be
 * mounted" outside a real Next navigation tree.
 *
 * Global rather than per file for the same reason `next/cache` is: a component
 * test should not have to know which of its descendants happens to ask. The
 * walk-in door and both check-in kiosks now call `useRouter().refresh()` to
 * re-read their server props between people (see `useKioskRefresh`), so every
 * test that renders one of those trees — most of which care about something else
 * entirely — would otherwise need its own mock.
 *
 * Only the HOOKS are stubbed. `redirect` and `notFound` stay real, because tests
 * assert on the control flow they throw.
 */
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}))

// jsdom implements no media queries, so anything reaching `useIsMobile` — which
// now includes every table, via the column picker's responsive Drawer — throws
// before it renders. Defined here rather than per test file so a component test
// doesn't have to know which of its descendants happens to ask.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
