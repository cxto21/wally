/**
 * Wally — Chrome DevTools Recorder Plugin
 *
 * Registers chrome.devtools.recorder extension plugin with
 * stringify (export), stringifyStep (preview), replay handlers.
 * Chrome 105+: export. Chrome 112+: replay via RecorderView.
 * Restricted pages (chrome://, chrome-extension://) → skip registration.
 */

import { convertPuppeteerToWally, convertStep } from '../common/puppeteer-wally-converter.js';

const MSG_RECORDER_ACTIONS = 'recorder_actions';
const MSG_RECORDER_REPLAY = 'recorder_replay';

// ── Guards ──────────────────────────────────────────────────────

function getChromeMajorVersion() {
  const match = navigator.userAgent.match(/Chrome\/(\d+)\./);
  return match ? parseInt(match[1], 10) : 0;
}

function isRestrictedPage() {
  try {
    const url = window.location.href;
    return url.startsWith('chrome://') || url.startsWith('chrome-extension://');
  } catch {
    return true;
  }
}

// ── stringify — export handler ───────────────────────────────────

function stringify(userFlow) {
  try {
    const actions = convertPuppeteerToWally(userFlow);
    if (actions.length === 0) return undefined;

    chrome.runtime.sendMessage({
      type: MSG_RECORDER_ACTIONS,
      tabId: chrome.devtools.inspectedWindow.tabId,
      url: window.location.href,
      page: window.location.hostname || '',
      actions,
    });
  } catch (err) {
    console.warn('[Wally] stringify error:', err);
  }
  return undefined; // non-blocking
}

// ── stringifyStep — per-step preview ────────────────────────────

function stringifyStep(step) {
  try {
    const action = convertStep(step);
    return action ? JSON.stringify(action) : '';
  } catch (err) {
    console.warn('[Wally] stringifyStep error:', err);
    return '';
  }
}

// ── replay — replay handler ─────────────────────────────────────

function replay(userFlow) {
  return new Promise((resolve, reject) => {
    try {
      const actions = convertPuppeteerToWally(userFlow);
      if (actions.length === 0) { resolve(); return; }

      chrome.runtime.sendMessage(
        {
          type: MSG_RECORDER_REPLAY,
          tabId: chrome.devtools.inspectedWindow.tabId,
          actions,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject({ error: chrome.runtime.lastError.message });
            return;
          }
          if (!response) {
            reject({ error: 'No response from service worker' });
            return;
          }
          if (response.ok) {
            resolve();
          } else {
            reject({ error: response.error || 'Cannot replay while recording' });
          }
        }
      );
    } catch (err) {
      reject({ error: err.message || 'Replay failed' });
    }
  });
}

// ── Registration ────────────────────────────────────────────────

function registerPlugin() {
  if (isRestrictedPage()) return;

  const version = getChromeMajorVersion();
  if (version > 0 && version < 105) {
    console.warn(`[Wally] Recorder plugin requires Chrome 105+ (current: ${version}). Skipping.`);
    return;
  }

  if (!chrome?.devtools?.recorder?.registerRecorderExtensionPlugin) {
    console.warn('[Wally] chrome.devtools.recorder API not available. Skipping.');
    return;
  }

  chrome.devtools.recorder.registerRecorderExtensionPlugin({
    stringify,
    stringifyStep,
    replay,
  });

  console.log('[Wally] DevTools Recorder plugin registered.');
}

registerPlugin();
