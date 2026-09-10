/**
 * Wally Extension — Content Script (plain script, no ES modules)
 *
 * Injects recording-inject.js into the page's main world on load.
 * Action polling is done by the service worker via chrome.scripting.executeScript.
 * This script handles recording start/stop signals from the SW.
 */

(function() {
  "use strict";

  var injected = false;

  // Message constants (inlined — content scripts can't use import)
  var MSG_CS_RECORDING_START = 'cs_recording_start';
  var MSG_CS_RECORDING_STOP = 'cs_recording_stop';
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
      console.warn('[Wally] Could not inject recording script:', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MESSAGE HANDLER — SW → CS control
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {
    switch (message.type) {
      case MSG_CS_RECORDING_START:
        injectRecordingScript();
        sendResponse({ ok: true });
        return false;

      case MSG_CS_RECORDING_STOP:
        // Nothing to stop — recording script is self-contained
        sendResponse({ ok: true });
        return false;

      case MSG_CS_PING:
        sendResponse({ alive: true });
        return false;

      default:
        return false;
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // INIT — inject early so the page is ready when recording starts
  // ═══════════════════════════════════════════════════════════════

  injectRecordingScript();
})();
