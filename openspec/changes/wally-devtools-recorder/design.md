# Design: wally-devtools-recorder

## Technical Approach

Replace custom `recording-inject.js` for **web page** recording with Chrome's native `chrome.devtools.recorder` plugin API. The SW remains the single convergence point: web recordings arrive from DevTools pages, popup recordings arrive from the bridge. The Puppeteer→Wally converter is a pure, unit-testable translation layer. Daemon/bridge for `chrome-extension://` popups is unchanged (RED ZONE).

## Architecture Decisions

### Decision: Merge-at-Export Multitab Strategy

**Choice**: Each tab's DevTools page sends its recording to the SW on export; SW merges all tab recordings + bridge popup actions at stop, sorted by `ts`.
**Alternatives considered**: Live event streaming (blocked — no public per-step callback in Recorder API); DevTools page as coordinator (same as merge-at-export, just different description).
**Rationale**: Recorder has no public per-step callback. Merge-at-export is the only viable option that uses stable public APIs. The existing `trackedTabs` + `localeCompare` sort pattern already proves this model.

### Decision: Dual Recording Path with Per-Tab Source Tracking

**Choice**: Track `nativeRecordedTabs` (Set of tabIds) in SW. If `MSG_RECORDER_ACTIONS` arrives for a tab, skip inject injection for that tab. Otherwise, inject `recording-inject.js`.
**Alternatives considered**: Always inject + always receive Recorder (redundant capture); always inject for all tabs (keeps 600-line IIFE for web).
**Rationale**: Avoids duplicate actions from the same tab. Clear ownership per source.

### Decision: Converter Tolerates Unknown Puppeteer Types

**Choice**: `puppeteer-wally-converter.js` maps known types and logs unknowns as `unhandled_step_type` without throwing. Unknown steps are skipped in output.
**Alternatives considered**: Throw on unknown type (breaks export if Puppeteer schema evolves); map unknowns to generic action (incorrect behavior).
**Rationale**: Puppeteer schema evolves independently. Tolerance ensures forward-compatibility.

### Decision: Fallback to Inject When DevTools Closed

**Choice**: If no Recorder data arrives for a tab after 2s of recording, mark it inject-path. The existing `recording-inject.js` IIFE captures actions for that tab.
**Alternatives considered**: Prompt user to open DevTools (intrusive); use Recorder API for all tabs (impossible without DevTools open).
**Rationale**: Transparent to user. Web-only mode (no daemon) still works. DevTools-open requirement is the primary UX tradeoff.

## Data Flow

```
Tab A (DevTools open) ──→ recorder-plugin.js ──→ stringify() ──→ puppeteer-wally-converter ──→ SW (MSG_RECORDER_ACTIONS)
Tab B (no DevTools)    ──→ recording-inject.js ──→ CustomEvent ──→ content-script.js ──→ SW (cs_step)
Popup (daemon)         ──→ lib/daemon.js ──→ bridge (POST /actions) ──→ SW (fetchBridgeActions)
                                                          │
                                         SW.merge() ──────┘──→ session.actions[] sorted by ts
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `extension/manifest.json` | Modify | Add `devtools_page`, `devtools.recorder` permission |
| `extension/src/devtools/devtools.html` | Create | DevTools entry page, loads recorder-plugin.js |
| `extension/src/devtools/recorder-plugin.js` | Create | Wally plugin: stringify / stringifyStep / replay handlers |
| `extension/src/common/puppeteer-wally-converter.js` | Create | Pure Puppeteer UserFlow → Wally actions converter |
| `extension/src/background/service-worker.js` | Modify | Add MSG_RECORDER_ACTIONS handler, nativeRecordedTabs tracking, merge-at-stop |
| `lib/daemon.js` | Keep | RED ZONE — no changes |
| `extension/src/content/recording-inject.js` | Keep | RED ZONE — popup path unchanged |
| `extension/src/content/content-script.js` | Keep | CustomEvent relay unchanged |
| `extension/src/common/constants.js` | Keep | RECORDING_SCRIPT string reused |

## Interfaces / Contracts

### Message Types (SW ↔ DevTools)

```javascript
// DevTools page → SW
MSG_RECORDER_ACTIONS = 'recorder_actions'  // { tabId, url, page, actions: WallyAction[] }
MSG_RECORDER_REPLAY  = 'recorder_replay'   // { actions: WallyAction[] }
MSG_RECORDER_TAB_STATUS = 'recorder_tab_status' // { tabId, active: boolean }

// SW → DevTools page
MSG_RECORDER_REPLAY_RESULT = 'recorder_replay_result' // { ok, error?, replayed?, total? }
```

### Puppeteer → Wally Type Mapping

| Puppeteer Type | Wally Type | Notes |
|----------------|------------|-------|
| `click` | `click` | selector from `step.target.selector` |
| `navigate` | `navigate` | url from `step.url` |
| `type` | `fill` | value from `step.value` |
| `selectOption` | `select` | options from `step.options` |
| `keyDown` | `press` | key from `step.key`, modifiers from `step.modifiers` |
| `waitForElement` | skip | No Wally equivalent; log + skip |
| `scroll` / `scrollIntoView` | skip | Unknown type; log `unhandled_step_type` |
| (unknown) | skip | Log + skip; never throw |

### Session Merge Logic (at stop)

```
session.actions = [...nativeActions, ...injectActions, ...bridgeActions]
session.actions.sort((a, b) => a.ts.localeCompare(b.ts))
```

## RED ZONE Protection

- `lib/daemon.js` — zero modifications. Popup recording via CDP 9222 ext-aux mode is untouched.
- `extension/src/content/recording-inject.js` — zero modifications. IIFE still used by inject-fallback path and daemon.
- `extension/src/content/content-script.js` — zero modifications. CustomEvent relay for daemon-captured pages unchanged.
- `extension/src/common/constants.js` — zero modifications. RECORDING_SCRIPT string reused as-is.
- `lib/bridge.js` — zero modifications. Session materialization unchanged.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. The design operates entirely within Chrome extension APIs (messaging, scripting, storage, DevTools).

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `puppeteer-wally-converter.js` | Test each Puppeteer step type → Wally action mapping. Test unknown types logged + skipped. Test empty UserFlow. |
| Unit | `recorder-plugin.js` stringify | Test plugin receives UserFlow, calls converter, posts to SW. Test non-blocking return. |
| Unit | `recorder-plugin.js` replay | Test converts + dispatches to SW. Test blocks during active recording. |
| Integration | SW merge-at-stop | Test 3 sources (native + inject + bridge) merged and sorted. Test no bridge available. |
| Integration | Per-tab source tracking | Test nativeRecordedTabs prevents inject for native tabs. Test DevTools closed → inject fallback. |
| E2E | Manual Chrome 112+ | Open DevTools → Recorder panel → record web interactions → export → verify Wally actions.jsonl. |
| E2E | Manual Chrome 105-111 | DevTools open → export only (no replay). Verify stringify works. |
| E2E | Manual fallback | Close DevTools mid-recording → verify inject captures subsequent actions. |

## Migration / Rollout

No data migration required. The change is additive: new `devtools_page` + plugin registration. Existing sessions and replay engine are unaffected. Feature is opt-in by opening DevTools Recorder panel.

## Open Questions

- [ ] Should `devtools.html` detect Chrome version < 105 and disable plugin registration? (Proposal says yes; design agrees.)
- [ ] Should the SW surface a `recorder_tab_status` message to notify when a tab switches between native/inject paths? (Currently implicit via MSG_RECORDER_ACTIONS arrival.)
- [ ] Wallet-detection events (`extension_connect`) only produced by custom inject; Recorder path will not capture them. Document this gap in user-facing docs?
