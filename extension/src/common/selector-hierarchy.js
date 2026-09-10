/**
 * Wally Selector Hierarchy — multi-strategy element resolution.
 *
 * Pure DOM functions producing layered selectors (best semantic, target,
 * ancestor chain, nearby text, composed path) for resilient recording
 * and replay. No external dependencies.
 *
 * Ported from WAL selector hierarchy (lib/recording-script.js patterns).
 * Designed for IIFE embedding (no module imports needed at call site).
 */

const HIERARCHY_CAP = 7;

/**
 * Build a CSS selector string for any DOM Element using tag, id, classes,
 * nth-child, and positional heuristics. Produces queryable CSS selectors
 * (unlike __wally_resolveSelector which produces Wally-format strings).
 *
 * @param {Element} el
 * @returns {string} CSS selector that resolves via document.querySelector
 */
export function buildSelectorForElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return 'element';

  // 1. id (if stable — not auto-generated, not too long)
  if (el.id && !/^[0-9]/.test(el.id) && el.id.length < 50) {
    return '#' + el.id;
  }

  // 2. data-testid
  var testId = el.closest ? el.closest('[data-testid]') : null;
  if (testId) {
    var tid = testId.getAttribute('data-testid');
    if (tid) return '[data-testid="' + tid + '"]';
  }

  // 3. data-cy
  var cyTest = el.closest ? el.closest('[data-cy]') : null;
  if (cyTest) {
    var cyId = cyTest.getAttribute('data-cy');
    if (cyId) return '[data-cy="' + cyId + '"]';
  }

  // 4. aria-label
  var ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
  if (ariaLabel) return '[aria-label="' + ariaLabel + '"]';

  // 5. tag + classes
  var tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag && el.classList && el.classList.length > 0) {
    var classes = Array.prototype.slice.call(el.classList)
      .filter(function(c) { return !/^[0-9]/.test(c); })
      .map(function(c) { return '.' + c; })
      .join('');
    if (classes) return tag + classes;
  }

  // 6. nth-child path from element to nearest id/semantic ancestor
  var parts = [];
  var current = el;
  while (current && current !== document.documentElement && parts.length < 3) {
    var tagName = current.tagName ? current.tagName.toLowerCase() : '';
    if (!tagName) break;
    var parent = current.parentElement;
    if (parent) {
      var siblings = Array.prototype.slice.call(parent.children).filter(function(c) {
        return c.tagName && c.tagName.toLowerCase() === tagName;
      });
      if (siblings.length > 1) {
        var idx = siblings.indexOf(current) + 1;
        parts.unshift(tagName + ':nth-child(' + idx + ')');
      } else {
        parts.unshift(tagName);
      }
    } else {
      parts.unshift(tagName);
    }
    current = current.parentElement;
  }
  return parts.join(' > ') || tag || 'element';
}

/**
 * Walk ancestors from the element upward and return the first selector
 * derived from a strong semantic signal: id, data-testid, data-cy,
 * aria-label, or explicit role.
 *
 * @param {Element} el
 * @returns {string|null} CSS selector for the nearest semantic ancestor, or null
 */
export function getBestSemanticSelector(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;

  var current = el;
  while (current && current !== document.documentElement) {
    // id (stable, not auto-generated)
    if (current.id && !/^[0-9]/.test(current.id) && current.id.length < 50) {
      return '#' + current.id;
    }

    // data-testid
    var testId = current.getAttribute ? current.getAttribute('data-testid') : null;
    if (testId) return '[data-testid="' + testId + '"]';

    // data-cy
    var cyId = current.getAttribute ? current.getAttribute('data-cy') : null;
    if (cyId) return '[data-cy="' + cyId + '"]';

    // aria-label
    var ariaLabel = current.getAttribute ? current.getAttribute('aria-label') : null;
    if (ariaLabel) return '[aria-label="' + ariaLabel + '"]';

    // explicit role (skip "presentation" and "none")
    var role = current.getAttribute ? current.getAttribute('role') : null;
    if (role && role !== 'presentation' && role !== 'none') {
      return '[role="' + role + '"]';
    }

    current = current.parentElement;
  }
  return null;
}

/**
 * Return an ordered array of CSS selector strings from the closest
 * ancestor to the farthest, capped at 7 levels. Each entry is a
 * queryable CSS selector built from tag, id, classes, or nth-child.
 *
 * @param {Element} el
 * @returns {string[]}
 */
export function getAncestorSelectors(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return [];

  var result = [];
  var current = el.parentElement;
  while (current && current !== document.documentElement && result.length < HIERARCHY_CAP) {
    var selector = buildSelectorForElement(current);
    if (selector && selector !== 'element') {
      result.push(selector);
    }
    current = current.parentElement;
  }
  return result;
}

/**
 * Extract visible text from the element's nearest siblings or children
 * to provide human-readable context for debugging and fallback resolution.
 *
 * Priority: own textContent → aria-label → closest sibling text → parent text.
 *
 * @param {Element} el
 * @returns {string}
 */
export function getNearbyText(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

  // 1. Direct text content (trimmed, capped)
  var ownText = (el.textContent || '').trim().substring(0, 80);
  if (ownText && ownText.indexOf('@font-face') === -1 && ownText.indexOf('font-family') === -1) {
    return ownText;
  }

  // 2. aria-label
  var ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
  if (ariaLabel) return ariaLabel.trim().substring(0, 80);

  // 3. title attribute
  var title = el.getAttribute ? el.getAttribute('title') : null;
  if (title) return title.trim().substring(0, 80);

  // 4. Placeholder (for inputs)
  var placeholder = el.getAttribute ? el.getAttribute('placeholder') : null;
  if (placeholder) return placeholder.trim().substring(0, 80);

  // 5. Sibling text (nearest previous sibling)
  var prev = el.previousElementSibling;
  if (prev) {
    var sibText = (prev.textContent || '').trim().substring(0, 80);
    if (sibText && sibText.indexOf('@font-face') === -1) return sibText;
  }

  // 6. Parent text (shallow — only direct text nodes)
  var parent = el.parentElement;
  if (parent) {
    for (var i = 0; i < parent.childNodes.length; i++) {
      var node = parent.childNodes[i];
      if (node.nodeType === Node.TEXT_NODE) {
        var txt = (node.textContent || '').trim().substring(0, 80);
        if (txt) return txt;
      }
    }
  }

  return '';
}

/**
 * Return a compact array of {tag, index} objects representing the
 * element's composed event path (host → shadow boundary → inner).
 * Useful for shadow DOM debugging and fallback.
 *
 * @param {Element} el
 * @returns {Array<{tag: string, index: number}>}
 */
export function getComposedPathSummary(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return [];

  // If composedPath is available, use it
  if (typeof el === 'object' && el.closest) {
    // Walk up checking for shadow roots
    var result = [];
    var current = el;
    while (current && current !== document.documentElement) {
      // Check if parent has a shadow root containing this element
      var parent = current.parentElement || (current.getRootNode && current.getRootNode() !== document ? current.getRootNode().host : null);
      if (parent && parent.shadowRoot) {
        var children = Array.prototype.slice.call(parent.shadowRoot.children || []);
        var idx = children.indexOf(current);
        result.unshift({ tag: parent.tagName ? parent.tagName.toLowerCase() : 'unknown', index: idx >= 0 ? idx : 0 });
      }
      current = parent;
    }
    return result;
  }

  return [];
}
