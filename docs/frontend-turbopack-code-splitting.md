# Turbopack Code Splitting: Investigation & Technical Decision (#380)

This document records the investigation requested by issue #380 (a sub-task of the #285 frontend performance effort): whether Next.js 16 with Turbopack offers a supported, stable way to configure manual chunk splitting equivalent to Webpack's `optimization.splitChunks`, and what that means for the follow-up performance work (#381–#383).

**Decision (TL;DR): Turbopack in the Next.js version this project uses has no public, stable API equivalent to Webpack's `splitChunks`. We will NOT add any chunk-splitting configuration to `next.config.ts`. Bundle-size work proceeds through the layers that are supported: App Router route splitting (automatic), `next/dynamic` (#381), and per-icon/package imports (#382).**

## Toolchain versions used for this investigation

| Tool | Version |
| :--- | :--- |
| Next.js | 16.2.10 (installed; `package.json` declares `16.2.10`) |
| Node.js | v22 sandbox (project targets Node >=24 per `package.json` engines) |
| pnpm | 11.13.1 |
| Branch/date | `claude/issue-285-fix-yhe83u` off `dev` `8cffa93`, 2026-07-19 |

Issue #380 was written against "16.2.6"; the project has since moved to 16.2.10. All findings below were verified against the installed 16.2.10 package.

## Question 1: Does Turbopack expose a `splitChunks`-equivalent config?

**No.** Three independent lines of evidence:

### 1a. The documented `turbopack` config surface

The official Next.js reference for the `turbopack` key in `next.config.ts` ([nextjs.org/docs/app/api-reference/config/next-config-js/turbopack](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack)) documents exactly these options:

- `root` — application root directory
- `rules` — apply webpack **loaders** (file transforms only, not bundling strategy)
- `resolveAlias` — import aliasing
- `resolveExtensions` — module resolution extensions
- `debugIds` — debug IDs in bundles/source maps
- `ignoreIssue` — suppress specific Turbopack diagnostics

None of these controls chunking. The Turbopack guide ([nextjs.org/docs/app/api-reference/turbopack](https://nextjs.org/docs/app/api-reference/turbopack), "Unsupported and unplanned features") additionally states that any `webpack()` configuration in `next.config.js` is **not recognized** when building with Turbopack — so porting a `splitChunks` block inside a `webpack()` callback would silently do nothing for `next build`.

### 1b. The installed package's type definitions

`frontend/node_modules/next/dist/server/config-shared.d.ts` (next@16.2.10) defines `TurbopackOptions` with exactly the six fields listed above (`resolveAlias`, `resolveExtensions`, `rules`, `root`, `debugIds`, `ignoreIssue`) and nothing chunking-related.

Chunking-adjacent switches do exist, but only as `experimental.*` flags in the same file (e.g. `turbopackClientSideNestedAsyncChunking`, `turbopackServerSideNestedAsyncChunking`, `turbopackScopeHoisting`, `turbopackTreeShaking`, `turbopackMinify`, `turbopackModuleIds`). These are boolean/enum toggles over Turbopack's built-in behavior — not a `splitChunks`-style strategy language (no cache groups, no size thresholds, no manual vendor grouping) — and they are experimental, which fails #380's "public and stable" bar. See "Rejected options" below.

### 1c. Minimal reproducible test

Placing this file at `frontend/src/__turbopack-splitchunks-spike__.ts`:

```ts
import type { NextConfig } from "next";

const spikeConfig: NextConfig = {
  turbopack: {
    splitChunks: {
      chunks: "all",
      cacheGroups: {
        vendor: { test: /node_modules/, name: "vendors" },
      },
    },
  },
};

export default spikeConfig;
```

and running `pnpm exec tsc --noEmit` in `frontend/` fails with:

```
src/__turbopack-splitchunks-spike__.ts(5,5): error TS2353: Object literal may only
specify known properties, and 'splitChunks' does not exist in type 'TurbopackOptions'.
```

The spike file was deleted after capturing the output; it is intentionally not committed.

## Question 2: Who is responsible for code splitting, then?

With no manual chunking API, splitting responsibilities in this project break down by layer. This is the boundary map the follow-up issues should work within:

| Layer | Mechanism | Status in this project |
| :--- | :--- | :--- |
| Route | App Router automatic per-route code splitting. Each route segment gets its own chunk; shared modules are deduplicated automatically by Turbopack. | Already active; the per-route tables in `docs/frontend-bundle-analysis.md` show it working (`/`, `/chat/[chatId]`, `/settings` each have distinct route-specific modules). |
| Component | `next/dynamic` / `React.lazy` creates an async boundary; Turbopack emits a separate chunk loaded on first render. This is the **only supported way to manually move code out of a route's initial chunk**. | Scope of #381 (e.g. `GroupSettings`, statically imported today but hidden by default). |
| Package | Import hygiene: per-icon subpath imports instead of runtime string lookup; Turbopack natively optimizes barrel files (the docs note `experimental.optimizePackageImports` is a Webpack-era aid that is "not needed when using Turbopack"). | Scope of #382 (`@iconify/react` → `@iconify-react/boxicons/<icon>` subpath imports). |

In other words: nothing that #381–#383 need is blocked by the absence of `splitChunks`. Manual vendor grouping was a Webpack-era tactic; under Turbopack the equivalent outcomes come from async boundaries and import hygiene.

## Question 3: dev/build bundler mismatch

`frontend/package.json` currently has:

- `dev`: `next dev --webpack` → development uses **Webpack**
- `build`: `next build` → production uses **Turbopack** (Next 16 default)

Implications:

- Any `turbopack.*` config we might add would affect `next build` (and `pnpm run analyze`) but **not** the dev server; conversely a `webpack()` callback would affect dev but be ignored by the production build. This split is a real foot-gun for any future bundler-level configuration — one more reason to keep `next.config.ts` bundler-agnostic (as it is today: it currently contains no `webpack` and no `turbopack` key).
- Dev/prod behavioral drift (module resolution, HMR semantics, CSS handling) is possible but has not caused observed issues so far.

**Recommendation:** unify on Turbopack for dev (`next dev` without `--webpack`) — tracked separately in #387 with its own verification (dev-server smoke test of HMR, CSS, and Socket.IO client behavior), not as a rider on this documentation PR. Until then, treat "config that only one bundler reads" as a review red flag.

## Question 4: the ~112 KB `polyfill-nomodule.js` (baseline candidate 3)

`docs/frontend-bundle-analysis.md` flagged that the analyzer lists `polyfill-nomodule.js` (~112 KB) for every route and deferred the verdict to this investigation.

**Verdict: not an actual cost for modern browsers, and not configurable — leave it alone.** Next.js injects this file as a `<script noModule>` tag (verified in the installed package: `next/dist/server/app-render/app-render.js` builds the polyfill script entries from `buildManifest.polyfillFiles` with `noModule: true`). Browsers that support `<script type="module">` — i.e. every browser that can run this app's ES-module bundles at all — skip `nomodule` scripts by specification, so the file is downloaded and executed only by legacy browsers that would otherwise not work. There is no public Next.js config to remove it, and removing it would only break the legacy-browser fallback story without changing what modern browsers download or execute. The bundle-analysis method in `docs/frontend-bundle-analysis.md` already excludes it from client-JS totals; keep doing that.

## Decision record

### Adopted

1. **No chunk-splitting configuration is added to `next.config.ts`.** There is no supported API to add, and the config file stays bundler-agnostic while dev and build use different bundlers.
2. **Bundle-size work proceeds via supported layers only:** `next/dynamic` boundaries (#381), per-icon subpath imports (#382), measured re-render fixes (#383), all validated with the reproducible `pnpm run analyze` process from `docs/frontend-bundle-analysis.md`.
3. **`polyfill-nomodule.js` is closed as "no action":** excluded from client-JS accounting, not a removable or real modern-browser cost.

### Rejected options (and why)

- **`experimental.turbopack*` flags** (`turbopackClientSideNestedAsyncChunking`, `turbopackScopeHoisting`, `turbopackTreeShaking`, `turbopackMinify`, `turbopackModuleIds`, …): experimental, undocumented semantics per release, and no bundle evidence that any current chunk problem exists for them to solve. Adopting them now would be speculative tuning with upgrade risk.
- **Porting Webpack `optimization.splitChunks` via a `webpack()` callback**: explicitly not recognized by Turbopack builds; would only (mis)configure the dev server.
- **Private/undocumented APIs**: out of bounds per #380's own constraints.

### Re-evaluation triggers

Revisit this decision if any of the following happens:

1. Next.js promotes a chunking-control API for Turbopack to **stable** (watch the `turbopack` config reference page across upgrades).
2. `pnpm run analyze` shows a single oversized client chunk that `next/dynamic` boundaries demonstrably cannot break up (e.g. a shared vendor module that async boundaries keep pulling into the initial chunk).
3. The dev/build bundler unification lands and makes bundler-specific config meaningful for both environments.

### Rollback

This change is documentation-only. Rollback = delete this file (and its `docs/ZH-TW/` translation). No production code or configuration was modified.
