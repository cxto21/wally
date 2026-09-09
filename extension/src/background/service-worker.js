/**
 * Wally Extension — Service Worker (background)
 *
 * Session lifecycle state machine: idle → recording → bundling → idle.
 * Detects extension popups via tabs.query + tabs.onCreated, attaches
 * chrome.debugger for recording, buffers actions to storage.local
 * with debounced flush, keeps SW alive via chrome.alarms, and
 * recovers state on SW restart.
 */

import { MSG_CS_RECORDING_START, MSG_CS_RECORDING_STOP, MSG_CS_READ_ACTIONS, MSG_CS_PING } from '../common/constants.js';
import { attachPopup, injectRecording, pollPopup, detachPopup, detachAllPopup } from './cdp.js';

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

let session = null;
let pollTimer = null;
let popupPollTimer = null;

// ═══════════════════════════════════════════════════════════════
// ACTION ICON — open side panel
// ═══════════════════════════════════════════════════════════════

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLERS
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'start_recording':
      startRecording(message.url).then(ok => sendResponse({ ok }));
      return true;

    case 'stop_recording':
      stopRecording().then(result => sendResponse(result));
      return true;

    case 'get_sessions':
      getSessions().then(sessions => sendResponse({ sessions }));
      return true;

    case 'export_session':
      exportSession(message.id).then(r => sendResponse(r));
      return true;

    case 'delete_session':
      deleteSession(message.id).then(ok => sendResponse({ ok }));
      return true;

    case 'get_status':
      sendResponse({ state: session?.state || 'idle', sessionId: session?.id || null });
      return false;

    // Content script relay: actions from normal pages
    case 'cs_step':
      if (session && session.state === 'recording') {
        session.actions.push(message);
        debouncedFlush();
      }
      return false;

    // Content script relay: read actions from a tab
    case MSG_CS_READ_ACTIONS: {
      const actions = session ? session.actions : [];
      sendResponse({ actions });
      return false;
    }

    default:
      return false;
  }
});

// ═══════════════════════════════════════════════════════════════
// SESSION LIFECYCLE
// ═══════════════════════════════════════════════════════════════

async function startRecording(url) {
  if (session && session.state === 'recording') return false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return false;

  session = {
    id: 'ext-' + Date.now(),
    state: 'recording',
    startUrl: url || tab.url || '',
    startTabId: tab.id,
    startTime: Date.now(),
    actions: [],
    network: [],
    popupTabIds: [],
    keepAliveTimer: null,
  };

  // Mark active session in storage
  await chrome.storage.local.set({ 'wally-active-session': session.id });

  // Start keep-alive
  startKeepAlive();

  // Start popup polling
  startPopupPoll();

  // Send recording start to content script on active tab
  try {
    await chrome.tabs.sendMessage(tab.id, { type: MSG_CS_RECORDING_START });
  } catch {
    // CS may not be loaded — not fatal, will attach on next nav
  }

  console.log(`[Wally] Recording started: ${session.id}`);
  return true;
}

async function stopRecording() {
  if (!session || session.state !== 'recording') {
    return { ok: false, error: 'No active recording' };
  }

  session.state = 'bundling';

  // Stop keep-alive
  stopKeepAlive();

  // Stop popup polling
  stopPopupPoll();

  // Send recording stop to content script
  try {
    await chrome.tabs.sendMessage(session.startTabId, { type: MSG_CS_RECORDING_STOP });
  } catch { /* tab may be closed */ }

  // Detach all popup debuggers
  await detachAllPopup(session.popupTabIds);

  // Final buffer flush
  await flushBuffer();

  // Save session
  await saveSession();

  const count = session.actions.length;
  const id = session.id;
  session = null;

  console.log(`[Wally] Recording stopped: ${id} (${count} actions)`);
  return { ok: true, sessionId: id, actionCount: count };
}

// ═══════════════════════════════════════════════════════════════
// TAB DETECTION — find extension popups
// ═══════════════════════════════════════════════════════════════

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!session || session.state !== 'recording') return;
  if (tab.url && tab.url.startsWith('chrome-extension://')) {
    await attachPopupTab(tab.id);
  }
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (!session || session.state !== 'recording') return;
  if (details.tabId === session.startTabId && details.frameId === 0) {
    // Re-arm content script on navigation
    try {
      await chrome.tabs.sendMessage(details.tabId, { type: MSG_CS_RECORDING_START });
    } catch { /* CS not ready yet, will be re-armed on load complete */ }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!session || session.state !== 'recording') return;
  if (changeInfo.status === 'complete') {
    if (tabId === session.startTabId) {
      // Page loaded — re-arm content script
      try {
        await chrome.tabs.sendMessage(tabId, { type: MSG_CS_RECORDING_START });
      } catch { /* CS not ready */ }
    } else {
      // Check if it's a new extension popup
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url && tab.url.startsWith('chrome-extension://') && !session.popupTabIds.includes(tabId)) {
          await attachPopupTab(tabId);
        }
      } catch { /* tab may have closed */ }
    }
  }
});

async function startPopupPoll() {
  // Immediate scan for existing extension popups
  await sweepExtensionPopups();
  // Periodic sweep every 2s
  popupPollTimer = setInterval(sweepExtensionPopups, 2000);
}

function stopPopupPoll() {
  if (popupPollTimer) {
    clearInterval(popupPollTimer);
    popupPollTimer = null;
  }
}

async function sweepExtensionPopups() {
  if (!session || session.state !== 'recording') return;
  const tabs = await chrome.tabs.query({ url: 'chrome-extension://*/*' });
  for (const tab of tabs) {
    if (!session.popupTabIds.includes(tab.id)) {
      await attachPopupTab(tab.id);
    }
  }
}

async function attachPopupTab(tabId) {
  if (!session) return;
  session.popupTabIds.push(tabId);
  const ok = await attachPopup(tabId);
  if (ok) {
    await injectRecording(tabId);
  }
}

// ═══════════════════════════════════════════════════════════════
// POLLING — read actions from all tracked targets
// ═══════════════════════════════════════════════════════════════

function startPolling() {
  pollTimer = setInterval(pollAllTargets, 1000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollAllTargets() {
  if (!session || session.state !== 'recording') return;

  // Poll popup tabs via CDP
  for (const tabId of [...session.popupTabIds]) {
    try {
      const actions = await pollPopup(tabId);
      for (const action of actions) {
        session.actions.push({
          ts: new Date().toISOString(),
          ...action,
          url: action.url || '',
          page: 'ext-' + tabId,
        });
      }
    } catch {
      // Tab may have closed — remove from tracking
      session.popupTabIds = session.popupTabIds.filter(id => id !== tabId);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// KEEP-ALIVE — chrome.alarms every 30s while recording
// ═══════════════════════════════════════════════════════════════

function startKeepAlive() {
  chrome.alarms.create('wally-keepalive', { periodInMinutes: 0.5 }); // 30s
}

function stopKeepAlive() {
  chrome.alarms.clear('wally-keepalive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wally-keepalive') {
    // SW stays alive as long as the alarm fires.
    // Also flush buffer periodically.
    if (session && session.state === 'recording') {
      flushBuffer();
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// STORAGE — debounced buffer flush to storage.local
// ═══════════════════════════════════════════════════════════════

let flushTimer = null;

function debouncedFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushBuffer();
  }, 5000);
}

async function flushBuffer() {
  if (!session || session.state !== 'recording') return;
  try {
    await chrome.storage.local.set({
      [`wally-session-${session.id}`]: {
        id: session.id,
        startUrl: session.startUrl,
        startTime: session.startTime,
        actions: session.actions,
        network: session.network,
        exported: false,
      },
    });
  } catch (e) {
    console.error('[Wally] Buffer flush failed:', e.message);
  }
}

async function saveSession() {
  if (!session) return;
  try {
    await chrome.storage.local.remove('wally-active-session');
    await chrome.storage.local.set({
      [`wally-session-${session.id}`]: {
        id: session.id,
        startUrl: session.startUrl,
        startTime: session.startTime,
        endTime: Date.now(),
        actions: session.actions,
        network: session.network,
        exported: false,
      },
    });
  } catch (e) {
    console.error('[Wally] Session save failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// SESSION QUERIES
// ═══════════════════════════════════════════════════════════════

async function getSessions() {
  const data = await chrome.storage.local.get(null);
  const sessions = [];
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('wally-session-')) {
      sessions.push(value);
    }
  }
  return sessions.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}

async function exportSession(id) {
  const data = await chrome.storage.local.get(`wally-session-${id}`);
  const sess = data[`wally-session-${id}`];
  if (!sess) return { ok: false, error: 'Session not found' };

  // Try bridge first
  const bridgeResult = await sendToBridge(sess);
  if (bridgeResult) {
    return { ok: true, exported: 'bridge', session: bridgeResult };
  }

  // Fallback: download as JSON file
  await downloadSession(id);
  return { ok: true, exported: 'download' };
}

async function deleteSession(id) {
  await chrome.storage.local.remove(`wally-session-${id}`);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// WORKER RESTART RECOVERY — restore state from storage.local
// ═══════════════════════════════════════════════════════════════

async function recoverSession() {
  const data = await chrome.storage.local.get('wally-active-session');
  const activeId = data['wally-active-session'];
  if (!activeId) return;

  const sessData = await chrome.storage.local.get(`wally-session-${activeId}`);
  const saved = sessData[`wally-session-${activeId}`];
  if (!saved) {
    await chrome.storage.local.remove('wally-active-session');
    return;
  }

  // Restore session in recording state
  session = {
    ...saved,
    state: 'recording',
    popupTabIds: [],
    keepAliveTimer: null,
  };

  // Re-arm recording infrastructure
  startKeepAlive();
  startPopupPoll();

  // Re-arm content scripts on open tabs
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && !tab.url.startsWith('chrome-extension://')) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: MSG_CS_RECORDING_START });
      } catch { /* CS not loaded */ }
    }
  }

  console.log(`[Wally] Session recovered: ${activeId}`);
}

// ═══════════════════════════════════════════════════════════════
// BRIDGE CLIENT — POST session bundle to local bridge server
// ═══════════════════════════════════════════════════════════════

/**
 * Try to send a session to the local bridge server.
 * Returns the bridge response on success, null if bridge is unavailable.
 *
 * @param {Object} session - Session bundle to send
 * @returns {Promise<Object|null>} Bridge result or null
 */
async function sendToBridge(session) {
  const data = await chrome.storage.local.get(['wally-bridge-port', 'wally-bridge-token']);
  const port = data['wally-bridge-port'];
  const token = data['wally-bridge-token'];

  if (!port || !token) return null; // bridge not configured

  try {
    const res = await fetch(`http://127.0.0.1:${port}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(session),
    });

    if (res.ok) {
      const result = await res.json();
      // Mark session as exported
      await markSessionExported(session.id);
      console.log(`[Wally] Session sent to bridge: ${result.sessionId}`);
      return result;
    }
  } catch (e) {
    // Bridge not running — session stays in storage for manual export
    console.log('[Wally] Bridge not available:', e.message);
  }

  return null;
}

/**
 * Mark a session as exported in storage.
 *
 * @param {string} sessionId - Session ID to mark
 */
async function markSessionExported(sessionId) {
  const key = `wally-session-${sessionId}`;
  const data = await chrome.storage.local.get(key);
  const session = data[key];
  if (session) {
    session.exported = true;
    await chrome.storage.local.set({ [key]: session });
  }
}

// ═══════════════════════════════════════════════════════════════
// DOWNLOAD FALLBACK — export session as downloadable JSON
// ═══════════════════════════════════════════════════════════════

/**
 * Download a session as a JSON file via chrome.downloads API.
 * Used as fallback when bridge is not available.
 *
 * @param {string} sessionId - Session to download
 */
async function downloadSession(sessionId) {
  const data = await chrome.storage.local.get(`wally-session-${sessionId}`);
  const session = data[`wally-session-${sessionId}`];
  if (!session) return;

  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url,
    filename: `wally-session-${sessionId}.json`,
    saveAs: true,
  });
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

recoverSession();
