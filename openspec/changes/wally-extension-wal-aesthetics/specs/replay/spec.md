# Replay Specification (Delta)

## Purpose

Upgrade the Wally extension's replay engine to resolve elements via the selector hierarchy fallback chain (best → target → ancestor) before falling back to coordinates, making replay resilient to DOM mutations and layout shifts.

## ADDED Requirements

### Requirement: Hierarchy-First Element Resolution

The replay resolver MUST attempt element resolution in this order: `bestSemanticSelector`, `targetSelector`, `ancestorSelectors[0]`, `ancestorSelectors[1]`, …, `ancestorSelectors[n]`, then the legacy `selector` field, and finally coordinate-based fallback.

#### Scenario: bestSemanticSelector resolves on first try

- GIVEN a recorded action with `bestSemanticSelector: "[data-testid='login-form']"` and legacy `selector: "button 'Sign In'"`
- WHEN replay attempts to resolve the element
- THEN `bestSemanticSelector` is tried first and succeeds, skipping all other strategies

#### Scenario: bestSemanticSelector fails, ancestor succeeds

- GIVEN a recorded action whose `bestSemanticSelector` no longer matches (DOM changed)
- WHEN replay attempts to resolve the element
- THEN the resolver tries `targetSelector`, then each entry in `ancestorSelectors` in order, and succeeds on the first matching ancestor

#### Scenario: All selectors fail, legacy selector succeeds

- GIVEN a recorded action where all hierarchy fields fail to match
- WHEN replay attempts to resolve the element
- THEN the legacy `selector` field is tried and succeeds (backward compat with pre-hierarchy sessions)

#### Scenario: All selectors fail, coordinate fallback

- GIVEN a recorded action where no selector strategy matches
- WHEN replay attempts to resolve the element
- THEN the resolver falls back to the recorded coordinates and performs the action at that position

### Requirement: Flat-Selector Backward Compatibility

Sessions recorded before the hierarchy change (containing only `selector` with no hierarchy fields) MUST replay correctly. The resolver MUST treat missing hierarchy fields as empty/absent and proceed to the legacy `selector`.

#### Scenario: Pre-hierarchy session replay

- GIVEN a session saved before this change with only `selector` fields
- WHEN replay executes each action
- THEN every action resolves via the legacy `selector` field without errors

### Requirement: Abort Signal Support

The replay engine MUST accept an `AbortSignal` parameter. When the signal is aborted, the replay MUST stop after the current action completes and MUST NOT start the next action.

#### Scenario: User stops replay mid-sequence

- GIVEN a 10-action replay is running
- WHEN the user clicks "Stop" (fires AbortSignal) after action 3
- THEN actions 4–10 are not executed and the replay status shows "stopped"

### Requirement: Retry on Transient Resolution Failure

When a selector strategy returns null, the replay resolver MUST retry the same strategy up to 2 additional times with a 200ms delay before falling back to the next strategy.

#### Scenario: Element appears after short delay

- GIVEN a recorded action where the target element renders 150ms after page load
- WHEN replay attempts resolution at page-load time
- THEN the resolver retries `bestSemanticSelector` up to 3 times total and succeeds on the second attempt

#### Scenario: Element never appears

- GIVEN a recorded action where the target element does not exist in the DOM
- WHEN all retry attempts for all strategies are exhausted
- THEN the resolver returns `null` and the action is marked as failed in the replay log

## MODIFIED Requirements

### Requirement: resolveInPage Function

The `resolveInPage` function in `service-worker.js` MUST use the hierarchy-first resolution strategy instead of the current flat `resolveWithRetry` call.

(Previously: `resolveInPage` called `resolveWithRetry` with the single legacy `selector` string.)

#### Scenario: resolveInPage with hierarchy action

- GIVEN a replay step with hierarchy fields
- WHEN `resolveInPage` is called in the page context
- THEN it tries `bestSemanticSelector` → `targetSelector` → `ancestorSelectors` → `selector` in order

#### Scenario: resolveInPage with flat action

- GIVEN a replay step with only `selector` (no hierarchy fields)
- WHEN `resolveInPage` is called
- THEN it skips hierarchy strategies and resolves via the legacy `selector` directly
