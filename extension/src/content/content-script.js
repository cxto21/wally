/**
 * Wally Extension — Content Script (plain script, no ES modules)
 *
 * Relays page-level CustomEvent('__wally_action') to the service worker
 * via chrome.runtime.sendMessage({type:'cs_step', ...}).
 * Handles recording start/stop signals from the SW.
 *
 * NOTE: Recording script injection is handled by the service worker via
 * chrome.scripting.executeScript (MAIN world). This content script only
 * relays events — it does NOT inject recording-inject.js (removed in WU4).
 */

(function() {
  "use strict";

  // Message constants (inlined — content scripts can't use import)
  var MSG_CS_RECORDING_START = 'cs_recording_start';
  var MSG_CS_RECORDING_STOP = 'cs_recording_stop';
  var MSG_CS_PING = 'cs_ping';

  // ═══════════════════════════════════════════════════════════════
  // CUSTOM EVENT RELAY — __wally_action → service worker
  //
  // Recording script (injected by SW via chrome.scripting into MAIN world)
  // dispatches CustomEvent('__wally_action') with action detail.
  // Content script (isolated world) listens and relays to the service
  // worker via chrome.runtime.sendMessage.
  // ═══════════════════════════════════════════════════════════════

  window.addEventListener('__wally_action', function(e) {
    try {
      var detail = e.detail;
      if (detail) {
        chrome.runtime.sendMessage({
          type: 'cs_step',
          ...detail,
        });
      }
    } catch (err) {
      // Extension context invalidated (e.g., after extension reload) — not fatal
    }
  });

  // Also listen for postMessage (MAIN world → isolated world) — more reliable for clicks that navigate quickly
  window.addEventListener('message', function(e) {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== '__wally_action') return;
    var detail = e.data.action;
    if (detail) {
      try {
        chrome.runtime.sendMessage({
          type: 'cs_step',
          ...detail,
        });
      } catch (err) {}
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // MESSAGE HANDLER — SW → CS control
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {
    switch (message.type) {
      case MSG_CS_RECORDING_START:
        // Recording script injection handled by SW via chrome.scripting
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
})();
