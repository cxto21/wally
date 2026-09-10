# Export Specification (Delta)

## Purpose

Bridge WAL Procedure format to Wally's actions.jsonl export format, enabling interop between WAL-recorded procedures and Wally's bridge export pipeline without modifying Wally's storage model.

## ADDED Requirements

### Requirement: procedureToWallyActionsJsonl Adapter

The system MUST provide a pure function `procedureToWallyActionsJsonl(procedure)` that converts a WAL `Procedure` object into an array of Wally-format action objects suitable for `actions.jsonl` serialization.

#### Scenario: WAL Procedure with 3 steps converts to 3 actions

- GIVEN a WAL Procedure with `steps: [{type: "click", selector: "#btn"}, {type: "type", selector: "#input", value: "hello"}, {type: "navigate", url: "/done"}]`
- WHEN `procedureToWallyActionsJsonl(proc)` is called
- THEN the result is an array of 3 objects, each with `type`, `selector` (or hierarchy equivalents), `url`, and `timestamp` fields matching Wally's action schema

#### Scenario: Hierarchy fields are mapped

- GIVEN a WAL Procedure step with `bestSemanticSelector`, `ancestorSelectors[]`, `nearbyText`, `composedPath[]`
- WHEN the adapter converts it
- THEN the resulting Wally action object contains all hierarchy fields with values preserved from the source

### Requirement: Pure Function, No Chrome APIs

The adapter MUST be a pure JavaScript function with no `chrome.*` API calls, no DOM access, and no side effects. It MUST be importable in any JS context.

#### Scenario: Adapter runs in Node.js

- GIVEN a WAL Procedure object as a plain JS object
- WHEN `procedureToWallyActionsJsonl(proc)` is called in Node.js
- THEN it returns the converted array without errors and without requiring browser APIs

### Requirement: actions.jsonl Serialization Support

The system MUST provide a helper `actionsToNdjson(actions)` that serializes an array of Wally action objects into newline-delimited JSON (one JSON object per line).

#### Scenario: Three actions serialize to three lines

- GIVEN an array of 3 Wally action objects
- WHEN `actionsToNdjson(actions)` is called
- THEN the result is a string with exactly 3 lines, each a valid JSON object, separated by `\n`

### Requirement: Backward-Compatible Export

The existing `exportSession` flow in `service-worker.js` MUST continue to produce valid Wally session JSON. The WAL Procedure adapter is an additional export path, not a replacement.

#### Scenario: Standard Wally export unchanged

- GIVEN a session recorded in Wally
- WHEN the user clicks Export
- THEN the output format is the same Wally session JSON as before this change

#### Scenario: WAL Procedure export via adapter

- GIVEN a WAL Procedure object passed to the adapter
- WHEN the adapter output is serialized
- THEN the resulting actions.jsonl is valid NDJSON and each line parses as a Wally action object

## MODIFIED Requirements

### Requirement: Export Format Options

The export pipeline MUST support both Wally session JSON (default) and actions.jsonl (when a WAL Procedure source is provided or the caller explicitly requests NDJSON format).

(Previously: Export produced only Wally session JSON.)

#### Scenario: Export with Procedure source

- GIVEN the export function receives a WAL Procedure object
- WHEN export completes
- THEN the output is in actions.jsonl NDJSON format via the adapter

#### Scenario: Export without Procedure source (default)

- GIVEN the export function receives a Wally session object (no Procedure)
- WHEN export completes
- THEN the output is in standard Wally session JSON format
