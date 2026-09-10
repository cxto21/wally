# Export Merge Specification

## Purpose

Define how the Service Worker merges recordings from multiple sources (DevTools Recorder plugin per-tab, custom inject fallback, and daemon bridge popup actions) into a single session bundle at stop time.

## Requirements

### Requirement: Multi-Source Action Accumulation

During recording, the SW MUST accumulate actions from three independent sources: (1) Recorder plugin forwarded actions (`MSG_RECORDER_ACTIONS`), (2) inject-fallback polled actions (`__wally_actions`), and (3) bridge popup actions (daemon ext-aux). Each source writes to `session.actions[]` with correct `tabId`, `tabUrl`, `url`, and `page` fields.

#### Scenario: Mixed sources during recording

- GIVEN a session with tab A (DevTools open → native), tab B (no DevTools → inject), and a wallet popup (daemon)
- WHEN actions arrive from all three sources
- THEN `session.actions` contains actions from all sources
- AND each action has the correct source's tab metadata

### Requirement: Merge at Stop

At stop, the SW MUST fetch bridge-captured actions (popup recordings) via `fetchBridgeActions(session.id)`, concatenate them with accumulated page actions, and sort the entire array by `ts` (ISO timestamp). The final bundle MUST contain all actions in chronological order.

#### Scenario: Stop merges bridge popup actions

- GIVEN 12 page actions (8 native + 4 inject) and 3 bridge popup actions
- WHEN recording stops
- THEN the SW calls `fetchBridgeActions`
- AND concatenates bridge actions into `session.actions`
- AND sorts all 15 actions by `ts`
- AND the saved session contains the merged, sorted array

#### Scenario: No bridge available

- GIVEN a session with no bridge/daemon running
- WHEN recording stops
- THEN `fetchBridgeActions` returns `[]`
- AND the session bundle contains only page actions (native + inject)
- AND no error is surfaced (web-only mode is valid)

### Requirement: Timestamp-Based Sort

Actions from all sources MUST be sorted by `ts` field using lexicographic comparison (`localeCompare`). Actions with identical timestamps maintain insertion order (stable sort).

#### Scenario: Interleaved timestamps

- GIVEN native action at `10:00:01.000`, inject action at `10:00:00.500`, bridge action at `10:00:00.800`
- WHEN merge sort runs
- THEN the order is: inject (0.500), bridge (0.800), native (1.000)

### Requirement: Per-Tab Recording Source Tracking

The SW MUST track which recording path each tab uses (native vs inject) to avoid duplicate capture. When the Recorder plugin delivers actions for a tab, that tab is excluded from inject injection.

#### Scenario: Tab A native, Tab B inject

- GIVEN tab A has DevTools Recorder active, tab B does not
- WHEN recording starts
- THEN tab A is NOT injected with `recording-inject.js`
- AND tab B IS injected with `recording-inject.js`
- AND both tabs' actions appear in the session

### Requirement: Bridge Action Deduplication

Bridge actions forwarded to the SW via `MSG_RECORDER_ACTIONS` (for web tabs recorded via DevTools) MUST NOT be double-counted with actions that arrive via `cs_step` (inject path). The SW MUST use the recording path flag to deduplicate.

#### Scenario: Same tab, both paths deliver

- GIVEN a tab where Recorder plugin sends an action AND the inject path also captures one
- WHEN both arrive at the SW
- THEN only the native (Recorder) action is kept for that tab
- AND the inject action is discarded

### Requirement: Session Bundle Integrity

The final session bundle MUST contain: `id`, `startUrl`, `startTime`, `endTime`, `actions[]` (merged + sorted), `network[]`, and `exported: false`. The `actions` array MUST include the initial `navigate` action plus all recorded steps.

#### Scenario: Complete bundle

- GIVEN a session with navigate + 4 actions + 2 bridge actions
- WHEN `saveSession` runs after merge
- THEN the stored session has 7 actions (1 navigate + 4 page + 2 bridge)
- AND actions are in chronological order
- AND `endTime` is set

## Edge Cases

- Bridge dies mid-recording: page-only merge at stop + console warning
- All tabs use native path (no inject): inject polling runs but finds 0 actions, no harm
- Very large sessions (>1000 actions): existing buffer flush handles chunked storage writes
- Session recovery after SW restart: recovered session uses inject path only (native state not persisted)
- Duplicate action from same timestamp: stable sort preserves insertion order

## Dependencies

- `fetchBridgeActions` (existing SW function)
- `MSG_RECORDER_ACTIONS` handler (new SW handler)
- Bridge live action channel (`POST /actions`)
- `recording-web` spec for path detection logic
- `devtools-recorder-plugin` spec for native action source
