# Replay Web Specification

## Purpose

Define how the extension replays Wally-recorded sessions via Chrome's RecorderView API (Chrome 112+), falling back to the existing inject-based replay engine when RecorderView is unavailable.

## Requirements

### Requirement: RecorderView Replay (Chrome 112+)

When Chrome 112+ is available, the extension SHOULD replay sessions by reconstructing a Puppeteer UserFlow from Wally actions and invoking it via the RecorderView API (`chrome.devtools.recorder.replay(userFlow)`). This delegates replay execution to Chrome's native replay engine with built-in wait-for-element and navigation handling.

#### Scenario: Replay via RecorderView

- GIVEN Chrome 112+ and a session with 5 Wally actions
- WHEN the user triggers replay from the sidepanel
- THEN the SW converts actions to a Puppeteer UserFlow
- AND calls RecorderView replay
- AND each step executes in the correct tab with correct selectors
- AND the sidepanel displays progress

#### Scenario: RecorderView replay completes

- GIVEN an active RecorderView replay
- WHEN all steps complete successfully
- THEN the SW receives a success callback
- AND the sidepanel shows "Replay complete (5/5)"

### Requirement: Inject-Based Replay Fallback

When RecorderView is unavailable (Chrome < 112) or the RecorderView call fails, the extension MUST fall back to the existing inject-based replay engine (`resolveWithHierarchy` + `chrome.scripting.executeScript`). This fallback MUST support the full Wally selector grammar.

#### Scenario: Chrome 110 — fallback replay

- GIVEN Chrome 110 (no RecorderView)
- WHEN the user triggers replay
- THEN the SW uses the inject-based engine
- AND selector resolution uses the hierarchy chain (best→target→ancestor→selector)
- AND actions execute via `executeScript` in MAIN world

#### Scenario: RecorderView fails — fallback

- GIVEN Chrome 112+ but RecorderView replay rejects
- WHEN the error is caught
- THEN the SW falls back to inject-based replay
- AND logs the RecorderView error for diagnostics

### Requirement: Multi-Tab Replay Routing

Replay MUST route actions to the correct tab. For native Recorder sessions, the converted UserFlow preserves per-tab context. For inject-fallback sessions, the existing `tabMap` logic (original tabId → replay tabId) is used.

#### Scenario: 3-tab session replayed

- GIVEN a session with actions across 3 tabs (google.com, naiamstudio.com, extension popup)
- WHEN replay starts
- THEN tab 1 actions run on a tab navigated to google.com
- AND tab 2 actions run on a new tab navigated to naiamstudio.com
- AND tab 3 popup actions run via daemon replay (if available)

#### Scenario: Tab closed before replay

- GIVEN a session where tab 2 was closed
- WHEN replay reaches a tab 2 action
- THEN a new tab is created for tab 2's URL
- AND the action runs on the new tab

### Requirement: Replay Stop

The user MUST be able to stop an in-progress replay. The SW MUST honor the stop request after the current action completes (graceful stop, not mid-action abort).

#### Scenario: User stops replay at action 3/10

- GIVEN an active replay at step 3 of 10
- WHEN the user clicks "Stop" in the sidepanel
- THEN `replayState.stopped = true`
- AND the replay loop breaks after action 3 completes
- AND the sidepanel shows "Stopped at 3/10"

### Requirement: Error Surfacing

Replay MUST surface errors for each failed action in the sidepanel. For inject-based replay, this means reading `executeScript` results. For RecorderView, this means handling the rejection reason.

#### Scenario: Element not found during replay

- GIVEN a replay step targeting `#nonexistent`
- WHEN the element is not found after retry timeout
- THEN the sidepanel shows the action, selector, and error reason
- AND replay continues with the next action

#### Scenario: RecorderView replay rejection

- GIVEN RecorderView rejects with `"Invalid user flow"`
- WHEN the fallback catches the error
- THEN the sidepanel shows the RecorderView error
- AND falls back to inject-based replay

## Edge Cases

- SPA navigation invalidates selectors mid-replay: per-action retry window handles this
- Popup closed before replay: explicit "popup no longer available" error
- Disabled/hidden target: wait then clear failure; never silent skip
- Network offline during replay: actions that trigger navigation will fail with network error surfaced

## Dependencies

- Chrome 112+ for RecorderView API
- `resolveWithHierarchy` and `resolveSelectorGrammar` (existing SW functions)
- Sidepanel UI for progress/error display
- Puppeteer→Wally converter (for UserFlow reconstruction)
