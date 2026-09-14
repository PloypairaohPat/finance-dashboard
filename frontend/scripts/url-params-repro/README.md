# URL search-param writer race — regression test

```bash
cd frontend
npm run repro:url-params              # summary table; exits 1 if any assertion fails
npm run repro:url-params -- --verbose # plus a per-commit timeline for every scenario
```

## Why this exists

Several components write the URL query string: `DemoUrlSync` owns `demo`, the
Transactions tab owns `q` / `category` / `dateFrom` / `dateTo`, and Budgets will add
more. React Router's `setSearchParams` — **including its functional form** — builds
each write from the params of the **last render**, not the live URL. So two writes
before the next render, or a write from any closure that has outlived a render
(after an `await`, in a timer, held in a ref), can silently delete a param another
writer added.

The fix is [`src/lib/useUrlParams.ts`](../../src/lib/useUrlParams.ts). The rule it
enforces: **every write is built from the URL as it is at the moment of writing, and
touches only the keys it names.** Writes from an unmounted component are dropped.
`no-restricted-imports` (in `frontend/package.json` → `eslintConfig`) bans
`useSearchParams` everywhere except that file, and CRA fails the build on it.

This script is the evidence for that design, and the test that it stays true.

## What it simulates

A jsdom browser with `BrowserRouter`, using the React and React Router installed in
`frontend/`, running the URL-writing logic of three components: `DemoUrlSync`,
`TransactionList`'s filter / debounce / adopt-`q` effects, and a Budgets-shaped third
writer. Every scenario runs against two implementations:

- **`raw`** — the pre-helper code (`DemoUrlSync` as of `c421dbe5`, `TransactionList` as
  of `9364dab3`). Kept on purpose, and its failures are asserted: if a scenario stops
  catching the bug in `raw`, it is no longer proving anything about `helper`, and the
  run fails.
- **`helper`** — the same logic writing through the real `src/lib/useUrlParams.ts`
  (imported, not copied).

| Scenario | What happens | `raw` | `helper` |
|---|---|---|---|
| 0 | Type, exit demo mid-debounce | correct | clean |
| 0b | Type, demo off then straight back on | correct | clean |
| A | Forced collision: demo write, then search write, one flush | recovers, `q` briefly lost | clean |
| B | Forced collision: search write, then demo write, one flush | correct | clean |
| C | Write from a stale snapshot, with a demo toggle | recovers, `q` briefly lost | clean |
| C2 | Write from a stale snapshot, nothing re-syncs | **broken** — search and typed text lost | clean |
| P1 | Budgets-shaped: URL write after an `await`; URL changes during it | **broken** — `category` lost | clean |
| P1b | Budgets-shaped: URL write after an `await`; user navigates away during it | **broken** — user pulled back to `/transactions` | clean — write dropped |
| P2-deps | Budgets-shaped: timer effect with the setter omitted from its deps | **broken** — `category` lost | clean |
| P2-ref | Budgets-shaped: setter held in a ref, never refreshed | **broken** — `category` lost | clean |

*clean* = final state correct, typed text never wiped, and no param ever dropped out
of the URL after appearing. *correct* = final state correct but a param was lost
along the way.

C2 under `helper` is not merely unlikely but inexpressible through the API: writes
take a patch of named keys, so a caller holding a stale snapshot can only turn it
into a patch of the keys that existed when the snapshot was taken — it has no way to
remove a key it never saw.

## Limits — read before trusting a green run

- **~25ms timing fidelity.** Waits run in 25ms `act()` slices so timer-driven updates
  commit near when they fire. Durations are approximate.
- **jsdom is not a browser.** This shows what happens *when* a collision occurs and
  how it resolves. It cannot tell you how often collisions occur in real use, or
  exactly what a real browser paints.
- **Collisions are forced.** A, B, C and C2 construct the race deterministically; real
  timing may rarely or never produce them.
- **Component logic is copied, except the helper.** `useUrlParams.ts` is imported for
  real; the `DemoUrlSync`, `TransactionList` and Budgets-shaped logic are copies. If
  you change the URL-writing code in those components, update the copies in
  `run.mjs`.
- **What the helper does not cover:** a caller writing a stale *value* for a key it
  names itself. That is application logic, not URL plumbing.
- **What the lint rule does not cover:** writing the query string through
  `useNavigate('?…')` or the History API directly. Neither is banned; don't.
- Needs a Node with built-in TypeScript type stripping (verified on Node 24.14). Node
  prints a `MODULE_TYPELESS_PACKAGE_JSON` warning when it loads the `.ts` helper;
  it is harmless.

---

# Nav links keep `?demo=1` — `link-nav-check.mjs`

```bash
cd frontend
npm run repro:link-nav   # exits 1 if any check fails
```

## Why this exists

The M7.1 stage 4 nav (`src/AppNav.tsx`) uses plain `<NavLink to="/accounts">` links
with no knowledge of demo mode. A link drops the whole query string, so demo mode
survives navigation only because `DemoUrlSync` notices `demo` is missing and writes it
back. This script checks that that actually holds instead of assuming it.

## What it simulates

The same jsdom + `BrowserRouter` setup as `run.mjs`. It renders a nav built from the
**real** `src/tabs.ts` (so its links are exactly the paths the app's nav uses), a
`DemoUrlSync`, and one page per route, then clicks real `<Link>` elements. It checks:

- In demo mode, clicking each of the five tabs lands on `<path>?demo=1`.
- The links' own `href`s carry no query string, so the nav is not demo-aware.
- Back returns to the previous tab **with** `?demo=1`.
- Leaving `/transactions?q=coffee&demo=1` for another tab keeps `demo` and drops `q`.
- Out of demo mode, links stay clean (`/accounts`, no `demo`).

It also logs, per tab, what the destination route saw on each render. Expect one render
**without** `demo=1` before `DemoUrlSync` restores it. That is harmless only as long as
nothing decides demo mode from the URL after mount; see `src/DemoUrlSync.tsx`.

## Limits

- **`DemoUrlSync` is copied, not imported.** Node can't load `.tsx`, so the script
  carries a copy of `src/DemoUrlSync.tsx`. `useUrlParams.ts` and `tabs.ts` are imported
  for real. **If you change `DemoUrlSync.tsx`, update the copy in
  `link-nav-check.mjs`**, or this can pass while the app is broken.
- **It doesn't render `AppNav` itself.** The script builds equivalent `<Link>`s from
  `tabs.ts`; it doesn't check `AppNav`'s markup, styling or its `NavLink` active state.
- Same jsdom and ~25ms timing limits as `run.mjs` above.
