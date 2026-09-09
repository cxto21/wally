/**
 * Wally Extension — Content Script
 *
 * Injects the RECORDING_SCRIPT IIFE into the page's main world,
 * listens for captured actions via CustomEvents, and relays them
 * to the service worker. Also handles SW→CS recording control
 * messages and provides cs_read_actions for buffered retrieval.
 */

import { RECORDING_SCRIPT, MSG_CS_RECORDING_START, MSG_CS_RECORDING_STOP, MSG_CS_READ_ACTIONS, MSG_CS_PING } from '../common/constants.js';

let recording = false;
let injected = false;

// ═══════════════════════════════════════════════════════════════
// INJECTION — inject RECORDING_SCRIPT into the page's main world
// ═══════════════════════════════════════════════════════════════

function injectRecordingScript() {
  if (injected) return;
  injected = true;

  const script = document.createElement('script');
  script.textContent = RECORDING_SCRIPT;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// ═══════════════════════════════════════════════════════════════
// BRIDGE — relay main-world actions → SW via chrome.runtime
// ═══════════════════════════════════════════════════════════════

function setupBridge() {
  window.addEventListener('__wally_action', (e) => {
    if (!recording) return;
    const action = e.detail;
    if (!action || !action.type) return;

    chrome.runtime.sendMessage({
      type: 'cs_step',
      ts: new Date().toISOString(),
      ...action,
      url: location.href,
    }).catch(() => {});
  });
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLER — SW → CS control + CS → SW queries
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
      const actions = window.__wally_actions || [];
      window.__wally_actions = [];
      sendResponse({ actions });
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
// INIT — inject early so the page is ready when recording starts
// ═══════════════════════════════════════════════════════════════

injectRecordingScript();
setupBridge();
