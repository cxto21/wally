/**
 * Wally Extension — Content Script (plain script, no ES modules)
 *
 * Injects recording-inject.js into the page's main world,
 * listens for captured actions via CustomEvents, and relays them
 * to the service worker. Also handles SW→CS recording control.
 */

(function() {
  "use strict";

  var recording = false;
  var injected = false;

  // Message constants (inlined — content scripts can't use import)
  var MSG_CS_RECORDING_START = 'cs_recording_start';
  var MSG_CS_RECORDING_STOP = 'cs_recording_stop';
  var MSG_CS_READ_ACTIONS = 'cs_read_actions';
  var MSG_CS_PING = 'cs_ping';

  // ═══════════════════════════════════════════════════════════════
  // INJECTION — inject recording-inject.js into the page's main world
  // ═══════════════════════════════════════════════════════════════

  function injectRecordingScript() {
    if (injected) return;
    injected = true;

    try {
      var url = chrome.runtime.getURL('src/content/recording-inject.js');
      var script = document.createElement('script');
      script.src = url;
      (document.head || document.documentElement).appendChild(script);
      script.onload = function() { script.remove(); };
    } catch (e) {
      // Fallback: try inline injection
      console.warn('[Wally] Could not inject recording script:', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BRIDGE — relay main-world actions → SW via chrome.runtime
  // ═══════════════════════════════════════════════════════════════

  function setupBridge() {
    window.addEventListener('__wally_action', function(e) {
      if (!recording) return;
      var action = e.detail;
      if (!action || !action.type) return;

      chrome.runtime.sendMessage({
        type: 'cs_step',
        ts: new Date().toISOString(),
        selector: action.selector,
        type: action.type,
        text: action.text,
        value: action.value,
        key: action.key,
        modifiers: action.modifiers,
        button: action.button,
        position: action.position,
        files: action.files,
        options: action.options,
        scrollTop: action.scrollTop,
        scrollLeft: action.scrollLeft,
        clickCount: action.clickCount,
        url: action.url || location.href,
        page: action.page || '',
        heading: action.heading,
        flow: action.flow,
        network: action.network,
        account: action.account,
        extensionType: action.extensionType,
        provider: action.provider,
      }).catch(function() {});
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // MESSAGE HANDLER — SW → CS control
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {
    switch (message.type) {
      case MSG_CS_RECORDING_START:
        recording = true;
        injectRecordingScript();
        sendResponse({ ok: true });
        return false;

      case MSG_CS_RECORDING_STOP:
        recording = false;
        sendResponse({ ok: true });
        return false;

      case MSG_CS_READ_ACTIONS: {
        var actions = window.__wally_actions || [];
        window.__wally_actions = [];
        sendResponse({ actions: actions });
        return false;
      }

      case MSG_CS_PING:
        sendResponse({ alive: true });
        return false;

      default:
        return false;
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════

  injectRecordingScript();
  setupBridge();
})();
