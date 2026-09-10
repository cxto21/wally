/**
 * Puppeteer → Wally Action Converter
 *
 * Pure function: convertPuppeteerToWally(userFlow) → WallyAction[]
 *
 * Type mapping: click→click, navigate→navigate, type→fill,
 * selectOption→select, keyDown→press, waitForElement→skip,
 * unknown→skip + log (unhandled_step_type). Never throws.
 */

// ── Selector extraction ─────────────────────────────────────────

function extractSelector(target) {
  if (!target) return 'element';
  if (typeof target.selector === 'string') return target.selector;
  if (Array.isArray(target.selector) && target.selector.length > 0) {
    const last = target.selector[target.selector.length - 1];
    if (last && last.value) return last.value;
  }
  return 'element';
}

// ── Modifier mapping ────────────────────────────────────────────

const MODIFIER_FLAGS = [
  { flag: 1, name: 'Shift' },
  { flag: 2, name: 'Control' },
  { flag: 4, name: 'Alt' },
  { flag: 8, name: 'Meta' },
];

function mapModifiers(puppeteerModifiers) {
  if (!Array.isArray(puppeteerModifiers) || puppeteerModifiers.length === 0) return [];
  const result = [];
  for (const mod of puppeteerModifiers) {
    if (typeof mod === 'string') {
      result.push(mod);
    } else if (typeof mod === 'number') {
      for (const { flag, name } of MODIFIER_FLAGS) {
        if (mod & flag) result.push(name);
      }
    }
  }
  return result;
}

// ── Per-type converters ─────────────────────────────────────────

const CONVERTERS = {
  click(step) {
    return {
      type: 'click',
      selector: extractSelector(step.target),
      text: step.target?.text || '',
      button: step.button === 'right' ? 'right' : 'left',
    };
  },
  navigate(step) {
    return { type: 'navigate', url: step.url || '' };
  },
  type(step) {
    return { type: 'fill', selector: extractSelector(step.target), value: step.value || '' };
  },
  selectOption(step) {
    const options = Array.isArray(step.options)
      ? step.options.map(o => (typeof o === 'string' ? o : o.value || ''))
      : [];
    return { type: 'select', selector: extractSelector(step.target), options };
  },
  keyDown(step) {
    return {
      type: 'press',
      selector: extractSelector(step.target),
      key: step.key || '',
      modifiers: mapModifiers(step.modifiers),
    };
  },
  waitForElement() {
    return null; // No Wally equivalent
  },
};

// ── Public API ──────────────────────────────────────────────────

/**
 * Convert a Puppeteer UserFlow to an array of Wally actions.
 * @param {Object} userFlow — { title: string, steps: Step[] }
 * @returns {Array<Object>} Wally action objects
 */
export function convertPuppeteerToWally(userFlow) {
  if (!userFlow || !Array.isArray(userFlow.steps) || userFlow.steps.length === 0) return [];

  const actions = [];
  for (const step of userFlow.steps) {
    if (!step?.type) continue;
    const converter = CONVERTERS[step.type];
    if (!converter) {
      console.warn(`[Wally] unhandled_step_type: ${step.type}`);
      continue;
    }
    const action = converter(step);
    if (action) actions.push(action);
  }
  return actions;
}

/**
 * Convert a single Puppeteer step to a Wally action.
 * @param {Object} step — single Puppeteer step
 * @returns {Object|null} Wally action or null if unknown
 */
export function convertStep(step) {
  if (!step || !step.type) return null;
  const converter = CONVERTERS[step.type];
  if (!converter) {
    console.warn(`[Wally] unhandled_step_type: ${step.type}`);
    return null;
  }
  return converter(step);
}
