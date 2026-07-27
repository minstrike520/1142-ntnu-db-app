# Frontend Bundle Analysis Baseline

This document defines a reproducible process for measuring the frontend production bundle with Turbopack's native analyzer, plus a one-time baseline snapshot. Use it before and after performance-focused PRs (see issues #380-#383) to compare bundle composition with the same method instead of guessing.

## Why not `@next/bundle-analyzer`

`@next/bundle-analyzer` instruments the Webpack build pipeline. This project's production build (`next build`) runs on Turbopack by default, so that plugin does not apply. Next.js 16.1+ ships a Turbopack-native equivalent instead: `next experimental-analyze`.

## Reproducible command

```bash
cd frontend
pnpm run analyze
```

This runs `next experimental-analyze --output`, which builds the app for analysis and writes static results to `frontend/.next/diagnostics/analyze/` instead of starting the interactive UI server. The whole `.next/` tree is already gitignored (`frontend/.gitignore` and root `.gitignore` both ignore `/.next/`), so the generated directory is never at risk of being committed.

To browse the results interactively instead of writing files, drop `--output`/`-o` and run `pnpm exec next experimental-analyze`, which serves a local web UI (default port 4000).

**Note:** `experimental-analyze` is an experimental Next.js CLI command; its flags and output format may change between Next.js releases. If `pnpm run analyze` or the parsing steps below stop working after a Next.js upgrade, re-check `pnpm exec next experimental-analyze --help` and update this document.

## Toolchain versions used for this baseline

| Tool | Version |
| :--- | :--- |
| Next.js | 16.2.10 |
| Node.js | v22.22.2 (this measurement's sandbox; project targets Node >=24 per `package.json` engines) |
| pnpm | 11.13.1 |
| Commit | `a087b50` (`dev`, 2026-07-18) |

Bundle byte sizes are environment- and dependency-version-sensitive (they shift with `pnpm-lock.yaml`, Node/pnpm versions, and OS). Treat the numbers below as an **approximate baseline anchored to the commit above**, not an exact/portable measurement. Re-run the command yourself for precise before/after comparisons within the same PR.

## How to compare before/after in a future PR

1. On the base branch (or before your change), run `pnpm run analyze` and note the ranked module tables for the routes your change touches (see the method below).
2. Apply your change.
3. Run `pnpm run analyze` again and re-extract the same tables.
4. Diff the two: did total client JS size for the affected route(s) drop, and did the specific module(s) you targeted shrink or disappear from the top of the list?
5. Include both the command you ran and a short before/after summary in the PR description (this is part of the acceptance criteria for bundle/perf PRs in this project).

### Extracting ranked module sizes

`next experimental-analyze --output` writes one `analyze.data` file per route under `frontend/.next/diagnostics/analyze/data/` (e.g. `data/analyze.data` for `/`, `data/chat/[chatId]/analyze.data`, `data/settings/analyze.data`), plus a shared `data/modules.data`. Each `.data` file is a 4-byte big-endian length prefix `n`, followed by exactly `n` bytes of JSON payload, followed by a binary adjacency-list trailer (used internally by the interactive UI) that is **not** JSON and must not be parsed as such. The JSON payload exposes `output_files`, `chunk_parts` (each with `source_index`, `output_file_index`, `size`), and `sources` (each with `path` and `parent_source_index`).

To rank client-side JS modules by size for a given route:

1. Load the route's `analyze.data`. Read the first 4 bytes as a big-endian `uint32` length `n`, then parse only `data[4:4+n]` as JSON — do not `json.loads` everything after the prefix, since the trailer bytes after position `4+n` are not valid JSON and will raise a decode error.
2. Filter `output_files` to those whose `filename` contains `static/chunks` **and** ends with `.js` (this excludes SSR/server chunks, CSS chunks, and font/image media files, leaving only client JS chunks — `static/chunks` alone also matches CSS chunk files, e.g. the one containing `globals.css`, so the `.js` suffix check is required to keep the metric actually JS-only).
3. Sum `chunk_parts[].size` grouped by `source_index`, restricted to parts whose `output_file_index` is in that filtered set.
4. **Drop the legacy `nomodule` polyfill from the sums.** It is itself a `static/chunks/*.js` file, so step 2 alone does not remove it — explicitly exclude any source whose `path` contains the filename `polyfill-nomodule.js` before ranking. Match on the filename only, not a full directory prefix: reconstructed paths join per-segment `path` values with `/`, but the segments themselves already contain doubled slashes (e.g. the real path looks like `.../node_modules//next//dist//build//polyfills//polyfill-nomodule.js`), so a literal single-slash substring like `next/dist/build/polyfills/polyfill-nomodule.js` will silently fail to match and this step will do nothing. Skipping (or misapplying) this step will silently add ~112 KB of never-executed-by-modern-browsers payload back into every route's "client JS" total (see the dedicated note below on why it's excluded).
5. Sort descending and resolve each `source_index` back to a path via `sources[i].path` (walk `parent_source_index` to reconstruct the full path where needed).

## Baseline: main client modules per page (measured at the commit above)

All sizes below are **client JS only** (`static/chunks/*.js`), per the corrected filter in the extraction method above. Framework/vendor modules in the table below are shared across all three routes; they are the JS floor every route pays regardless of app code.

Two costs are tracked separately below rather than folded into this table, because they are not "JS every modern-browser session executes":

- **CSS**: `src/app/globals.css` compiles to its own chunk under `static/chunks/*.css` (~44 KB). It is a real shared asset downloaded on every route, but it is CSS, not JS — mixing it into a "client JS" ranking would misattribute a future CSS regression/improvement as a JS one.
- **Legacy polyfill**: see the dedicated note further below.

### Shared across all three routes (client JS, approximate)

| Size | Module |
| ---: | :--- |
| ~199 KB | `react-dom/cjs/react-dom-client.production.js` |
| ~27.5 KB | `src/context/ChatContext.tsx` |
| ~27 KB | `tailwind-merge/dist/bundle-mjs.mjs` |
| ~24 KB | `react-server-dom-turbopack-client.browser.production.js` |
| ~17 KB | `@iconify/react/dist/iconify.js` (icon runtime) |
| ~15 KB | `src/components/layout/Sidebar.tsx` |
| ~13 KB | `src/components/layout/ChatList.tsx` |
| ~12 KB | `src/locales/en.json` |

**Legacy `nomodule` polyfill (not counted above):** the analyzer output also lists a ~112 KB `polyfill-nomodule.js` for every route. This is Next.js's fallback bundle served via a `<script nomodule>` tag for browsers that don't support `<script type="module">`; browsers that do support module scripts do not execute it, so it is not part of the JS payload a modern-browser session actually runs, even though the analyzer's static output includes it in every route's file list. It is intentionally excluded from the table above and from the per-route totals below to avoid overstating the common JS budget by ~112 KB for the common case. See candidate 3 below for follow-up.

### `/` (home)

No additional route-specific module stands out beyond the shared set above; the root route is mostly the shell (Sidebar/ChatList) with no active room selected.

### `/chat/[chatId]`

Additional to the shared set:

| Size | Module |
| ---: | :--- |
| ~21 KB | `src/components/chat/Chatroom.tsx` |
| ~18.7 KB | `src/components/settings/GroupSettings.tsx` |
| ~10.3 KB | `src/components/ui/ChatBubble.tsx` |

### `/settings`

Additional to the shared set:

| Size | Module |
| ---: | :--- |
| ~9.9 KB | `src/components/settings/ProfileSettings.tsx` |

## Import chains and optimization candidates

At least three concrete, evidence-backed candidates for the follow-up performance issues:

1. **A chat side panel that is `false` by default is statically imported into the initial chat-page bundle** (feeds #381). `src/components/pages/ChatroomPageContent.tsx` statically imports `GroupSettings` at module top level, gated only by `const [showSettings, setShowSettings] = useState(false)` (`{showSettings ? <GroupSettings .../> : <Chatroom .../>}`). Because the import is static, `GroupSettings.tsx` (~18.7 KB) ships in the `/chat/[chatId]` route's initial client chunk even though it starts hidden and most sessions never open it. This is a clean `next/dynamic` candidate.

   `ChatroomPageContent.tsx` also statically imports `RoomMembersPanel`, but it is a weaker candidate than it first looks: `showRightPanel` defaults to `true` in `ChatContext.tsx` (`useState<boolean>(true)`), and for `type === "group"` rooms `rightPanel` resolves to `RoomMembersPanel` and renders immediately in the default view — it is not an "unopened" panel the way `GroupSettings` is. It only ships genuinely unused in private (`type === "msg"`) room sessions (where `rightPanel` resolves to `FriendInfoPanel` instead and `RoomMembersPanel` is never referenced) or once a user has manually closed the panel via `setShowRightPanel(false)`. Any `next/dynamic` follow-up here should scope its "before/after" comparison to those private-chat/closed-panel sessions rather than claim a reduction for the default group-chat view.

   `ChatroomPageContent.tsx` also statically imports `FriendInfoPanel`, but converting only that import would not reduce the initial bundle: `src/components/layout/Sidebar.tsx` (line 12) already statically imports `FriendInfoPanel` unconditionally, and `Sidebar` is rendered by `src/app/(main)/layout.tsx`, the persistent shell wrapping every route in this table (`/`, `/chat/[chatId]`, `/settings`). `FriendInfoPanel` is therefore already part of the initial authenticated-shell bundle regardless of `ChatroomPageContent`'s import; it is excluded from this candidate and would need its own investigation (e.g. dynamic-importing it from `Sidebar` itself) to actually move the needle.

2. **Runtime icon-name lookups instead of on-demand icon component imports** (feeds #382). `Chatroom.tsx`, `Sidebar.tsx`, and `MobileNav.tsx` all import `{ Icon } from "@iconify/react"` and render icons via the runtime string-lookup API (`<Icon icon="bx:home" />`). The project already depends on `@iconify-react/boxicons`, but it is a per-icon subpath package, not a package with named root exports: each icon is its own default export at its own subpath, e.g. `import Home from "@iconify-react/boxicons/home";` (confirmed via `node_modules/@iconify-react/boxicons/package.json`'s `exports` map — there is no root-level named-export form). No file currently imports from any of these subpaths. Switching to this per-icon default-import form would let unused icons be tree-shaken instead of resolved at runtime through the `iconify.js` runtime (~17 KB, shared on every route).

3. **Legacy-browser `nomodule` polyfill bundle is listed for every route** (feeds #380). As detailed above, `polyfill-nomodule.js` (~112 KB) is Next.js's default fallback bundle for browsers without `<script type="module">` support; it is not executed by modern browsers, but the analyzer's static file list still shows it present for every route, and it is worth confirming this project's supported browser matrix doesn't need it before treating it as dead weight. It is flagged here as an investigation candidate for the Turbopack code-splitting/target investigation in #380, not a confirmed removable or actually-executed cost.

These are phrased as "statically imported" / "present in every route" rather than causal size claims: the ranked tables above show what ships in each route's client bundle, not a proof that any single module dominates render cost or load time. Follow-up issues should re-measure after each targeted change using the process in this document.

## Scope note

This task only adds the `analyze` script and this baseline documentation. It intentionally does not modify any production code, add `next/dynamic` boundaries, change icon imports, or touch chunk-splitting configuration — those are the scope of #380-#383.
