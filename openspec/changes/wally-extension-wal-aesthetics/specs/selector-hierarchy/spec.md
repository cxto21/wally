# Selector Hierarchy Specification

## Purpose

Pure-DOM module providing multi-strategy element resolution. Produces layered selectors (best semantic, target, ancestor chain, nearby text, composed path) to make recording and replay resilient to DOM mutations.

## Requirements

### Requirement: buildSelectorForElement

The system MUST generate a CSS selector string for any DOM Element using tag, id, classes, nth-child, and positional heuristics.

#### Scenario: Element with stable id

- GIVEN an `<input id="email">` element
- WHEN `buildSelectorForElement(el)` is called
- THEN the returned selector resolves to that exact element via `document.querySelector`

#### Scenario: Element without id

- GIVEN a `<div class="card">` inside a `<section>` with no id
- WHEN `buildSelectorForElement(el)` is called
- THEN the returned selector is a positional path (e.g. `section > div.card:nth-child(1)`) that resolves to that element

#### Scenario: Shadow DOM host

- GIVEN an element inside an open shadow root
- WHEN `buildSelectorForElement(el)` is called
- THEN the selector is built from the host element outward and resolves correctly

### Requirement: getAncestorSelectors

The system MUST return an ordered array of CSS selector strings from the closest ancestor to the farthest, capped at 7 levels.

#### Scenario: Seven-level-deep element

- GIVEN an element nested 10 levels deep in the DOM
- WHEN `getAncestorSelectors(el)` is called
- THEN the array contains exactly 7 entries, closest ancestor first

#### Scenario: Shallow element

- GIVEN an element 2 levels from document root
- WHEN `getAncestorSelectors(el)` is called
- THEN the array contains at most 2 entries

#### Scenario: Empty for document root

- GIVEN `document.documentElement`
- WHEN `getAncestorSelectors(el)` is called
- THEN the returned array is empty

### Requirement: getBestSemanticSelector

The system MUST walk ancestors from the element upward and return the first selector derived from a strong semantic signal: `id`, `data-testid`, `data-cy`, `aria-label`, or explicit `role`.

#### Scenario: Ancestor has data-testid

- GIVEN an element inside `<div data-testid="login-form">`
- WHEN `getBestSemanticSelector(el)` is called
- THEN the returned selector resolves to that `data-testid` ancestor

#### Scenario: Element itself has role

- GIVEN `<button role="submit">`
- WHEN `getBestSemanticSelector(el)` is called
- THEN the returned selector targets the button via its role attribute

#### Scenario: No semantic signal in chain

- GIVEN a `<span>` inside generic `<div>` elements with no ids or test ids
- WHEN `getBestSemanticSelector(el)` is called
- THEN the returned value is `null`

### Requirement: getNearbyText

The system MUST extract visible text from the element's nearest siblings or children (within 50px or one sibling level) to provide human-readable context.

#### Scenario: Button with text content

- GIVEN `<button>Submit Order</button>`
- WHEN `getNearbyText(el)` is called
- THEN the result is `"Submit Order"`

#### Scenario: Icon button with aria-label

- GIVEN `<button aria-label="Close dialog">` with no text children
- WHEN `getNearbyText(el)` is called
- THEN the result is `"Close dialog"`

#### Scenario: Element with no visible text

- GIVEN a `<div>` containing only child elements and no text nodes
- WHEN `getNearbyText(el)` is called
- THEN the result is an empty string

### Requirement: getComposedPathSummary

The system MUST return a compact array of `{tag, index}` objects representing the element's composed event path (host → shadow boundary → inner).

#### Scenario: Element outside shadow DOM

- GIVEN a `<button>` in the main document tree
- WHEN `getComposedPathSummary(el)` is called
- THEN the result is an empty array (no shadow boundaries)

#### Scenario: Element inside shadow root

- GIVEN a `<span>` inside an open shadow root of `<my-component>`
- WHEN `getComposedPathSummary(el)` is called
- THEN the array contains at least the shadow host entry with its tag and child index
