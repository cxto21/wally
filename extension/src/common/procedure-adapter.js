/**
 * WAL Procedure → Wally actions.jsonl Adapter
 *
 * Pure JS converter: takes a WAL Procedure object (steps[]) and produces
 * Wally-format action objects suitable for NDJSON serialization.
 * Zero Chrome APIs, zero DOM access — runs in Node, SW, or any JS context.
 */

/**
 * Map WAL step type to Wally action type.
 * WAL uses "type" for text input; Wally uses "fill".
 */
const TYPE_MAP = {
  click: 'click',
  type: 'fill',
  fill: 'fill',
  navigate: 'navigate',
  select: 'select',
  press: 'press',
  scroll: 'scroll',
  hover: 'hover',
};

/**
 * Convert a single WAL Procedure step into a Wally action object.
 * Preserves all hierarchy fields if present on the step.
 *
 * @param {Object} step - WAL Procedure step
 * @param {number} index - Step index (used for timestamp ordering)
 * @returns {Object} Wally action object
 */
function convertStep(step, index) {
  if (!step || typeof step !== 'object') return null;

  const actionType = TYPE_MAP[step.type] || step.type || 'click';

  const action = {
    type: actionType,
    selector: step.selector || '',
    timestamp: step.ts || step.timestamp || Date.now() + index,
  };

  // Hierarchy fields — preserved if present on the source step
  if (step.bestSemanticSelector) action.bestSemanticSelector = step.bestSemanticSelector;
  if (step.targetSelector) action.targetSelector = step.targetSelector;
  if (Array.isArray(step.ancestorSelectors) && step.ancestorSelectors.length > 0) {
    action.ancestorSelectors = step.ancestorSelectors;
  }
  if (step.nearbyText) action.nearbyText = step.nearbyText;
  if (Array.isArray(step.composedPath) && step.composedPath.length > 0) {
    action.composedPath = step.composedPath;
  }

  // Type-specific fields
  if (step.value !== undefined) action.value = step.value;
  if (step.url) action.url = step.url;
  if (step.text) action.text = step.text;
  if (step.key) action.key = step.key;
  if (step.options) action.options = step.options;
  if (step.scrollTop !== undefined) action.scrollTop = step.scrollTop;

  // Spread any extra params
  if (step.params && typeof step.params === 'object') {
    Object.assign(action, step.params);
  }

  return action;
}

/**
 * Convert a WAL Procedure object to an array of Wally action objects.
 *
 * @param {Object} procedure - WAL Procedure with steps[] array
 * @returns {Object[]} Array of Wally action objects
 */
export function procedureToWallyActionsJsonl(procedure) {
  if (!procedure || !Array.isArray(procedure.steps)) return [];

  return procedure.steps
    .map((step, i) => convertStep(step, i))
    .filter(Boolean);
}

/**
 * Serialize an array of Wally action objects to NDJSON (newline-delimited JSON).
 * Each action becomes one line of valid JSON.
 *
 * @param {Object[]} actions - Array of Wally action objects
 * @returns {string} NDJSON string (one JSON object per line)
 */
export function actionsToNdjson(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return '';
  return actions.map(a => JSON.stringify(a)).join('\n');
}
