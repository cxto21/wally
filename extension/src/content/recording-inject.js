/**
 * Wally Recording Script — injected into page's MAIN world
 *
 * Self-contained IIFE. Captures DOM events and stores actions in
 * window.__wally_actions. Dispatches CustomEvent('__wally_action')
 * so the content script (isolated world) can relay them to the SW.
 *
 * Ported from lib/recording-script.js.
 */
(function() {
  if (window.__wally_recording_injected) return;
  window.__wally_recording_injected = true;
  window.__wally_actions = [];

  function deepEventTarget(event) {
    var target = event.composedPath ? event.composedPath()[0] : event.target;
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return target;
    while (target.shadowRoot) {
      var inner = target.shadowRoot.elementFromPoint ? target.shadowRoot.elementFromPoint(event.clientX, event.clientY) : null;
      if (inner) target = inner;
      else break;
    }
    return target;
  }

  window.__wally_resolveSelector = function(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return 'element';

    var testId = el.closest ? el.closest('[data-testid]') : null;
    if (testId) {
      var tid = testId.getAttribute('data-testid');
      if (tid) return '[data-testid="' + tid + '"]';
    }

    var ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
    if (ariaLabel) return '[aria-label="' + ariaLabel + '"]';

    var role = el.getAttribute ? el.getAttribute('role') : null;
    if (role) {
      var text = (el.textContent || '').trim().substring(0, 30);
      if (text) return role + ' "' + text + '"';
    }

    if (el.id && !/^[0-9]/.test(el.id) && el.id.length < 50) {
      return '#' + el.id;
    }

    var tag = el.tagName ? el.tagName.toLowerCase() : '';

    if (tag === 'button') {
      var btext = (el.textContent || '').trim().substring(0, 30);
      if (btext) return 'button "' + btext + '"';
    }

    if (tag === 'a') {
      var atext = (el.textContent || '').trim().substring(0, 30);
      if (atext) return 'link "' + atext + '"';
    }

    if (tag === 'input' || tag === 'textarea') {
      var type = el.type || 'text';
      if (el.name) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[name="' + el.name + '"]';
      if (el.placeholder) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[placeholder="' + el.placeholder + '"]';
      var iaria = el.getAttribute ? el.getAttribute('aria-label') : null;
      if (iaria) return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + '[aria-label="' + iaria + '"]';
      return tag + (type !== 'text' ? '[type="' + type + '"]' : '');
    }

    if (tag === 'select') {
      var name = el.name || el.id || (el.getAttribute ? el.getAttribute('aria-label') : '') || '';
      return 'select' + (name ? '[name="' + name + '"]' : '');
    }

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
  };

  var RECORDABLE = { INPUT: true, TEXTAREA: true };
  var currentFill = null;
  var activeElement = null;
  var scrollTimeout = null;

  function _push(action) {
    window.__wally_actions.push(action);
    try {
      window.dispatchEvent(new CustomEvent('__wally_action', { detail: action }));
    } catch (e) {}
  }

  function commitFill() {
    if (currentFill && currentFill.value) {
      _push({ type: 'fill', selector: currentFill.selector, value: currentFill.value });
    }
    currentFill = null;
  }

  // CLICK
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

    var tag = el.tagName ? el.tagName.toLowerCase() : '';

    if (tag === 'select' || tag === 'option') return;

    if (el.type === 'checkbox' || el.type === 'radio') {
      _push({
        type: el.checked ? 'check' : 'uncheck',
        selector: window.__wally_resolveSelector(el),
      });
      return;
    }

    if (el.type === 'file') {
      var files = Array.prototype.slice.call(el.files || []).map(function(f) { return f.name; });
      if (files.length) {
        _push({ type: 'setInputFiles', selector: window.__wally_resolveSelector(el), files: files });
      }
      return;
    }

    var selector = window.__wally_resolveSelector(el);
    if (selector === 'html' || selector === 'body' || selector === 'html > body') {
      var clickable = el.closest ? el.closest('button, [role="button"], [role="option"], [role="menuitem"], [data-testid], [aria-label], a, [data-radix-collection-item]') : null;
      if (clickable) {
        el = clickable;
        selector = window.__wally_resolveSelector(el);
      }
    }
    var ctxt = (el.textContent || '').substring(0, 80).trim();
    if (ctxt.indexOf('@font-face') !== -1 || ctxt.indexOf('font-family') !== -1) {
      ctxt = (el.innerText || el.getAttribute('aria-label') || selector || '').substring(0, 80).trim();
    }
    _push({
      type: 'click',
      selector: selector,
      text: ctxt,
      position: { x: e.clientX, y: e.clientY },
      button: e.button === 2 ? 'right' : 'left',
      modifiers: !!(e.ctrlKey || e.altKey || e.metaKey || e.shiftKey),
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

  // CONTEXT MENU
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

  // INPUT
  document.addEventListener('input', function(e) {
    var el = deepEventTarget(e);
    if (!el) return;

    if (el.tagName === 'SELECT') {
      var options = Array.prototype.slice.call(el.selectedOptions || []).map(function(o) { return o.value || o.text; });
      _push({ type: 'select', selector: window.__wally_resolveSelector(el), options: options });
      return;
    }

    if (!RECORDABLE[el.tagName]) return;
    if (el.type === 'checkbox' || el.type === 'radio') return;

    var selector = window.__wally_resolveSelector(el);
    var value = el.isContentEditable ? el.innerText : (el.value || '');
    if (!currentFill || currentFill.selector !== selector) {
      commitFill();
      currentFill = { selector: selector, value: '' };
    }
    currentFill.value = value;
  }, true);

  // CHANGE
  document.addEventListener('change', function(e) {
    var el = deepEventTarget(e);
    if (!el) return;

    if (el.tagName === 'SELECT') {
      var options = Array.prototype.slice.call(el.selectedOptions || []).map(function(o) { return o.value || o.text; });
      _push({ type: 'select', selector: window.__wally_resolveSelector(el), options: options });
      return;
    }

    if (el.type === 'checkbox' || el.type === 'radio') return;

    if (RECORDABLE[el.tagName]) {
      var value = el.value || '';
      if (value) {
        _push({ type: 'fill', selector: window.__wally_resolveSelector(el), value: value });
      }
    }
  }, true);

  // FOCUS OUT
  document.addEventListener('focusout', commitFill, true);

  // KEYBOARD
  document.addEventListener('keydown', function(e) {
    if (['Shift', 'Control', 'Meta', 'Alt', 'Process', 'CapsLock'].indexOf(e.key) !== -1) return;
    if (typeof e.key !== 'string' || e.key.length === 0) return;

    var el = deepEventTarget(e);
    if (!el) return;

    if (e.key === 'Enter' && (el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (['Backspace', 'Delete', 'AltGraph'].indexOf(e.key) !== -1) return;
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

  // FOCUS
  document.addEventListener('focus', function(e) {
    var el = deepEventTarget(e);
    if (el && el.nodeType === Node.ELEMENT_NODE) activeElement = el;
  }, true);

  // SCROLL
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

  // DOM POLLING
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
          return p.indexOf('btn:') === 0 || p.indexOf('option:') === 0 || p.indexOf('menuitem:') === 0 || p.indexOf('combobox:') === 0 || p.indexOf('opt:') === 0 || p.indexOf('list:') === 0 || p.indexOf('item:') === 0;
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
        var prevH = prev.split('|').filter(function(p) { return p.indexOf('h:') === 0; });
        var currH = fp.split('|').filter(function(p) { return p.indexOf('h:') === 0; });
        var prevHSet = {};
        prevH.forEach(function(h) { prevHSet[h] = true; });
        currH.forEach(function(h) {
          if (!prevHSet[h]) _push({ type: 'page_change', heading: h.substring(2) });
        });
      } catch(e) {}
    }, 500);
  }

  // WALLET PROVIDER DETECTION
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
