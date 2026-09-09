/**
 * Wally Extension — Constants
 *
 * Message types, action types, and the RECORDING_SCRIPT IIFE that gets
 * injected into pages (normal via content script, extension popups via debugger).
 */

// Content script → Service worker
export const MSG_CS_READY = 'cs_ready';
export const MSG_CS_STEP = 'cs_step';
export const MSG_CS_READ_ACTIONS = 'cs_read_actions';
export const MSG_CS_PING = 'cs_ping';
export const MSG_CS_READ_PAGE = 'cs_read_page';

// Recording control
export const MSG_CS_RECORDING_START = 'cs_recording_start';
export const MSG_CS_RECORDING_STOP = 'cs_recording_stop';

// Service worker → Content script
export const MSG_SW_START_RECORDING = 'sw_start_recording';
export const MSG_SW_STOP_RECORDING = 'sw_stop_recording';

// Internal action types
export const ACTION_CLICK = 'click';
export const ACTION_DBLCLICK = 'dblclick';
export const ACTION_FILL = 'fill';
export const ACTION_SELECT = 'select';
export const ACTION_PRESS = 'press';
export const ACTION_SCROLL = 'scroll';
export const ACTION_CHECK = 'check';
export const ACTION_UNCHECK = 'uncheck';
export const ACTION_NAVIGATE = 'navigate';
export const ACTION_FOCUS = 'focus';
export const ACTION_SET_INPUT_FILES = 'setInputFiles';
export const ACTION_CONTEXTMENU = 'contextmenu';
export const ACTION_CLICK_DETECTED = 'click_detected';
export const ACTION_PAGE_CHANGE = 'page_change';
export const ACTION_EXTENSION_CONNECT = 'extension_connect';

// ═══════════════════════════════════════════════════════════════════
// RECORDING_SCRIPT — self-contained IIFE injected into page contexts
//
// Ported from lib/recording-script.js. Stores captured actions in
// window.__wally_actions. Dispatches CustomEvent('__wally_action')
// so the content script (isolated world) can relay them to the SW.
//
// For extension popup pages the SW reads actions via CDP poll.
// ═══════════════════════════════════════════════════════════════════

export const RECORDING_SCRIPT = `
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
    while (target.shadowRoot) {
      const inner = target.shadowRoot.elementFromPoint?.(event.clientX, event.clientY);
      if (inner) target = inner;
      else break;
    }
    return target;
  }

  // ═══════════════════════════════════════════════════════════════
  // SELECTOR RESOLUTION — smart selectors (Wally priority order)
  // ═══════════════════════════════════════════════════════════════
  window.__wally_resolveSelector = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return 'element';

    const testId = el.closest?.('[data-testid]')?.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';

    const ariaLabel = el.getAttribute?.('aria-label');
    if (ariaLabel) return '[aria-label="' + ariaLabel + '"]';

    const role = el.getAttribute?.('role');
    if (role) {
      const text = (el.textContent || '').trim().substring(0, 30);
      if (text) return role + ' "' + text + '"';
    }

    if (el.id && !/^[0-9]/.test(el.id) && el.id.length < 50) {
      return '#' + el.id;
    }

    const tag = el.tagName?.toLowerCase();

    if (tag === 'button') {
      const text = (el.textContent || '').trim().substring(0, 30);
      if (text) return 'button "' + text + '"';
    }

    if (tag === 'a') {
      const text = (el.textContent || '').trim().substring(0, 30);
      if (text) return 'link "' + text + '"';
    }

    if (tag === 'input' || tag === 'textarea') {
      const type = el.type || 'text';
      if (el.name) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[name="' + el.name + '"]';
      if (el.placeholder) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[placeholder="' + el.placeholder + '"]';
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[aria-label="' + aria + '"]';
      return tag + (type !== 'text' ? '[type="' + type + '"]' : '');
    }

    if (tag === 'select') {
      const name = el.name || el.id || el.getAttribute('aria-label') || '';
      return 'select' + (name ? '[name="' + name + '"]' : '');
    }

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

  var RECORDABLE = new Set(['INPUT', 'TEXTAREA']);
  var currentFill = null;
  var activeElement = null;
  var scrollTimeout = null;

  function _push(action) {
    window.__wally_actions.push(action);
    try {
      window.dispatchEvent(new CustomEvent('__wally_action', { detail: action }));
    } catch {}
  }

  function commitFill() {
    if (currentFill && currentFill.value) {
      _push({ type: 'fill', selector: currentFill.selector, value: currentFill.value });
    }
    currentFill = null;
  }

  // CLICK — primary click
  document.addEventListener('click', function(e) {
    var el = deepEventTarget(e);
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;

    if ((el.tagName === 'HTML' || el.tagName === 'BODY') && (el.textContent || '').length > 200) {
      var fallback = document.elementFromPoint(e.clientX, e.clientY);
      if (fallback && fallback !== el) el = fallback;
    }
    if ((el.tagName === 'HTML' || el.tagName === 'BODY') && e.clientX != null) {
      var fp = document.elementFromPoint(e.clientX, e.clientY);
      if (fp && fp.nodeType === Node.ELEMENT_NODE) el = fp;
    }

    var tag = el.tagName?.toLowerCase();

    if (tag === 'select' || tag === 'option') return;

    if (el.type === 'checkbox' || el.type === 'radio') {
      _push({
        type: el.checked ? 'check' : 'uncheck',
        selector: window.__wally_resolveSelector(el),
      });
      return;
    }

    if (el.type === 'file') {
      var files = Array.from(el.files || []).map(f => f.name);
      if (files.length) {
        _push({ type: 'setInputFiles', selector: window.__wally_resolveSelector(el), files: files });
      }
      return;
    }

    var selector = window.__wally_resolveSelector(el);
    if (selector === 'html' || selector === 'body' || selector === 'html > body') {
      var clickable = el.closest?.('button, [role="button"], [role="option"], [role="menuitem"], [data-testid], [aria-label], a, [data-radix-collection-item]');
      if (clickable) {
        el = clickable;
        selector = window.__wally_resolveSelector(el);
      }
    }
    var text = (el.textContent || '').substring(0, 80).trim();
    if (text.includes('@font-face') || text.includes('font-family:Barlow')) {
      text = (el.innerText || el.getAttribute('aria-label') || selector || '').substring(0, 80).trim();
    }
    _push({
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
    _push({
      type: 'dblclick',
      selector: window.__wally_resolveSelector(el),
      text: (el.textContent || '').substring(0, 80).trim(),
      position: { x: e.clientX, y: e.clientY },
    });
  }, true);

  // CONTEXT MENU (right click)
  document.addEventListener('contextmenu', function(e) {
    var el = deepEventTarget(e);
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    _push({
      type: 'click',
      selector: window.__wally_resolveSelector(el),
      text: (el.textContent || '').substring(0, 80).trim(),
      position: { x: e.clientX, y: e.clientY },
      button: 'right',
    });
  }, true);

  // INPUT — fills and text
  document.addEventListener('input', function(e) {
    var el = deepEventTarget(e);
    if (!el) return;

    if (el.tagName === 'SELECT') {
      var options = Array.from(el.selectedOptions || []).map(o => o.value || o.text);
      _push({ type: 'select', selector: window.__wally_resolveSelector(el), options: options });
      return;
    }

    if (!RECORDABLE.has(el.tagName)) return;
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

    if (el.tagName === 'SELECT') {
      var options = Array.from(el.selectedOptions || []).map(o => o.value || o.text);
      _push({ type: 'select', selector: window.__wally_resolveSelector(el), options: options });
      return;
    }

    if (el.type === 'checkbox' || el.type === 'radio') return;

    if (RECORDABLE.has(el.tagName)) {
      var value = el.value || '';
      if (value) {
        _push({ type: 'fill', selector: window.__wally_resolveSelector(el), value: value });
      }
    }
  }, true);

  // FOCUS OUT — commit pending fill
  document.addEventListener('focusout', commitFill, true);

  // KEYBOARD — press events
  document.addEventListener('keydown', function(e) {
    if (['Shift', 'Control', 'Meta', 'Alt', 'Process', 'CapsLock'].includes(e.key)) return;
    if (typeof e.key !== 'string' || e.key.length === 0) return;

    var el = deepEventTarget(e);
    if (!el) return;

    if (e.key === 'Enter' && (el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (['Backspace', 'Delete', 'AltGraph'].includes(e.key)) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'v') return;

    var modifiers = [];
    if (e.ctrlKey) modifiers.push('Control');
    if (e.altKey) modifiers.push('Alt');
    if (e.metaKey) modifiers.push('Meta');
    if (e.shiftKey) modifiers.push('Shift');

    _push({
      type: 'press',
      selector: window.__wally_resolveSelector(el),
      key: e.key,
      modifiers: modifiers,
    });
  }, true);

  // FOCUS — track active element
  document.addEventListener('focus', function(e) {
    var el = deepEventTarget(e);
    if (el && el.nodeType === Node.ELEMENT_NODE) activeElement = el;
  }, true);

  // SCROLL — debounced
  document.addEventListener('scroll', function(e) {
    var el = e.target;
    if (el === document || el === document.documentElement) el = document.body;
    if (scrollTimeout) return;
    scrollTimeout = setTimeout(function() {
      scrollTimeout = null;
      _push({
        type: 'scroll',
        selector: window.__wally_resolveSelector(el),
        scrollTop: el.scrollTop || 0,
        scrollLeft: el.scrollLeft || 0,
      });
    }, 500);
  }, true);

  // ═══════════════════════════════════════════════════════════════
  // DOM POLLING — fingerprint diff for extension pages
  // ═══════════════════════════════════════════════════════════════
  if (!window.__wally_polling_started) {
    window.__wally_polling_started = true;
    var _lastFingerprint = '';
    var _lastUrl = '';

    function _getFingerprint() {
      var parts = [location.href];
      var btns = document.querySelectorAll(
        'button, [role="button"], a[role="button"], [role="option"], [role="menuitem"], [role="combobox"], [data-radix-collection-item], [data-state]'
      );
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var rect = b.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          var t = (b.textContent || b.getAttribute('aria-label') || '').trim().substring(0, 40);
          if (t && t.indexOf('@font-face') === -1 && t.indexOf('font-family') === -1) {
            var role = b.getAttribute('role') || (b.tagName.toLowerCase() === 'button' ? 'btn' : 'item');
            parts.push(role + ':' + t);
          }
        }
      }
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
      var inputs = document.querySelectorAll('input, textarea');
      for (var j = 0; j < inputs.length; j++) {
        var inp = inputs[j];
        var r = inp.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          parts.push('inp:' + (inp.type || 'text') + '=' + (inp.value || '').substring(0, 30));
        }
      }
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
        if (url !== prevUrl) {
          _push({ type: 'navigate', url: url });
          return;
        }
        function isClickable(p) {
          return p.startsWith('btn:') || p.startsWith('option:') || p.startsWith('menuitem:') || p.startsWith('combobox:') || p.startsWith('opt:') || p.startsWith('list:') || p.startsWith('item:');
        }
        var prevBtns = prev.split('|').filter(isClickable);
        var currBtns = fp.split('|').filter(isClickable);
        var prevSet = {};
        prevBtns.forEach(function(b) { prevSet[b] = true; });
        currBtns.forEach(function(b) {
          if (!prevSet[b]) {
            var ci = b.indexOf(':');
            var text = b.substring(ci + 1);
            var role = b.substring(0, ci);
            _push({ type: 'click_detected', selector: (role === 'btn' ? 'button' : role) + ' "' + text + '"', text: text });
          }
        });
        var currSet = {};
        currBtns.forEach(function(b) { currSet[b] = true; });
        prevBtns.forEach(function(b) {
          if (!currSet[b]) {
            var ci2 = b.indexOf(':');
            var text2 = b.substring(ci2 + 1);
            var role2 = b.substring(0, ci2);
            _push({ type: 'click_detected', selector: (role2 === 'btn' ? 'button' : role2) + ' "' + text2 + '"', text: text2 });
          }
        });
        var prevH = prev.split('|').filter(function(p) { return p.startsWith('h:'); });
        var currH = fp.split('|').filter(function(p) { return p.startsWith('h:'); });
        var prevHSet = {};
        prevH.forEach(function(h) { prevHSet[h] = true; });
        currH.forEach(function(h) {
          if (!prevHSet[h]) _push({ type: 'page_change', heading: h.substring(2) });
        });
      } catch(e) {}
    }, 500);
  }

  // ═══════════════════════════════════════════════════════════════
  // WALLET PROVIDER DETECTION — generic (EVM/Starknet/Solana)
  // ═══════════════════════════════════════════════════════════════
  if (!window.__wally_ext_observed) {
    window.__wally_ext_observed = true;
    function getExtensionInfo() {
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
    var lastExtension = null;
    setInterval(function() {
      var current = getExtensionInfo();
      if (current && (!lastExtension || current.account !== lastExtension.account)) {
        _push({
          type: 'extension_connect',
          flow: window.__wally_lastExtFlow || 'web',
          network: window.__wally_lastExtNetwork || '',
          account: current.account,
          extensionType: current.type,
          provider: current.provider,
        });
        lastExtension = current;
      }
    }, 1000);
  }
})();
`;
