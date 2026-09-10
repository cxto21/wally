# Proposal: wally-extension-wal-aesthetics

## Intent

Port WAL recorder's selector hierarchy and replay robustness into the Wally Chrome extension, then restyle the sidepanel to match the Wally GitHub Pages aesthetic. The Wally extension currently uses flat single-string selectors for recording and replay — WAL's hierarchy-first resolution is significantly more resilient to DOM mutations. The sidepanel UI is visually disconnected from the Wally brand.

**Core principle**: `lib/` is RED ZONE — zero daemon changes. This is extension-only work.

## RED ZONE: lib/ Daemon Regression Gate

| Rule | Enforcement |
|------|-------------|
| `lib/*.js` — no modifications | Gate check: `git diff --name-only` must NOT include any `lib/` path |
| `lib/recording-script.js` — no edits | Shared recording script is daemon-owned |
| `lib/bridge.js`, `lib/daemon.js` | CDP/bridge infrastructure untouched |
| Verification | CI must fail if any `lib/` file is modified in these PRs |

**Rationale**: The daemon records other extensions' popups via CDP — a capability the browser extension cannot replicate. Mixing extension work into daemon files risks invisible regression.

## Scope

### In Scope
- Selector hierarchy module (pure DOM, no dependencies)
- Recording enrichment with hierarchy fields
- Replay upgrade: best→target→ancestor fallback chain
- Procedure adapter (WAL Procedure → Wally actions.jsonl)
- Sidepanel aesthetic overhaul (Wally Pages tokens)
- 2-PR chain, each under 400-line budget

### Out of Scope
- Build tooling migration (Vite/TypeScript) — separate work
- HUD overlay — Wally uses sidepanel for control, not in-page HUD
- `@medv/finder` dependency — Wally has its own selector logic
- New permissions or manifest changes
- lib/ daemon changes (RED ZONE)

## Capabilities

### New Capabilities
- `selector-hierarchy`: Pure DOM functions (bestSemanticSelector, ancestorSelectors[], nearbyText, composedPath[]) for multi-strategy element resolution

### Modified Capabilities
- `recording`: Enriched action objects with hierarchy fields alongside existing `selector`
- `replay`: Hierarchy-first resolution in resolveInPage — best→target→ancestor fallback
- `sidepanel-ui`: Visual overhaul to Wally GitHub Pages aesthetic tokens
- `export`: Procedure adapter bridging WAL Procedure format to actions.jsonl

## Approach

### PR #1: Selector Hierarchy + Replay (~320 lines)

| Work Unit | File | Scope |
|-----------|------|-------|
| WU1 | `src/common/selector-hierarchy.js` (ADD) | Port WAL functions: `buildSelectorForElement`, `getAncestorSelectors`, `getBestSemanticSelector`, `getNearbyText`, `getComposedPathSummary`. Pure JS, no deps. |
| WU2 | `src/content/recording-inject.js` (MOD) | Embed hierarchy functions into IIFE. Enrich `_push()` calls with `bestSemanticSelector`, `targetSelector`, `ancestorSelectors[]`, `nearbyText`, `composedPath[]`. Keep existing `__wally_resolveSelector` as fallback. |
| WU3 | `src/common/selector-grammar.js` (MOD) | Add `resolveWithSelectorHierarchy(step)` — mirrors WAL's `resolveElement()` with best→target→ancestor[0]→ancestor[n] chain. |
| WU3 | `src/background/service-worker.js` (MOD) | Upgrade `resolveInPage` to use hierarchy resolution. Add abort signal and retry count support. |

### PR #2: Adapter + Aesthetic Overhaul (~300 lines)

| Work Unit | File | Scope |
|-----------|------|-------|
| WU4 | `src/common/procedure-adapter.js` (ADD) | `procedureToWallyActionsJsonl(proc)` — converts WAL Procedure to actions.jsonl. Pure function, no chrome APIs. |
| WU5 | `src/sidepanel/sidepanel.html` (MOD) | Replace inline CSS with Wally Pages tokens: `#0f1115` bg, `#B8F5D8` mint accent, glass cards (`rgba 255 255 255 0.08`, `blur 12px`), `999px` pill buttons, `system-ui` font, `16px` card radius. |
| WU5 | `src/sidepanel/sidepanel.js` (MOD) | Render new hierarchy fields in action log. Update status dot colors (`#4ADE80` idle, `#ef4444` recording). |
| WU6 | `package.json` (MOD) | Version bump `0.1.0` → `0.2.0`. |

## Aesthetic Token Map (Wally Pages → Sidepanel)

| Token | Pages Value | Current Sidepanel | Target |
|-------|-------------|-------------------|--------|
| `--bg` | `#0f1115` | `#1a1a2e` | `#0f1115` |
| Accent | `#B8F5D8` | `#ff6b35` | `#B8F5D8` |
| Glass bg | `rgba(255,255,255,0.08)` | `#2d2d44` | glass |
| Glass border | `rgba(255,255,255,0.18)` | `#3d3d5c` | glass |
| Glass blur | `blur(12px)` | none | `blur(12px)` |
| Button radius | `999px` | `6px` | `999px` pill |
| Font | `system-ui` | `-apple-system` | `system-ui` |
| Status idle | `#4ADE80` | currentColor | `#4ADE80` |
| Status recording | keep red | `#ff6b6b` | `#ef4444` |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `extension/src/common/selector-hierarchy.js` | New | Selector hierarchy module |
| `extension/src/content/recording-inject.js` | Modified | IIFE enrichment with hierarchy |
| `extension/src/common/selector-grammar.js` | Modified | Hierarchy-first resolution |
| `extension/src/background/service-worker.js` | Modified | Replay upgrade + adapter hook |
| `extension/src/common/procedure-adapter.js` | New | WAL Procedure → actions.jsonl |
| `extension/src/sidepanel/sidepanel.html` | Modified | Full CSS aesthetic overhaul |
| `extension/src/sidepanel/sidepanel.js` | Modified | New field rendering + colors |
| `extension/package.json` | Modified | Version bump |
| `lib/**` | NONE | RED ZONE — zero changes |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Daemon regression from accidental lib/ edit | Low | RED ZONE gate: CI rejects any lib/ diff |
| Selector format backward compatibility | Medium | New fields additive; existing `selector` kept; old consumers ignore unknowns |
| IIFE size growth in recording-inject | Low | ~150 lines added; acceptable for extension context |
| Sidepanel CSS specificity | Low | Inline styles, full control, no external CSS conflicts |
| WAL Procedure model mismatch | Medium | Adapter converts at export boundary, not storage layer; storage stays Wally-native |

## Rollback

- **Per-PR revert**: Each PR is self-contained. `git revert <PR-merge-commit>` restores previous state.
- **PR #1 rollback**: Recording reverts to flat selectors, replay uses single-selector resolution. No data loss — new fields simply absent.
- **PR #2 rollback**: Sidepanel reverts to orange theme, adapter removed. Recording/replay still functional from PR #1 (if kept).
- **Full rollback**: Revert both PRs. Extension returns to v0.1.0 state.
- **No data migration needed**: New fields are additive; stored sessions remain valid.

## Success Criteria

- [ ] `git diff --name-only` shows ZERO `lib/` changes in both PRs
- [ ] Selector hierarchy produces correct bestSemanticSelector for elements with IDs, data-testid, and ARIA roles
- [ ] Replay resolves targets via hierarchy (best→target→ancestor) before falling back
- [ ] Existing flat-selector sessions replay correctly (backward compat)
- [ ] Sidepanel uses `#0f1115` bg, `#B8F5D8` mint accent, glass cards, pill buttons, system-ui font
- [ ] Exported actions.jsonl includes hierarchy fields
- [ ] WAL Procedure → actions.jsonl adapter produces valid output
- [ ] Both PRs under 400-line budget individually
- [ ] Extension loads and records without errors in Chrome
