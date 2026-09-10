# Recording Web Specification

## Purpose

Define how web page recording selects between Chrome's native Recorder (via DevTools plugin) and the custom inject fallback (via `recording-inject.js`). Daemon/bridge popup recording is unchanged and kept in `lib/` red zone.

## Requirements

### Requirement: Native Recorder Path

When the DevTools Recorder panel is open on a web tab, recording actions from that tab MUST be captured via the Recorder plugin's `stringify` handler and forwarded to the Service Worker as Wally-format actions. This path MUST NOT inject `recording-inject.js`.

#### Scenario: DevTools open — native capture

- GIVEN a web tab with DevTools open and the Recorder panel active
- WHEN the user interacts (click, fill, navigate)
- THEN the Recorder plugin captures the step via Puppeteer schema
- AND `stringify` converts it to Wally action format
- AND the SW receives the action with correct `tabId`, `url`, and `page`
- AND `recording-inject.js` is NOT injected into that tab

#### Scenario: DevTools open but Recorder panel not active

- GIVEN a web tab with DevTools open but Recorder panel not selected
- WHEN the user interacts
- THEN the custom inject path captures the action (same as no DevTools)

### Requirement: Custom Inject Fallback

When DevTools is NOT open on a web tab (or Recorder panel is not active), the extension MUST fall back to the existing `recording-inject.js` IIFE capture via `chrome.scripting.executeScript`. This preserves current recording behavior for all web tabs.

#### Scenario: No DevTools — inject fallback

- GIVEN a web tab with no DevTools open
- WHEN the user interacts during an active recording
- THEN `recording-inject.js` is injected via `chrome.scripting.executeScript`
- AND actions are captured via `__wally_actions` polling (existing behavior)
- AND the SW receives the action with correct tab context

#### Scenario: DevTools closed mid-recording

- GIVEN a tab that was recording via native Recorder with DevTools open
- WHEN the user closes DevTools
- THEN subsequent actions on that tab are captured via the inject fallback
- AND both sets of actions (native + inject) are merged in the session

### Requirement: Path Detection

The SW MUST determine the recording path per-tab by checking whether the Recorder plugin has delivered actions for that tab. If `MSG_RECORDER_ACTIONS` arrives for a tab, that tab is on the native path. Otherwise, it uses the inject path.

#### Scenario: SW receives native action for tab

- GIVEN an active recording session
- WHEN the SW receives `MSG_RECORDER_ACTIONS` for tabId 42
- THEN tab 42 is marked as native-recorded
- AND the inject injection is NOT attempted for tab 42

#### Scenario: Tab has no native actions

- GIVEN an active recording session
- WHEN tab 42 has not sent any `MSG_RECORDER_ACTIONS`
- THEN the SW uses the inject path for tab 42

### Requirement: Single Recording-Script Source

`RECORDING_SCRIPT` MUST be defined once in `constants.js` and reused by all injection paths. `recording-inject.js` MUST contain the IIFE logic only, importing from `constants.js` where needed.

#### Scenario: Constants change propagates

- GIVEN a field added to `RECORDING_SCRIPT` in `constants.js`
- WHEN the extension is rebuilt
- THEN all injection paths (inject fallback, daemon) use the updated script
- AND no duplicate copy exists in `recording-inject.js`

### Requirement: Daemon Popup Recording Unchanged

Extension popup recording via `lib/daemon.js` (CDP 9222, ext-aux mode) MUST remain untouched. The daemon discovers other extensions' targets, captures popup actions, and forwards them to the bridge. This path is the ONLY way to capture `chrome-extension://` popup interactions.

#### Scenario: Popup recording via daemon

- GIVEN Chrome launched with `--remote-debugging-port=9222`
- WHEN the user opens a wallet popup and confirms a transaction
- THEN the daemon captures the popup action
- AND forwards it to the bridge
- AND the action is merged at stop (see export-merge spec)

#### Scenario: No daemon — web-only mode

- GIVEN recording started without daemon
- WHEN the user interacts with a wallet popup
- THEN the popup interaction is NOT captured
- AND a "popups not captured" notice is surfaced

## Edge Cases

- Tab with DevTools open navigates to `chrome://`: native path stops, no inject attempted (restricted URL)
- Multiple DevTools panels open across tabs: each tab independently uses native or inject path
- Worker restart mid-recording: recovered session uses inject path for all tabs (native state not persisted)

## Dependencies

- `recording-inject.js` (RED ZONE — no modifications)
- `lib/daemon.js` (RED ZONE — no modifications)
- DevTools Recorder plugin (`devtools-recorder-plugin` spec)
- Service Worker merge handlers (`export-merge` spec)
