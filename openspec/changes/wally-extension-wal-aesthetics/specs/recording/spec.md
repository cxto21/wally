# Recording Specification (Delta)

## Purpose

Enrich the Wally extension's recording pipeline with selector hierarchy fields on every captured action, while preserving backward compatibility with flat-selector consumers.

## ADDED Requirements

### Requirement: Hierarchy-Enriched Action Objects

The recording IIFE MUST attach `bestSemanticSelector`, `targetSelector`, `ancestorSelectors`, `nearbyText`, and `composedPath` fields to every action object produced by `_push()`.

#### Scenario: Click on button with data-testid ancestor

- GIVEN a recording session is active
- WHEN the user clicks a `<button>` inside `<div data-testid="nav">`
- THEN the dispatched action object contains:
  - `bestSemanticSelector` resolving to the `data-testid` ancestor
  - `targetSelector` resolving to the button itself
  - `ancestorSelectors` as a non-empty array
  - `nearbyText` containing the button's visible text
  - `composedPath` as an array

#### Scenario: Legacy `selector` field preserved

- GIVEN a recording session is active
- WHEN any DOM event is captured
- THEN the action object retains its existing `selector` field with the same value as before this change

### Requirement: IIFE Embedding of Hierarchy Functions

The hierarchy module functions (`buildSelectorForElement`, `getAncestorSelectors`, `getBestSemanticSelector`, `getNearbyText`, `getComposedPathSummary`) MUST be embedded inline within the recording IIFE in `recording-inject.js`.

#### Scenario: IIFE executes in MAIN world

- GIVEN the content script injects the recording IIFE into the page
- WHEN the IIFE loads
- THEN all hierarchy functions are available as local closures within the IIFE scope, with no external module imports

### Requirement: No Dependency on @medv/finder

The recording enrichment MUST NOT introduce any external dependency. CSS selector construction MUST use the existing Wally selector logic and the ported pure-DOM hierarchy functions only.

#### Scenario: Extension loads without new npm packages

- GIVEN the extension manifest and package.json
- WHEN the extension is loaded in Chrome
- THEN no new third-party packages are required and `npm install` adds zero new entries

## MODIFIED Requirements

### Requirement: Action Object Schema

Each recorded action MUST include all existing fields (`type`, `selector`, `url`, `timestamp`, `value` where applicable) PLUS the new hierarchy fields. The `selector` field is kept as the primary fallback; hierarchy fields are additive.

(Previously: Action objects contained `type`, `selector`, `url`, `timestamp`, and type-specific fields only.)

#### Scenario: Action captured during recording

- GIVEN a user interacts with a page while recording
- WHEN the action is dispatched via CustomEvent
- THEN the action object has both the original `selector` string AND the new `bestSemanticSelector`, `targetSelector`, `ancestorSelectors[]`, `nearbyText`, `composedPath[]` fields

#### Scenario: Stored session with new fields

- GIVEN a session is saved to Chrome storage
- WHEN the session is reloaded
- THEN all hierarchy fields are present and intact alongside legacy fields
