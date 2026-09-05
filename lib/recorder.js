/**
 * Wally Recorder — reusable recording module
 *
 * Injects click/fill/wallet listeners into any page via CDP.
 * Used by both `record start` and `daemon start`.
 *
 * Key features:
 * - Uses deepEventTarget() to traverse shadow DOM
 * - Captures pointerdown/pointerup (not just click)
 * - Handles select elements (dropdowns)
 * - Handles dblclick, contextmenu, focus events
 * - Uses capture phase for all listeners
 */

/**
 * JS that gets injected into pages to capture user interactions.
 * Stores actions in window.__wally_actions array.
 */
const RECORDING_SCRIPT = `
(function() {
  if (window.__wally_recording_injected) return;
  window.__wally_recording_injected = true;
  window.__wally_actions = [];

  // ═══════════════════════════════════════════════════════════════
  // DEEP EVENT TARGET — traverse shadow DOM
  // ═══════════════════════════════════════════════════════════════
  function deepEventTarget(event) {
    let target = event.composedPath?.()[0] || event.target;
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return target;
    // Walk up through shadow roots
    while (target.shadowRoot) {
      const inner = target.shadowRoot.elementFromPoint?.(event.clientX, event.clientY);
      if (inner) target = inner;
      else break;
    }
    return target;
  }

  // ═══════════════════════════════════════════════════════════════
  // SELECTOR RESOLUTION — smart selectors
  // ═══════════════════════════════════════════════════════════════
  window.__wally_resolveSelector = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return 'element';

    // 1. data-testid (highest priority)
    const testId = el.closest?.('[data-testid]')?.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';

    // 2. aria-label
    const ariaLabel = el.getAttribute?.('aria-label');
    if (ariaLabel) return '[aria-label="' + ariaLabel + '"]';

    // 3. role + accessible name
    const role = el.getAttribute?.('role');
    if (role) {
      const text = (el.textContent || '').trim().substring(0, 30);
      if (text) return role + ' "' + text + '"';
    }

    // 4. id (if not auto-generated)
    if (el.id && !/^[0-9]/.test(el.id) && el.id.length < 50) {
      return '#' + el.id;
    }

    const tag = el.tagName?.toLowerCase();

    // 5. buttons with text
    if (tag === 'button') {
      const text = (el.textContent || '').trim().substring(0, 30);
      if (text) return 'button "' + text + '"';
    }

    // 6. links with text
    if (tag === 'a') {
      const text = (el.textContent || '').trim().substring(0, 30);
      if (text) return 'link "' + text + '"';
    }

    // 7. inputs with type/name/placeholder
    if (tag === 'input' || tag === 'textarea') {
      const type = el.type || 'text';
      if (el.name) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[name="' + el.name + '"]';
      if (el.placeholder) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[placeholder="' + el.placeholder + '"]';
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[aria-label="' + aria + '"]';
      return tag + (type !== 'text' ? '[type="' + type + '"]' : '');
    }

    // 8. select elements (dropdowns!)
    if (tag === 'select') {
      const name = el.name || el.id || el.getAttribute('aria-label') || '';
      return 'select' + (name ? '[name="' + name + '"]' : '');
    }

    // 9. Build path with nth-child
    const parts = [];
    let current = el;
    while (current && current !== document.documentElement && parts.length < 3) {
      const tagName = current.tagName?.toLowerCase();
      if (!tagName) break;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName?.toLowerCase() === tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
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
  };

  // ═══════════════════════════════════════════════════════════════
  // EVENT RECORDING — capture phase, all event types
  // ═══════════════════════════════════════════════════════════════

  // Track active element for input/keydown association
  var activeElement = null;

  // CLICK — primary click
  document.addEventListener('click', function(e) {
    var el = deepEventTarget(e);
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;

    // Fallback: if deepEventTarget gave html/body with huge text (e.g. "@font-face"), try elementFromPoint
    if ((el.tagName === 'HTML' || el.tagName === 'BODY') && (el.textContent || '').length > 200) {
      var fallback = document.elementFromPoint(e.clientX, e.clientY);
      if (fallback && fallback !== el) el = fallback;
    }
    // Also fallback if selector would be generic html/body
    if ((el.tagName === 'HTML' || el.tagName === 'BODY') && e.clientX != null) {
      var fp = document.elementFromPoint(e.clientX, e.clientY);
      if (fp && fp.nodeType === Node.ELEMENT_NODE) el = fp;
    }

    var tag = el.tagName?.toLowerCase();

    // Ignore native selects/options (handled by change) — but NOT Radix custom selects
    if (tag === 'select' || tag === 'option') return;

    // Checkbox/radio — record as check/uncheck
    if (el.type === 'checkbox' || el.type === 'radio') {
      window.__wally_actions.push({
        type: el.checked ? 'check' : 'uncheck',
        selector: window.__wally_resolveSelector(el),
      });
      return;
    }

    // File input
    if (el.type === 'file') {
      var files = Array.from(el.files || []).map(f => f.name);
      if (files.length) {
        window.__wally_actions.push({
          type: 'setInputFiles',
          selector: window.__wally_resolveSelector(el),
          files: files,
        });
      }
      return;
    }

    var selector = window.__wally_resolveSelector(el);
    // If selector still resolves to html/body, try closest clickable ancestor
    if (selector === 'html' || selector === 'body' || selector === 'html > body') {
      var clickable = el.closest?.('button, [role="button"], [role="option"], [role="menuitem"], [data-testid], [aria-label], a, [data-radix-collection-item]');
      if (clickable) {
        el = clickable;
        selector = window.__wally_resolveSelector(el);
      }
    }
    var text = (el.textContent || '').substring(0, 80).trim();
    // Skip if text is CSS garbage
    if (text.includes('@font-face') || text.includes('font-family:Barlow')) {
      text = (el.innerText || el.getAttribute('aria-label') || selector || '').substring(0, 80).trim();
    }
    window.__wally_actions.push({
      type: 'click',
      selector: selector,
      text: text,
      position: { x: e.clientX, y: e.clientY },
      button: e.button === 2 ? 'right' : 'left',
      modifiers: e.ctrlKey || e.altKey || e.metaKey || e.shiftKey,
      clickCount: e.detail,
    });
  }, true);

  // DOUBLE CLICK
  document.addEventListener('dblclick', function(e) {
    var el = deepEventTarget(e);
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    var selector = window.__wally_resolveSelector(el);
    window.__wally_actions.push({
      type: 'dblclick',
      selector: selector,
      text: (el.textContent || '').substring(0, 80).trim(),
      position: { x: e.clientX, y: e.clientY },
    });
  }, true);

  // CONTEXT MENU (right click)
  document.addEventListener('contextmenu', function(e) {
    var el = deepEventTarget(e);
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    var selector = window.__wally_resolveSelector(el);
    window.__wally_actions.push({
      type: 'click',
      selector: selector,
      text: (el.textContent || '').substring(0, 80).trim(),
      position: { x: e.clientX, y: e.clientY },
      button: 'right',
    });
  }, true);

  // INPUT — fills and text
  var RECORDABLE = new Set(['INPUT', 'TEXTAREA']);
  var currentFill = null;

  function commitFill() {
    if (currentFill && currentFill.value) {
      window.__wally_actions.push({
        type: 'fill',
        selector: currentFill.selector,
        value: currentFill.value,
      });
    }
    currentFill = null;
  }

  document.addEventListener('input', function(e) {
    var el = deepEventTarget(e);
    if (!el) return;

    // Select element (dropdown)
    if (el.tagName === 'SELECT') {
      var options = Array.from(el.selectedOptions || []).map(o => o.value || o.text);
      window.__wally_actions.push({
        type: 'select',
        selector: window.__wally_resolveSelector(el),
        options: options,
      });
      return;
    }

    if (!RECORDABLE.has(el.tagName)) return;

    // Ignore checkbox/radio
    if (el.type === 'checkbox' || el.type === 'radio') return;

    var selector = window.__wally_resolveSelector(el);
    var value = el.isContentEditable ? el.innerText : (el.value || '');
    if (!currentFill || currentFill.selector !== selector) {
      commitFill();
      currentFill = { selector: selector, value: '' };
    }
    currentFill.value = value;
  }, true);

  // CHANGE — select elements, checkboxes, file inputs
  document.addEventListener('change', function(e) {
    var el = deepEventTarget(e);
    if (!el) return;

    // Select element
    if (el.tagName === 'SELECT') {
      var options = Array.from(el.selectedOptions || []).map(o => o.value || o.text);
      window.__wally_actions.push({
        type: 'select',
        selector: window.__wally_resolveSelector(el),
        options: options,
      });
      return;
    }

    // Checkbox/radio
    if (el.type === 'checkbox' || el.type === 'radio') {
      // Already handled by click
      return;
    }

    // Other inputs
    if (RECORDABLE.has(el.tagName)) {
      var value = el.value || '';
      if (value) {
        window.__wally_actions.push({
          type: 'fill',
          selector: window.__wally_resolveSelector(el),
          value: value,
        });
      }
    }
  }, true);

  // FOCUS OUT — commit pending fill
  document.addEventListener('focusout', commitFill, true);

  // KEYBOARD — press events
  document.addEventListener('keydown', function(e) {
    // Ignore modifier-only keys
    if (['Shift', 'Control', 'Meta', 'Alt', 'Process', 'CapsLock'].includes(e.key)) return;
    // Ignore IME
    if (typeof e.key !== 'string' || e.key.length === 0) return;

    var el = deepEventTarget(e);
    if (!el) return;

    // Enter in textarea/newline — skip (will be handled by input)
    if (e.key === 'Enter' && (el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

    // Backspace/Delete/AltGraph — skip (handled by input)
    if (['Backspace', 'Delete', 'AltGraph'].includes(e.key)) return;

    // Skip paste shortcuts
    if ((e.metaKey || e.ctrlKey) && e.key === 'v') return;

    var selector = window.__wally_resolveSelector(el);
    var modifiers = [];
    if (e.ctrlKey) modifiers.push('Control');
    if (e.altKey) modifiers.push('Alt');
    if (e.metaKey) modifiers.push('Meta');
    if (e.shiftKey) modifiers.push('Shift');

    window.__wally_actions.push({
      type: 'press',
      selector: selector,
      key: e.key,
      modifiers: modifiers,
    });
  }, true);

  // FOCUS — track active element
  document.addEventListener('focus', function(e) {
    var el = deepEventTarget(e);
    if (el && el.nodeType === Node.ELEMENT_NODE) {
      activeElement = el;
    }
  }, true);

  // SCROLL — record scroll events (useful for lazy-loaded content)
  var scrollTimeout = null;
  document.addEventListener('scroll', function(e) {
    var el = e.target;
    if (el === document || el === document.documentElement) {
      el = document.body;
    }
    if (scrollTimeout) return;
    scrollTimeout = setTimeout(function() {
      scrollTimeout = null;
      var selector = window.__wally_resolveSelector(el);
      window.__wally_actions.push({
        type: 'scroll',
        selector: selector,
        scrollTop: el.scrollTop || 0,
        scrollLeft: el.scrollLeft || 0,
      });
    }, 500);
  }, true);

  // ═══════════════════════════════════════════════════════════════
  // DOM POLLING — for extension pages where CDP events don't fire
  // Tracks state changes via fingerprint diffing
  // ═══════════════════════════════════════════════════════════════
  if (!window.__wally_polling_started) {
    window.__wally_polling_started = true;
    var _lastFingerprint = '';
    var _lastUrl = '';

    function _getFingerprint() {
      var parts = [location.href];
      // Visible buttons + Radix/HeadlessUI dropdown triggers & options
      var btns = document.querySelectorAll(
        'button, [role="button"], a[role="button"], [role="option"], [role="menuitem"], [role="combobox"], [data-radix-collection-item], [data-state]'
      );
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var rect = b.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          var t = (b.textContent || b.getAttribute('aria-label') || '').trim().substring(0, 40);
          // Skip CSS garbage
          if (t && t.indexOf('@font-face') === -1 && t.indexOf('font-family') === -1) {
            var role = b.getAttribute('role') || (b.tagName.toLowerCase() === 'button' ? 'btn' : 'item');
            parts.push(role + ':' + t);
          }
        }
      }
      // Also capture select triggers (custom dropdowns often use div with data-state)
      var selects = document.querySelectorAll('[data-radix-select-viewport], [data-radix-popper-content-wrapper], [role="listbox"]');
      for (var s = 0; s < selects.length; s++) {
        var sel = selects[s];
        var sr = sel.getBoundingClientRect();
        if (sr.width > 0 && sr.height > 0) {
          var children = sel.querySelectorAll('[role="option"], [data-radix-collection-item]');
          for (var c = 0; c < children.length; c++) {
            var ch = children[c];
            var cr = ch.getBoundingClientRect();
            if (cr.width > 0 && cr.height > 0) {
              var ct = (ch.textContent || '').trim().substring(0, 40);
              if (ct) parts.push('opt:' + ct);
            }
          }
          if (children.length === 0) {
            var st = (sel.textContent || '').trim().substring(0, 40);
            if (st) parts.push('list:' + st);
          }
        }
      }
      // Input values
      var inputs = document.querySelectorAll('input, textarea');
      for (var j = 0; j < inputs.length; j++) {
        var inp = inputs[j];
        var r = inp.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          parts.push('inp:' + (inp.type || 'text') + '=' + (inp.value || '').substring(0, 30));
        }
      }
      // Headings / main text
      var headings = document.querySelectorAll('h1, h2, h3, [role="heading"]');
      for (var k = 0; k < headings.length; k++) {
        var h = headings[k];
        var hr = h.getBoundingClientRect();
        if (hr.width > 0 && hr.height > 0) {
          var ht = (h.textContent || '').trim().substring(0, 40);
          if (ht.indexOf('@font-face') === -1) parts.push('h:' + ht);
        }
      }
      return parts.join('|');
    }

    setInterval(function() {
      try {
        var fp = _getFingerprint();
        var url = location.href;
        if (fp === _lastFingerprint && url === _lastUrl) return;

        var prev = _lastFingerprint;
        var prevUrl = _lastUrl;
        _lastFingerprint = fp;
        _lastUrl = url;

        // URL changed → navigation
        if (url !== prevUrl) {
          window.__wally_actions.push({ type: 'navigate', url: url });
          return;
        }

        // Diff: find new interactive elements that appeared (buttons, options, menuitems, etc.)
        function isClickable(p) {
          return p.startsWith('btn:') || p.startsWith('option:') || p.startsWith('menuitem:') || p.startsWith('combobox:') || p.startsWith('opt:') || p.startsWith('list:') || p.startsWith('item:');
        }
        var prevBtns = prev.split('|').filter(isClickable);
        var currBtns = fp.split('|').filter(isClickable);
        var prevSet = {};
        prevBtns.forEach(function(b) { prevSet[b] = true; });
        currBtns.forEach(function(b) {
          if (!prevSet[b]) {
            var colonIdx = b.indexOf(':');
            var text = b.substring(colonIdx + 1);
            var role = b.substring(0, colonIdx);
            var selector = role === 'btn' ? 'button "' + text + '"' : role + ' "' + text + '"';
            window.__wally_actions.push({ type: 'click_detected', selector: selector, text: text });
          }
        });

        // Diff: find removed interactive elements (user clicked them)
        var currSet = {};
        currBtns.forEach(function(b) { currSet[b] = true; });
        prevBtns.forEach(function(b) {
          if (!currSet[b]) {
            var colonIdx = b.indexOf(':');
            var text = b.substring(colonIdx + 1);
            var role = b.substring(0, colonIdx);
            var selector = role === 'btn' ? 'button "' + text + '"' : role + ' "' + text + '"';
            window.__wally_actions.push({ type: 'click_detected', selector: selector, text: text });
          }
        });

        // Diff: find new headings (new page content)
        var prevH = prev.split('|').filter(function(p) { return p.startsWith('h:'); });
        var currH = fp.split('|').filter(function(p) { return p.startsWith('h:'); });
        var prevHSet = {};
        prevH.forEach(function(h) { prevHSet[h] = true; });
        currH.forEach(function(h) {
          if (!prevHSet[h]) {
            var text = h.substring(2);
            window.__wally_actions.push({ type: 'page_change', heading: text });
          }
        });
      } catch(e) {}
    }, 500);
  }

  // ═══════════════════════════════════════════════════════════════
  // WALLET DETECTION — generic (EVM/Starknet/Solana)
  // ═══════════════════════════════════════════════════════════════
  if (!window.__wally_wallet_observed) {
    window.__wally_wallet_observed = true;

    function getWalletInfo() {
      if (window.ethereum) {
        var addr = window.ethereum.selectedAddress || (window.ethereum.accounts && window.ethereum.accounts[0]);
        if (addr) return { provider: 'evm', account: addr, type: 'ethereum' };
      }
      if (window.starknet) {
        var addr2 = window.starknet.selectedAddress || (window.starknet.account && window.starknet.account.address);
        if (addr2) return { provider: 'starknet', account: addr2, type: 'starknet' };
      }
      if (window.solana && window.solana.isConnected) {
        var addr3 = window.solana.publicKey && window.solana.publicKey.toString();
        if (addr3) return { provider: 'solana', account: addr3, type: 'solana' };
      }
      return null;
    }

    var lastWallet = null;
    setInterval(function() {
      var current = getWalletInfo();
      if (current && (!lastWallet || current.account !== lastWallet.account)) {
        window.__wally_actions.push({
          type: 'wallet_connect',
          account: current.account,
          walletType: current.type,
          provider: current.provider,
        });
        lastWallet = current;
      }
    }, 1000);
  }
})();
`;

/**
 * Script to inject into NEW pages before they load (for daemon mode).
 * Uses Page.addScriptToEvaluateOnNewDocument.
 */
const PRE_NAVIGATE_SCRIPT = `
(function() {
  if (window.__wally_recording_injected) return;
  window.__wally_recording_injected = true;
  window.__wally_actions = [];

  window.__wally_resolveSelector = function(el) {
    if (!el) return 'element';
    if (el.closest && el.closest('[data-testid]')) {
      return '[data-testid="' + el.closest('[data-testid]").dataset.testid + '"]';
    }
    if (el.id) return '#' + el.id;
    if (el.getAttribute && el.getAttribute('aria-label')) {
      return '[aria-label="' + el.getAttribute('aria-label') + '"]';
    }
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'button') {
      var text = (el.textContent || '').trim().substring(0, 30);
      if (text) return 'button "' + text + '"';
    }
    if (tag === 'input' || tag === 'textarea') {
      var type = el.type || 'text';
      if (el.name) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[name="' + el.name + '"]';
      if (el.placeholder) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[placeholder="' + el.placeholder + '"]';
      var aria2 = el.getAttribute && el.getAttribute('aria-label');
      if (aria2) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[aria-label="' + aria2 + '"]';
      return tag + (type !== 'text' ? '[type="' + type + '"]' : '');
    }
    return tag || 'element';
  };

  document.addEventListener('click', function(e) {
    var el = e.target;
    var selector = window.__wally_resolveSelector(el);
    window.__wally_actions.push({
      type: 'click',
      selector: selector,
      text: (el.textContent || '').substring(0, 50).trim(),
    });
  }, true);

  var FORM_SELECTOR = 'input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="url"], input[type="tel"], input:not([type]), textarea, [role="textbox"], [role="spinbutton"]';
  var RECORDABLE = new Set(['INPUT', 'TEXTAREA']);

  function commitFill() {
    if (window.__wally_currentFill && window.__wally_currentFill.value) {
      window.__wally_actions.push({
        type: 'fill',
        selector: window.__wally_currentFill.selector,
        value: window.__wally_currentFill.value,
      });
    }
    window.__wally_currentFill = null;
  }

  document.addEventListener('input', function(e) {
    var el = e.target;
    if (!RECORDABLE.has(el.tagName)) return;
    var selector = window.__wally_resolveSelector(el);
    var value = el.value || '';
    if (!window.__wally_currentFill || window.__wally_currentFill.selector !== selector) {
      commitFill();
      window.__wally_currentFill = { selector: selector, value: '' };
    }
    window.__wally_currentFill.value = value;
  }, true);

  document.addEventListener('change', function(e) {
    var el = e.target;
    if (!RECORDABLE.has(el.tagName)) return;
    var selector = window.__wally_resolveSelector(el);
    var value = el.value || '';
    if (value) {
      window.__wally_actions.push({ type: 'fill', selector: selector, value: value });
    }
  }, true);

  document.addEventListener('focusout', commitFill, true);
  document.addEventListener('click', commitFill, true);

  if (!window.__wally_wallet_observed) {
    window.__wally_wallet_observed = true;

    function getWalletInfo() {
      if (window.ethereum) {
        var addr = window.ethereum.selectedAddress || (window.ethereum.accounts && window.ethereum.accounts[0]);
        if (addr) return { provider: 'evm', account: addr, type: 'ethereum' };
      }
      if (window.starknet) {
        var addr2 = window.starknet.selectedAddress || (window.starknet.account && window.starknet.account.address);
        if (addr2) return { provider: 'starknet', account: addr2, type: 'starknet' };
      }
      if (window.solana && window.solana.isConnected) {
        var addr3 = window.solana.publicKey && window.solana.publicKey.toString();
        if (addr3) return { provider: 'solana', account: addr3, type: 'solana' };
      }
      return null;
    }

    var lastWallet = null;
    setInterval(function() {
      var current = getWalletInfo();
      if (current && (!lastWallet || current.account !== lastWallet.account)) {
        window.__wally_actions.push({
          type: 'wallet_connect',
          account: current.account,
          walletType: current.type,
          provider: current.provider,
        });
        lastWallet = current;
      }
    }, 1000);
  }
})();
`;

/**
 * Inject recording listeners into a Playwright page.
 */
async function injectRecordingListeners(page) {
  try {
    await page.evaluate(RECORDING_SCRIPT);
  } catch (e) {
    // Page might be navigating or crashed
  }
}

/**
 * Read and clear recorded actions from a page.
 * Returns array of action objects.
 */
async function readActions(page) {
  try {
    return await page.evaluate(() => {
      const a = window.__wally_actions || [];
      window.__wally_actions = [];
      return a;
    });
  } catch {
    return [];
  }
}

/**
 * Check if a URL is an extension popup (chrome-extension://).
 */
function isExtensionUrl(url) {
  return url && url.startsWith('chrome-extension://');
}

/**
 * Get a human-readable label for a page based on its URL.
 */
function getPageLabel(url) {
  if (!url) return 'unknown';
  if (isExtensionUrl(url)) {
    const match = url.match(/chrome-extension:\/\/([a-z]+)/);
    const extId = match ? match[1].substring(0, 8) : 'unknown';
    return `ext:${extId}`;
  }
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return 'page';
  }
}

module.exports = {
  RECORDING_SCRIPT,
  PRE_NAVIGATE_SCRIPT,
  injectRecordingListeners,
  readActions,
  isExtensionUrl,
  getPageLabel,
};
