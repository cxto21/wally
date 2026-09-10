# Tasks: wally-extension-wal-aesthetics

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 550–600 (PR1 ~320, PR2 ~300) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR1 (hierarchy+replay) → PR2 (adapter+aesthetics) |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | PR | Test command | Harness | Rollback boundary |
|------|------|----|--------------|---------|-------------------|
| 1 | Selector hierarchy + replay | PR1 | Load ext in Chrome, record+replay | Record click on data-testid element, verify fallback chain | `selector-hierarchy.js`, `recording-inject.js`, `service-worker.js` |
| 2 | Adapter + sidepanel aesthetics | PR2 | `node -e "import('./src/common/procedure-adapter.js')"` | Open sidepanel, verify mint/glass UI, export WAL→NDJSON | `procedure-adapter.js`, `sidepanel/*`, `package.json` |

## RED ZONE: lib/ Protection

**lib/*.js** = ZERO MODIFICATION. Gate before every commit:
```sh
git diff --name-only | grep '^lib/' && echo "RED ZONE VIOLATION" && exit 1 || echo "OK"
```

---

## PR1: Selector Hierarchy + Replay (~320 lines)

### Phase 1: Foundation

- [x] 1.1 Create `src/common/selector-hierarchy.js` (~120 lines) — exports: `buildSelectorForElement`, `getBestSemanticSelector`, `getAncestorSelectors` (cap 7), `getNearbyText`, `getComposedPathSummary`. Pure DOM, no deps.

### Phase 2: Recording Enrichment

- [x] 2.1 Embed hierarchy functions as IIFE-local closures in `src/content/recording-inject.js` (~+150 lines) — no imports, inline before `_push`.
- [x] 2.2 Enrich all `_push()` calls with `bestSemanticSelector`, `targetSelector`, `ancestorSelectors[]`, `nearbyText`, `composedPath[]` — keep legacy `selector`.

### Phase 3: Replay Upgrade

- [x] 3.1 Add `resolveWithHierarchy(action, tabId)` to `src/background/service-worker.js` (~+80 lines) — fallback chain: bestSemanticSelector → targetSelector → ancestorSelectors → selector, each via `resolveWithRetry(2000)`.
- [x] 3.2 Add `AbortSignal` support to `replaySession` — check `signal.aborted` between actions, return `{ok:true, stopped:true}`.

### Phase 4: Gate

- [x] 4.1 RED ZONE check — zero `lib/` diffs.

---

## PR2: Adapter + Aesthetics (~300 lines)

### Phase 5: Adapter

- [x] 5.1 Create `src/common/procedure-adapter.js` (~80 lines) — `procedureToWallyActionsJsonl(proc)` pure function, `actionsToNdjson(actions)` NDJSON serializer. No Chrome APIs.
- [x] 5.2 Unit test adapter — empty proc, missing fields, hierarchy preservation, NDJSON line count.

### Phase 6: Sidepanel

- [x] 6.1 Restyle `src/sidepanel/sidepanel.html` (~100 lines) — `--wally-*` tokens on `:root`, glass cards (`rgba(255,255,255,0.08)`, `blur(12px)`, `border-radius:16px`), pill buttons (`999px`), bg `#0f1115`, mint `#B8F5D8`, `system-ui` font.
- [x] 6.2 Update `src/sidepanel/sidepanel.js` (+20 lines) — status dots: idle `#4ADE80`, recording `#ef4444`. Render hierarchy fields in log entries.

### Phase 7: Final

- [x] 7.1 Bump `extension/package.json` version `0.1.0` → `0.2.0`.
- [x] 7.2 RED ZONE check — zero `lib/` diffs.

---

## Dependencies

PR1: 1.1→2.1→2.2, 1.1→3.1→3.2, all→4.1
PR2: 5.1→5.2, 6.1→6.2, 5.2+6.2→7.1→7.2
Cross-PR: PR2 depends on PR1 merged
