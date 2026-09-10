# DevTools Recorder Plugin Specification

## Purpose

Register a Chrome DevTools Recorder extension plugin that converts Puppeteer UserFlow recordings into Wally's actions.jsonl format and supports replay via the RecorderView API.

## Requirements

### Requirement: Plugin Registration

The extension SHALL register a Recorder extension plugin via `chrome.devtools.recorder.registerRecorderExtensionPlugin()` in the `devtools_page` context. The plugin MUST provide `stringify`, `stringifyStep`, and `replay` handlers.

#### Scenario: Plugin registers on DevTools open

- GIVEN the user opens Chrome DevTools on a normal web page
- WHEN the DevTools page loads `recorder-plugin.js`
- THEN `registerRecorderExtensionPlugin` is called with `{stringify, stringifyStep, replay}`
- AND no errors are thrown in the DevTools console

#### Scenario: Plugin does not register on restricted pages

- GIVEN the user opens DevTools on a `chrome://` or `chrome-extension://` page
- WHEN the DevTools page loads
- THEN `registerRecorderExtensionPlugin` is NOT called
- AND no errors are thrown

### Requirement: stringify — Full Recording Conversion

The `stringify` handler MUST receive the complete Puppeteer UserFlow object at export time, convert it to Wally actions.jsonl via the Puppeteer→Wally converter, and forward the result to the Service Worker via `chrome.runtime.sendMessage`. The handler MUST NOT block the Recorder export UI.

#### Scenario: Single-tab recording exported

- GIVEN a UserFlow with 5 steps (navigate, click, fill, click, navigate)
- WHEN the user clicks "Export" in the Recorder panel
- THEN `stringify` receives the full UserFlow
- AND calls the converter to produce 6 Wally actions (including initial navigate)
- AND posts the actions array to the SW via `MSG_RECORDER_ACTIONS`
- AND returns `undefined` (non-blocking)

#### Scenario: Unknown step type encountered

- GIVEN a UserFlow containing a step with type `"scrollIntoView"` (unknown to converter)
- WHEN `stringify` processes the UserFlow
- THEN the converter logs the unknown type as `unhandled_step_type`
- AND skips that step in the output
- AND does NOT throw or abort the conversion

### Requirement: stringifyStep — Per-Step Conversion

The `stringifyStep` handler MUST accept a single Puppeteer step and return its Wally action representation as a string. This enables step-by-step preview in the Recorder UI.

#### Scenario: Click step converted

- GIVEN a Puppeteer step `{type: "click", target: {selector: "#btn"}, ...}`
- WHEN `stringifyStep` is called
- THEN it returns a Wally action JSON string with `{type: "click", selector: "#btn", ...}`

#### Scenario: Unknown step type returns empty string

- GIVEN a step with an unrecognized `type`
- WHEN `stringifyStep` is called
- THEN it returns `""` (empty string)
- AND logs the unhandled type

### Requirement: replay — RecorderView Integration

The `replay` handler MUST accept a Puppeteer UserFlow, convert it to Wally format, and replay it through the Wally extension's replay engine via the SW. The handler MUST return a Promise that resolves on success or rejects with a descriptive error.

#### Scenario: Successful replay

- GIVEN a valid UserFlow with 3 steps
- WHEN the user clicks "Replay" in the Recorder panel
- THEN `replay` converts and dispatches the steps to the SW
- AND returns a resolved Promise

#### Scenario: Replay blocked during active recording

- GIVEN an active Wally recording session
- WHEN the user clicks "Replay" in the Recorder panel
- THEN `replay` rejects with `{error: "Cannot replay while recording"}`
- AND the Recorder panel displays the error

### Requirement: DevTools Page Entry Point

The extension MUST declare `"devtools_page": "src/devtools/devtools.html"` in `manifest.json`. The HTML page MUST load `recorder-plugin.js` as a script. The manifest MUST include the `"devtools.recorder"` permission.

#### Scenario: Manifest declares devtools page

- GIVEN the extension manifest
- WHEN inspected
- THEN `"devtools_page"` points to `"src/devtools/devtools.html"`
- AND `"devtools.recorder"` is in the permissions array

#### Scenario: Chrome version check

- GIVEN Chrome version < 105
- WHEN `devtools.html` loads
- THEN it logs a warning and does NOT call `registerRecorderExtensionPlugin`

## Edge Cases

- DevTools closed and reopened: plugin re-registers without duplicate handlers
- Multiple tabs with DevTools open: each tab gets independent plugin instance
- UserFlow with zero steps: stringify returns empty actions array, no error
- Extension reload while DevTools open: plugin re-registers on next DevTools page load

## Dependencies

- Chrome 105+ for `registerRecorderExtensionPlugin` (export)
- Chrome 112+ for `replay` via RecorderView
- `puppeteer-wally-converter.js` for schema translation
- Service Worker message handlers for action forwarding
