# Tasks: wally-devtools-recorder

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~400 (220 + 180) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | DevTools plugin + converter | PR 1 | Manual: open DevTools → Recorder → export → verify actions.jsonl in SW | Chrome 112+ with extension loaded | Revert devtools.html + recorder-plugin.js + converter; manifest change is additive |
| 2 | SW merge + fallback + manifest | PR 2 | Manual: record mixed tabs (native + inject) → stop → verify merged sorted actions | Chrome with PR 1 loaded | Revert service-worker.js changes; manifest permissions are additive |

### RED ZONE Check

| File | Status | Notes |
|------|--------|-------|
| `lib/daemon.js` | **FROZEN** | Zero modifications. CDP 9222 ext-aux mode untouched. |
| `extension/src/content/recording-inject.js` | **FROZEN** | Zero modifications. IIFE reused by inject-fallback path. |
| `extension/src/content/content-script.js` | **FROZEN** | Zero modifications. CustomEvent relay unchanged. |
| `extension/src/common/constants.js` | **FROZEN** | Zero modifications. RECORDING_SCRIPT string reused as-is. |
| `lib/bridge.js` | **FROZEN** | Zero modifications. Session materialization unchanged. |

---

## Phase 1: Foundation — Manifest + DevTools Entry

- [x] 1.1 Add `"devtools_page": "src/devtools/devtools.html"` and `"devtools.recorder"` permission to `extension/manifest.json`. **RED ZONE**: all other manifest fields untouched.
- [x] 1.2 Create `extension/src/devtools/devtools.html` — minimal HTML that loads `recorder-plugin.js` as a `<script>`. Include Chrome version check: log warning + skip registration if < 105.
- [x] 1.3 Create `extension/src/common/puppeteer-wally-converter.js` — pure function: `convertUserFlow(userFlow) → WallyAction[]`. Map: click→click, navigate→navigate, type→fill, selectOption→select, keyDown→press, waitForElement→skip, unknown→skip+log `unhandled_step_type`. Empty input → empty array.

## Phase 2: DevTools Recorder Plugin

- [x] 2.1 Create `extension/src/devtools/recorder-plugin.js` — implement `stringify(userFlow)`: call converter, post actions to SW via `MSG_RECORDER_ACTIONS`, return `undefined` (non-blocking).
- [x] 2.2 Add `stringifyStep(step)` handler: call converter for single step, return JSON string or `""` for unknown types.
- [x] 2.3 Add `replay(userFlow)` handler: convert UserFlow → Wally actions, post `MSG_RECORDER_REPLAY` to SW, return Promise resolving on success / rejecting with `{error: "Cannot replay while recording"}` when active session.
- [x] 2.4 Guard: detect restricted pages (`chrome://`, `chrome-extension://`) — skip `registerRecorderExtensionPlugin` call.

## Phase 3: Service Worker — Recording Path + Merge

- [x] 3.1 Add `MSG_RECORDER_ACTIONS` handler to SW: receive `{tabId, url, page, actions}`, store in `nativeActions[tabId]`, mark tab in `nativeRecordedTabs` (Set).
- [x] 3.2 Add per-tab path tracking: when `MSG_RECORDER_ACTIONS` arrives for a tab, skip `recording-inject.js` injection for that tab via `nativeRecordedTabs` check.
- [x] 3.3 Add inject-fallback path: if no `MSG_RECORDER_ACTIONS` received for a tab within 2s of recording start, fall back to existing `recording-inject.js` injection.
- [x] 3.4 Add `MSG_RECORDER_REPLAY` handler: check active recording → reject if active, else convert + dispatch to replay engine.
- [x] 3.5 Modify merge-at-stop: after `fetchBridgeActions`, concatenate `nativeActions[]` + `injectActions[]` + `bridgeActions[]`, sort by `ts` using `localeCompare`.
- [x] 3.6 Add deduplication: for tabs in `nativeRecordedTabs`, discard any inject-path actions (prevent double-counting).
- [x] 3.7 Add `MSG_RECORDER_TAB_STATUS` handler: respond with tab's active recording state.

## Phase 4: Testing + Verification

- [ ] 4.1 Unit test `puppeteer-wally-converter.js`: 5 mapped types + unknown type skip + empty input.
- [ ] 4.2 Unit test `recorder-plugin.js` stringify: posts to SW, returns undefined (non-blocking).
- [ ] 4.3 Unit test `recorder-plugin.js` stringifyStep: single step conversion, unknown → `""`.
- [ ] 4.4 Unit test `recorder-plugin.js` replay: success path + blocked-during-recording rejection.
- [ ] 4.5 Integration test SW merge-at-stop: 3 sources (native + inject + bridge) merged + sorted; no bridge → page-only.
- [ ] 4.6 Integration test per-tab source tracking: native tab skips inject; no-native tab uses inject.
- [ ] 4.7 Integration test dedup: same tab delivers via both paths → only native kept.
- [ ] 4.8 Verify RED ZONE: `lib/daemon.js`, `recording-inject.js`, `content-script.js`, `constants.js`, `lib/bridge.js` — zero diff against base.

## Phase 5: Documentation

- [ ] 5.1 Update extension README: document DevTools Recorder integration, Chrome version requirements (105+ export, 112+ replay).
- [ ] 5.2 Document gap: wallet-detection events (`extension_connect`) not captured by Recorder path — only captured by custom inject.
