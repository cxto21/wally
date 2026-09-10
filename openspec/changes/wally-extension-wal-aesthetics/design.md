# Design: wally-extension-wal-aesthetics

## Technical Approach

Port WAL's selector hierarchy (pure DOM functions) into the Wally extension as additive plain JS embedded inside the recording IIFE, then enrich `_push()` calls with hierarchy fields. Upgrade the replay resolver to a best→target→ancestor fallback chain. Add a pure-function procedure adapter for WAL→Wally export. Restyle the sidepanel with Wally GitHub Pages tokens. All work is extension-only — `lib/` is RED ZONE.

## Architecture Decisions

### Decision: IIFE-embedded hierarchy functions (not separate module import)

**Choice**: Embed hierarchy functions inline inside `recording-inject.js` as IIFE-local closures.
**Alternatives considered**: ES module import via `content-script.js` bridge; `@medv/finder` dependency.
**Rationale**: The recording IIFE runs in MAIN world with no module system. Embedding avoids CSP issues, keeps the IIFE self-contained, and matches the existing pattern (recording-inject.js is already fully self-contained). ~150 lines is acceptable overhead.

### Decision: Hierarchy-first replay resolution in service-worker, not in-page

**Choice**: Build the fallback chain (`bestSemanticSelector → targetSelector → ancestorSelectors[] → selector`) as a string-priority list in `resolveInPage`, executing each selector via the existing `resolveSelectorGrammar` in page context.
**Alternatives considered**: Move all resolution logic into page context as a single `resolveWithHierarchy` func; use AbortController for cancellation.
**Rationale**: Keeps the resolver logic centralized in SW where retry/abort is manageable. The page-context function stays simple (just CSS resolution). String selectors are passed one-at-a-time to the existing grammar resolver, minimizing code duplication.

### Decision: Pure adapter function, no Chrome APIs

**Choice**: `procedureToWallyActionsJsonl` is a standalone pure JS function in `src/common/procedure-adapter.js` with zero Chrome API calls.
**Alternatives considered**: Integrate adapter into service-worker export flow; make it a content script module.
**Rationale**: Enables unit testing in Node, reuse across contexts (SW, future CLI), and keeps the export boundary clean. The adapter converts at the export boundary, not the storage layer — storage stays Wally-native.

### Decision: CSS custom properties for sidepanel tokens

**Choice**: Define all `--wally-*` tokens on `:root` in sidepanel.html inline `<style>`. No build step, no CSS preprocessor.
**Alternatives considered**: PostCSS/Tailwind (requires build tooling); hardcoded values everywhere.
**Rationale**: Extension has no build step. CSS custom properties provide single-source-of-truth for the token map, and the sidepanel is a single HTML file — inline styles with variables are idiomatic.

## Data Flow

    recording-inject.js (MAIN world)
    ├── hierarchy funcs (IIFE-local closures)
    │   ├── buildSelectorForElement(el) → CSS string
    │   ├── getBestSemanticSelector(el) → string|null
    │   ├── getAncestorSelectors(el) → string[7]
    │   ├── getNearbyText(el) → string
    │   └── getComposedPathSummary(el) → {tag,index}[]
    └── _push(action) enriches with hierarchy fields
            ↓ CustomEvent
    content-script.js (isolated world) → relay
            ↓ chrome.runtime.sendMessage
    service-worker.js
    ├── session.actions[] (storage)
    └── resolveInPage(tabId, action)
        ├── try bestSemanticSelector → resolveSelectorGrammar
        ├── try targetSelector → resolveSelectorGrammar
        ├── try ancestorSelectors[0..n] → resolveSelectorGrammar
        ├── try selector → resolveSelectorGrammar
        └── coordinate fallback

    procedure-adapter.js (pure function)
    WAL Procedure.steps[] → Wally action[] → actionsToNdjson() → NDJSON string

## File Changes

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `src/common/selector-hierarchy.js` | Create | ~120 | Pure DOM module: `buildSelectorForElement`, `getBestSemanticSelector`, `getAncestorSelectors`, `getNearbyText`, `getComposedPathSummary`. No deps. |
| `src/content/recording-inject.js` | Modify | +150 | Embed hierarchy funcs into IIFE. Enrich all `_push()` calls with `bestSemanticSelector`, `targetSelector`, `ancestorSelectors[]`, `nearbyText`, `composedPath[]`. Keep legacy `selector`. |
| `src/background/service-worker.js` | Modify | +80 | Upgrade `resolveInPage` to hierarchy-first chain. Add `resolveWithHierarchy(action, tabId)` that iterates selector strategies. Add `AbortSignal` support to `replaySession`. |
| `src/common/procedure-adapter.js` | Create | ~80 | `procedureToWallyActionsJsonl(proc)` — pure function, no Chrome APIs. `actionsToNdjson(actions)` — NDJSON serializer. |
| `src/sidepanel/sidepanel.html` | Modify | ~100 | Replace inline CSS with `--wally-*` tokens. Glass cards (`rgba(255,255,255,0.08)`, `blur(12px)`), pill buttons (`999px`), `#0f1115` bg, `#B8F5D8` mint accent, `system-ui` font. |
| `src/sidepanel/sidepanel.js` | Modify | +20 | Render hierarchy fields in log entries. Update status dot colors (`#4ADE80` idle, `#ef4444` recording). |
| `extension/package.json` | Modify | 1 | Version bump `0.1.0` → `0.2.0`. |

## Interfaces / Contracts

### Enriched Action Object Schema

```js
{
  type: 'click',           // existing
  selector: 'button "X"',  // existing — primary fallback
  bestSemanticSelector: '[data-testid="nav"]',  // NEW — tried first
  targetSelector: '#btn',                        // NEW — direct target
  ancestorSelectors: ['[data-testid="nav"]', 'section > div'],  // NEW — fallback chain
  nearbyText: 'Submit',                          // NEW — human context
  composedPath: [],                              // NEW — shadow DOM trace
  text: 'Submit',      // existing
  position: {x, y},    // existing
  url: '...',           // existing
  ts: '...',            // existing
}
```

### Adapter Mapping: WAL Procedure → Wally Action

```
WAL Step.type → Wally action.type    (click→click, type→fill, navigate→navigate)
WAL Step.selector → Wally action.selector + hierarchy fields (if present)
WAL Step.value → Wally action.value
WAL Step.url → Wally action.url
WAL Step.params → spread into action
```

### Replay Resolution Chain

```
resolveWithHierarchy(action, tabId):
  strategies = [
    action.bestSemanticSelector,
    action.targetSelector,
    ...(action.ancestorSelectors || []),
    action.selector
  ].filter(Boolean)

  for strategy in strategies:
    el = await resolveWithRetry(tabId, strategy, 2000)
    if el.found: return el

  return { found: false }  // coordinate fallback handled by caller
```

## RED ZONE: lib/ Protection

| Rule | Enforcement |
|------|-------------|
| `lib/*.js` — zero modifications | Gate: `git diff --name-only` must NOT include any `lib/` path |
| `lib/recording-script.js` — no edits | Shared daemon recording script |
| `lib/bridge.js`, `lib/daemon.js` | CDP/bridge infrastructure untouched |
| CI verification | PR merge requires clean lib/ diff |

**Rationale**: Daemon records extension popups via CDP — capability the browser extension cannot replicate. Mixing extension work into daemon files risks invisible regression.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | selector-hierarchy.js functions | jsdom: verify `buildSelectorForElement` returns queryable selectors; `getBestSemanticSelector` finds data-testid/aria/role; `getAncestorSelectors` caps at 7; `getNearbyText` extracts text; `getComposedPathSummary` handles shadow DOM |
| Unit | procedure-adapter.js | Node: verify WAL Procedure→action mapping, NDJSON serialization, empty/missing fields |
| Integration | resolveWithHierarchy chain | Mock `chrome.scripting.executeScript` to verify best→target→ancestor→selector fallback order |
| Integration | recording-inject enrichment | Inject IIFE into test page, dispatch click, verify action object has all hierarchy fields |
| E2E | Sidepanel aesthetics | Manual: open sidepanel, verify `#0f1115` bg, mint accent, glass cards, pill buttons |
| E2E | Replay backward compat | Record flat-selector session, replay — verify no errors |

## Migration / Rollout

No data migration required. New fields are additive — existing sessions (without hierarchy fields) replay correctly via the legacy `selector` fallback. The resolver skips absent hierarchy fields gracefully.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| IIFE size growth (+150 lines) | Low | Acceptable for extension context; no network cost |
| Selector format backward compat | Medium | New fields additive; `selector` kept; old consumers ignore unknowns |
| AbortSignal support in replay | Low | Add signal parameter; check between actions; existing timeout still works |
| Sidepanel CSS specificity conflicts | Low | All inline styles; full control; no external CSS |
| WAL Procedure model mismatch | Medium | Adapter converts at export boundary only; storage stays Wally-native |
| DOM mutation breaks hierarchy selectors | Low | Hierarchy IS the resilience mechanism — multiple fallback strategies |

## Open Questions

- [ ] Should `resolveWithHierarchy` use a shared AbortSignal from `replaySession` or per-action signals?
- [ ] Is 7-level ancestor cap sufficient for deeply nested SPA components (Radix, etc.)?
- [ ] Should `getNearbyText` be limited to button/link elements or apply to all action types?
