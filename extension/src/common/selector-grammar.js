/**
 * Wally Selector Grammar — resolve Wally-format selectors to DOM elements.
 *
 * Port of __wally_resolveSelector from recording-inject.js.
 * CSS-first chain with XPath/text fallback. Never throws — returns
 * null for unparseable or unmatched selectors.
 *
 * Used by:
 * - service-worker.js (replay resolver)
 * - Tests (unit verification of grammar)
 */

/**
 * Resolve a Wally-format selector string to a DOM element.
 * Must run in a context where `document` is available (page or jsdom).
 *
 * Chain order: role+text, data-testid, #id, aria-label,
 * button "Text", link "Text", input/select[name], nth-child path.
 *
 * @param {string} sel - Wally selector string
 * @returns {Element|null}
 */
export function resolveSelectorGrammar(sel) {
  if (!sel || typeof sel !== 'string') return null;

  // 1. Role + text: button "Text" | link "Text" | [role] "Text"
  // Split on first space to avoid regex issues with special characters
  const spaceIdx = sel.indexOf(' ');
  if (spaceIdx > 0) {
    const role = sel.substring(0, spaceIdx);
    const rest = sel.substring(spaceIdx + 1).trim();
    // Must be quoted text: "..."
    if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
      const text = rest.slice(1, -1);
      if (text.length > 0) {
        // Special case: "link" maps to <a> tag
        const tagMap = { link: 'a' };
        const tagName = tagMap[role] || role;

        // Try role attribute first
        const roleEls = document.querySelectorAll('[role="' + role + '"]');
        for (const el of roleEls) {
          if ((el.textContent || '').trim().includes(text)) return el;
        }
        // Also try as tag name directly (e.g. "button" is also a tag)
        try {
          const tagEls = document.querySelectorAll(tagName);
          for (const el of tagEls) {
            if ((el.textContent || '').trim().includes(text)) return el;
          }
        } catch { /* not a valid tag name */ }
        return null;
      }
    }
  }

  // 2–6. CSS-parseable selectors (try querySelector first)
  try {
    // [data-testid="x"]
    const testIdMatch = sel.match(/^\[data-testid="([^"]+)"\]$/);
    if (testIdMatch) {
      const el = document.querySelector('[data-testid="' + testIdMatch[1] + '"]');
      if (el) return el;
    }

    // #id
    if (/^#[\w-]+$/.test(sel)) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    // [aria-label="x"]
    const ariaMatch = sel.match(/^\[aria-label="([^"]+)"\]$/);
    if (ariaMatch) {
      const el = document.querySelector('[aria-label="' + ariaMatch[1] + '"]');
      if (el) return el;
    }

    // input[name="x"] or select[name="x"]
    const nameMatch = sel.match(/^(input|textarea|select)(?:\[type="(\w+)"\])?\[name="([^"]+)"\]$/);
    if (nameMatch) {
      const [, tag, type, name] = nameMatch;
      let css = tag + '[name="' + name + '"]';
      if (type) css += '[type="' + type + '"]';
      const el = document.querySelector(css);
      if (el) return el;
    }

    // Fallback: try raw CSS selector for anything else
    const el = document.querySelector(sel);
    if (el) return el;
  } catch {
    // Malformed CSS — fall through to nth-child path
  }

  // 7. Nth-child path fallback: tag:nth-child(n) > tag:nth-child(n)
  const parts = sel.split(/\s*>\s*/);
  if (parts.length > 0) {
    let current = null;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      const nthMatch = part.match(/^(\w+)(?:[=:](\w+))?:(?:nth-child|nth-of-type)\((\d+)\)$/);
      if (nthMatch) {
        const [, tagName, _attr, idx] = nthMatch;
        const nth = parseInt(idx, 10);
        if (i === 0) {
          const candidates = document.querySelectorAll(tagName);
          current = candidates[nth - 1] || null;
        } else if (current) {
          const children = Array.from(current.children).filter(
            c => c.tagName && c.tagName.toLowerCase() === tagName
          );
          current = children[nth - 1] || null;
        }
        if (!current) return null;
      } else {
        // Plain tag name — wrap in try-catch for invalid CSS selectors
        try {
          if (i === 0) {
            current = document.querySelector(part);
          } else if (current) {
            current = current.querySelector(part);
          }
        } catch {
          return null;
        }
        if (!current) return null;
      }
    }
    return current;
  }

  return null;
}

/**
 * Retry resolveSelectorGrammar until element found or timeout.
 * Polls every 200ms for up to timeoutMs (default 5s).
 *
 * @param {string} selector
 * @param {Function} resolveFn - resolveSelectorGrammar function (for testing injection)
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{found: boolean, el: Element|null, attempts: number}>}
 */
export async function resolveWithRetry(selector, resolveFn, timeoutMs = 5000) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const el = resolveFn(selector);
    if (el) return { found: true, el, attempts };
    await new Promise(r => setTimeout(r, 200));
  }
  return { found: false, el: null, attempts };
}

/**
 * Resolve an element using the hierarchy-first fallback chain.
 * Tries bestSemanticSelector → targetSelector → ancestorSelectors → selector,
 * each via resolveWithRetry with 2000ms per strategy.
 *
 * @param {Object} action - Recorded action with hierarchy fields
 * @param {Function} resolveFn - resolveSelectorGrammar function (for testing injection)
 * @param {number} [strategyTimeoutMs=2000] - Timeout per individual strategy
 * @returns {Promise<{found: boolean, el: Element|null, strategy: string|null, attempts: number}>}
 */
export async function resolveWithSelectorHierarchy(action, resolveFn, strategyTimeoutMs = 2000) {
  const strategies = [];
  if (action.bestSemanticSelector) strategies.push(action.bestSemanticSelector);
  if (action.targetSelector) strategies.push(action.targetSelector);
  if (action.ancestorSelectors && action.ancestorSelectors.length > 0) {
    for (const anc of action.ancestorSelectors) {
      if (anc) strategies.push(anc);
    }
  }
  if (action.selector) strategies.push(action.selector);

  let totalAttempts = 0;
  for (const strategy of strategies) {
    const result = await resolveWithRetry(strategy, resolveFn, strategyTimeoutMs);
    totalAttempts += result.attempts;
    if (result.found) {
      return { found: true, el: result.el, strategy, attempts: totalAttempts };
    }
  }
  return { found: false, el: null, strategy: null, attempts: totalAttempts };
}
