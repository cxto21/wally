/**
 * Wally Recorder — reusable recording module
 *
 * Injects click/fill/wallet listeners into any page via CDP.
 * Used by both `record start` and `daemon start`.
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

  // Selector resolution
  window.__wally_resolveSelector = (el) => {
    if (!el) return 'element';
    if (el.closest?.('[data-testid]')) {
      return '[data-testid="' + el.closest('[data-testid]').dataset.testid + '"]';
    }
    if (el.id) return '#' + el.id;
    if (el.getAttribute?.('aria-label')) {
      return '[aria-label="' + el.getAttribute('aria-label') + '"]';
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
      const name = el.name || el.placeholder || '';
      return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + (name ? '[name="' + name + '"]' : '');
    }
    return tag || 'element';
  };

  // Click recording
  document.addEventListener('click', (e) => {
    const el = e.target;
    const selector = window.__wally_resolveSelector(el);
    window.__wally_actions.push({
      type: 'click',
      selector: selector,
      text: (el.textContent || '').substring(0, 50).trim(),
    });
  }, true);

  // Fill recording via input/change events
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

  // Wallet connect detection — works with any wallet (EVM, Starknet, Solana, etc.)
  if (!window.__wally_wallet_observed) {
    window.__wally_wallet_observed = true;

    // Detect wallet providers
    function getWalletInfo() {
      // EVM wallets (MetaMask, Rabby, etc.)
      if (window.ethereum) {
        var addr = window.ethereum.selectedAddress || (window.ethereum.accounts && window.ethereum.accounts[0]);
        if (addr) return { provider: 'evm', account: addr, type: 'ethereum' };
      }
      // Starknet wallets (Argent, Braavos, Ready, etc.)
      if (window.starknet) {
        var addr2 = window.starknet.selectedAddress || (window.starknet.account && window.starknet.account.address);
        if (addr2) return { provider: 'starknet', account: addr2, type: 'starknet' };
      }
      // Solana wallets (Phantom, etc.)
      if (window.solana && window.solana.isConnected) {
        var addr3 = window.solana.publicKey && window.solana.publicKey.toString();
        if (addr3) return { provider: 'solana', account: addr3, type: 'solana' };
      }
      // Generic EIP-6963 / WalletConnect
      if (window.__wagmi && window.__wagmi.connected) {
        return { provider: 'wagmi', account: 'connected', type: 'evm' };
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
      }
      lastWallet = current;
    }, 1000);

    // Patch enable/connect methods if available
    ['starknet', 'ethereum', 'solana'].forEach(function(key) {
      if (window[key] && typeof window[key].enable === 'function') {
        var orig = window[key].enable.bind(window[key]);
        window[key].enable = function() {
          return orig.apply(null, arguments).then(function(result) {
            setTimeout(function() {
              var info = getWalletInfo();
              if (info && (!lastWallet || info.account !== lastWallet.account)) {
                window.__wally_actions.push({
                  type: 'wallet_connect',
                  account: info.account,
                  walletType: info.type,
                  provider: info.provider,
                });
                lastWallet = info;
              }
            }, 500);
            return result;
          });
        };
      }
      if (window[key] && typeof window[key].connect === 'function' && key !== 'starknet') {
        var origConnect = window[key].connect.bind(window[key]);
        window[key].connect = function() {
          return origConnect.apply(null, arguments).then(function(result) {
            setTimeout(function() {
              var info = getWalletInfo();
              if (info && (!lastWallet || info.account !== lastWallet.account)) {
                window.__wally_actions.push({
                  type: 'wallet_connect',
                  account: info.account,
                  walletType: info.type,
                  provider: info.provider,
                });
                lastWallet = info;
              }
            }, 500);
            return result;
          });
        };
      }
    });
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
      var name = el.name || el.placeholder || '';
      return tag + (type !== 'text' ? '[type="' + type + '"]' : '') + (name ? '[name="' + name + '"]' : '');
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
