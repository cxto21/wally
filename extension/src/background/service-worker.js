/**
 * Wally Extension — Service Worker (background)
 *
 * Session lifecycle state machine: idle → recording → bundling → idle.
 * Tracks all tabs via trackedTabs Map (per-tab URL/page capture),
 * polls ALL tracked tabs for actions via chrome.scripting (MAIN world),
 * relays content-script CustomEvent actions, buffers to storage.local
 * with debounced flush, keeps SW alive via chrome.alarms, and
 * recovers state on SW restart.
 */

import { MSG_CS_RECORDING_START, MSG_CS_RECORDING_STOP, MSG_CS_READ_ACTIONS, MSG_CS_PING } from '../common/constants.js';

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

let session = null;
let pollTimer = null;
let replayState = null;

/**
 * trackedTabs: Map<tabId, {url, page}>
 * Per-tab URL/page stamped at injection/navigation time.
 * Used by pollAllTargets to stamp actions with correct tab context.
 */
const trackedTabs = new Map();

/**
 * nativeRecordedTabs: Set<tabId>
 * Tabs where Recorder plugin delivered actions (native recording path).
 * Used to: (1) skip inject injection for these tabs, (2) dedup at merge time.
 */
const nativeRecordedTabs = new Set();

/**
 * nativeActions: Map<tabId, WallyAction[]>
 * Accumulated actions from Recorder plugin (MSG_RECORDER_ACTIONS).
 * Merged into session.actions at stop, sorted by ts.
 */
const nativeActions = new Map();

// Message types for DevTools Recorder ↔ SW contract
const MSG_RECORDER_ACTIONS = 'recorder_actions';
const MSG_RECORDER_REPLAY = 'recorder_replay';
const MSG_RECORDER_TAB_STATUS = 'recorder_tab_status';

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

    case 'replay_session':
      replaySession(message.id).then(r => sendResponse(r));
      return true;

    case 'get_replay_status':
      sendResponse({ replaying: !!replayState, sessionId: replayState?.sessionId || null });
      return false;

    case 'STOP_REPLAY':
      handleStopReplay().then(r => sendResponse(r));
      return true;

    // Content script relay: actions from normal pages via CustomEvent bridge
    case 'cs_step':
      if (session && session.state === 'recording') {
        // Filter synthetic / non-replayable events
        if (message.type === 'click_detected' || message.type === 'page_change') return false;
        // Filter copy/paste/select-all shortcuts (Ctrl/Cmd + single letter)
        if (message.type === 'press' && message.modifiers && message.modifiers.length > 0
            && message.key && message.key.length === 1 && /[a-z]/i.test(message.key)) return false;
        // Deduplicate rapid SPA navigates (aistudio pushes hash navigates every 500ms)
        if (message.type === 'navigate') {
          const last = session.actions[session.actions.length - 1];
          if (last && last.type === 'navigate' && last.url === message.url) return false;
          if (last && last.type === 'navigate' && last.url && message.url && last.url.split('#')[0] === message.url.split('#')[0] && Date.now() - new Date(last.ts).getTime() < 2000) return false;
        }
        const tabId = sender.tab?.id;
        const meta = tabId ? trackedTabs.get(tabId) : null;
        const action = {
          ts: new Date().toISOString(),
          ...message,
          tabId,
          tabUrl: meta?.url || '',
          url: message.url || meta?.url || '',
          page: message.page || meta?.page || '',
        };
        session.actions.push(action);
        // Forward to bridge live channel (best-effort, fire-and-forget)
        postActionToBridge(session.id, action);
        debouncedFlush();
      }
      return false;

    // Content script relay: read actions from a tab
    case MSG_CS_READ_ACTIONS: {
      const actions = session ? session.actions : [];
      sendResponse({ actions });
      return false;
    }

    // ── DevTools Recorder plugin → SW ────────────────────────────

    // Task 3.1: Receive converted Wally actions from Recorder plugin.
    // Each tab's DevTools page sends its recording on export (stringify).
    // Actions are accumulated per-tab and merged at stop.
    case MSG_RECORDER_ACTIONS: {
      if (session && session.state === 'recording' && message.tabId != null) {
        nativeRecordedTabs.add(message.tabId);
        const meta = trackedTabs.get(message.tabId);
        const stampedActions = (message.actions || []).map(a => ({
          ts: new Date().toISOString(),
          ...a,
          tabId: message.tabId,
          tabUrl: message.url || meta?.url || '',
          url: a.url || message.url || meta?.url || '',
          page: a.page || message.page || meta?.page || '',
        }));
        if (!nativeActions.has(message.tabId)) nativeActions.set(message.tabId, []);
        nativeActions.get(message.tabId).push(...stampedActions);
        // Forward each to bridge live channel (best-effort)
        for (const action of stampedActions) {
          postActionToBridge(session.id, action);
        }
        debouncedFlush();
      }
      return false;
    }

    // Task 3.4: Replay via Recorder plugin. Reject if recording active,
    // otherwise create temp session and dispatch to existing replay engine.
    case MSG_RECORDER_REPLAY: {
      if (session && session.state === 'recording') {
        sendResponse({ ok: false, error: 'Cannot replay while recording' });
        return true;
      }
      const replayActions = message.actions || [];
      if (replayActions.length === 0) {
        sendResponse({ ok: false, error: 'No actions to replay' });
        return true;
      }
      // Create temporary session for replay engine
      const tempId = 'replay-' + Date.now();
      const tempSession = {
        id: tempId,
        startUrl: message.tabUrl || '',
        startTime: Date.now(),
        actions: replayActions,
        network: [],
        exported: false,
      };
      chrome.storage.local.set({ [`wally-session-${tempId}`]: tempSession }).then(() => {
        replaySession(tempId).then(r => {
          // Clean up temp session after replay
          chrome.storage.local.remove(`wally-session-${tempId}`);
          sendResponse(r);
        }).catch(e => {
          chrome.storage.local.remove(`wally-session-${tempId}`);
          sendResponse({ ok: false, error: e.message || 'Replay failed' });
        });
      });
      return true;
    }

    // Task 3.7: Respond with tab's recording state (native vs inject).
    case MSG_RECORDER_TAB_STATUS: {
      const isActive = session?.state === 'recording';
      const isNative = message.tabId != null && nativeRecordedTabs.has(message.tabId);
      sendResponse({ active: isActive, native: isNative });
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

  let tab;
  if (url) {
    // Open URL in new tab (like CLI: wally daemon start --url <url>)
    tab = await chrome.tabs.create({ url, active: true });
    // Wait for page to load
    await new Promise(resolve => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Timeout fallback
      setTimeout(resolve, 5000);
    });
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab) return false;

  // Stamp url/page at capture time per tab
  const tabUrl = url || tab.url || '';
  const tabPage = (() => { try { return new URL(tabUrl).hostname || ''; } catch { return ''; } })();

  session = {
    id: 'ext-' + Date.now(),
    state: 'recording',
    startUrl: tabUrl,
    startTabId: tab.id,
    startTime: Date.now(),
    actions: [{
      ts: new Date().toISOString(),
      type: 'navigate',
      tabId: tab.id,
      tabUrl,
      url: tabUrl,
      page: tabPage,
    }],
    network: [],
    keepAliveTimer: null,
  };

  // Reset native recording state for fresh session
  nativeRecordedTabs.clear();
  nativeActions.clear();

  // Track the start tab with per-tab url/page
  trackedTabs.set(tab.id, { url: tabUrl, page: tabPage });

  // Mark active session in storage
  await chrome.storage.local.set({ 'wally-active-session': session.id });

  // Start keep-alive
  startKeepAlive();

  // Start action polling
  startPolling();

  // Inject into start tab
  await injectIntoTab(tab.id, tabUrl);

  // Also sweep existing tabs — they will be tracked but only those with
  // actual actions will be part of replay (idle tabs with 0 actions are ignored)
  await sweepAndInjectAllTabs();

  // Clear any pre-existing actions that happened before Start (avoid
  // capturing stale window.__wally_actions from pages loaded before recording)
  for (const [tid] of trackedTabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tid, allFrames: false },
        world: 'MAIN',
        func: () => { window.__wally_actions = []; },
      });
    } catch {}
  }

  console.log(`[Wally] Recording started: ${session.id} (tab ${tab.id})`);
  return true;
}

async function stopRecording() {
  if (!session || session.state !== 'recording') {
    return { ok: false, error: 'No active recording' };
  }

  session.state = 'bundling';

  // Stop keep-alive
  stopKeepAlive();

  // Stop action polling
  stopPolling();

  // Merge bridge-captured actions (popup recordings via daemon ext-aux)
  let bridgeActions = [];
  try {
    bridgeActions = await fetchBridgeActions(session.id);
    if (bridgeActions.length > 0) {
      console.log(`[Wally] Merging ${bridgeActions.length} bridge actions`);
    }
  } catch (e) {
    console.warn('[Wally] Bridge merge failed:', e.message);
  }

  // Task 3.6: Dedup — remove inject-path actions for native tabs
  // (prevent double-counting when both paths captured the same tab)
  const injectActions = session.actions.filter(a => {
    return a.tabId == null || !nativeRecordedTabs.has(a.tabId);
  });

  // Task 3.5: Merge all three sources and sort by timestamp
  const allNative = [];
  for (const [, actions] of nativeActions) {
    allNative.push(...actions);
  }
  session.actions = [...injectActions, ...allNative, ...bridgeActions];
  session.actions.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

  // Final buffer flush
  await flushBuffer();

  // Save session
  await saveSession();

  const count = session.actions.length;
  const id = session.id;
  session = null;
  trackedTabs.clear();
  nativeRecordedTabs.clear();
  nativeActions.clear();

  console.log(`[Wally] Recording stopped: ${id} (${count} actions)`);
  return { ok: true, sessionId: id, actionCount: count };
}

// ═══════════════════════════════════════════════════════════════
// TAB TRACKING — inject into all tabs, track per-tab metadata
// ═══════════════════════════════════════════════════════════════

/**
 * Inject the recording script into a tab via chrome.scripting (MAIN world).
 * Records per-tab url/page at injection time.
 *
 * @param {number} tabId
 * @param {string} [tabUrl] - URL to stamp; if omitted, reads from chrome.tabs.get
 */
async function injectIntoTab(tabId, tabUrl) {
  if (!session || session.state !== 'recording') return;

  // Task 3.2: Skip tabs on native Recorder path (no inject needed)
  if (nativeRecordedTabs.has(tabId)) return;

  // Resolve URL if not provided
  if (!tabUrl) {
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab.url || '';
    } catch {
      return; // tab closed
    }
  }

  // Skip restricted URLs (chrome://, chrome-extension://, etc.)
  if (!tabUrl || tabUrl.startsWith('chrome://') || tabUrl.startsWith('chrome-extension://')) {
    return;
  }

  const tabPage = (() => { try { return new URL(tabUrl).hostname || ''; } catch { return ''; } })();

  // Record per-tab metadata
  trackedTabs.set(tabId, { url: tabUrl, page: tabPage });

  // Inject recording-inject.js via chrome.scripting (MAIN world)
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      files: ['src/content/recording-inject.js'],
    });
  } catch (e) {
    console.warn(`[Wally] Inject failed tab ${tabId}:`, e.message);
  }
}

/**
 * Sweep all open tabs and inject recording script into each.
 * Used at recording start to cover pre-existing tabs.
 */
async function sweepAndInjectAllTabs() {
  if (!session || session.state !== 'recording') return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      await injectIntoTab(tab.id, tab.url);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// TAB NAVIGATION — re-inject on navigation, track new tabs
// ═══════════════════════════════════════════════════════════════

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!session || session.state !== 'recording') return;
  // New tab created — will track on first navigation (onCommitted/onUpdated)
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (!session || session.state !== 'recording') return;
  if (details.frameId !== 0) return; // only top-level navigations

  // Stamp url/page at navigation time
  const tabPage = (() => { try { return new URL(details.url).hostname || ''; } catch { return ''; } })();
  trackedTabs.set(details.tabId, { url: details.url, page: tabPage });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!session || session.state !== 'recording') return;
  if (changeInfo.status === 'complete') {
    // Page loaded — inject recording script and update tracked metadata
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        await injectIntoTab(tabId, tab.url);
      }
    } catch { /* tab may have closed */ }
  }
});

// ═══════════════════════════════════════════════════════════════
// POLLING — read actions from ALL tracked tabs via MAIN world
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

  const closedTabs = [];

  // Poll ALL tracked tabs (not just the active tab)
  for (const [tabId, meta] of trackedTabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: 'MAIN',
        func: () => {
          const actions = window.__wally_actions || [];
          window.__wally_actions = [];
          return actions;
        },
      });
      if (results && results[0] && results[0].result) {
        for (const action of results[0].result) {
          // Filter synthetic / non-replayable events
          if (action.type === 'click_detected' || action.type === 'page_change') continue;
          if (action.type === 'press' && action.modifiers && action.modifiers.length > 0
              && action.key && action.key.length === 1 && /[a-z]/i.test(action.key)) continue;
          // Deduplicate SPA hash navigates (aistudio)
          if (action.type === 'navigate') {
            const last = session.actions[session.actions.length - 1];
            if (last && last.type === 'navigate' && last.url === action.url) continue;
            if (last && last.type === 'navigate' && last.url && action.url && last.url.split('#')[0] === action.url.split('#')[0] && Date.now() - new Date(last.ts).getTime() < 2000) continue;
          }
          const stamped = {
            ts: new Date().toISOString(),
            ...action,
            tabId,
            tabUrl: meta.url || '',
            url: action.url || meta.url || '',
            page: action.page || meta.page || '',
          };
          session.actions.push(stamped);
          // Forward to bridge live channel (best-effort, fire-and-forget)
          postActionToBridge(session.id, stamped);
        }
      }
    } catch {
      // Tab may have navigated away or been closed
      closedTabs.push(tabId);
    }
  }

  // Clean up closed tabs
  for (const tabId of closedTabs) {
    trackedTabs.delete(tabId);
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
// SELECTOR GRAMMAR — resolve Wally-format selectors in page context
//
// Port of __wally_resolveSelector grammar from recording-inject.js.
// CSS-first chain with XPath/text fallback. Never throws — returns
// null for unparseable or unmatched selectors.
//
// NOTE: resolveSelectorGrammar runs in PAGE context (MAIN world),
// not in the service worker. It is embedded as a string in
// executeScript calls. The standalone module (selector-grammar.js)
// contains the same logic for unit testing.
// ═══════════════════════════════════════════════════════════════

/**
 * Source code for resolveSelectorGrammar — injected into page context.
 * This string is passed to chrome.scripting.executeScript as an inline func.
 */
const RESOLVER_SOURCE = `function resolveSelectorGrammar(sel) {
  if (!sel || typeof sel !== 'string') return null;

  // 1. Role + text: button "Text" | link "Text" | [role] "Text"
  var spaceIdx = sel.indexOf(' ');
  if (spaceIdx > 0) {
    var role = sel.substring(0, spaceIdx);
    var rest = sel.substring(spaceIdx + 1).trim();
    if (rest.charAt(0) === '"' && rest.charAt(rest.length - 1) === '"' && rest.length >= 2) {
      var text = rest.slice(1, -1);
      if (text.length > 0) {
        var tagMap = { link: 'a' };
        var tagName = tagMap[role] || role;
        var roleEls = document.querySelectorAll('[role="' + role + '"]');
        for (var i = 0; i < roleEls.length; i++) {
          if ((roleEls[i].textContent || '').trim().indexOf(text) !== -1) return roleEls[i];
        }
        try {
          var tagEls = document.querySelectorAll(tagName);
          for (var j = 0; j < tagEls.length; j++) {
            if ((tagEls[j].textContent || '').trim().indexOf(text) !== -1) return tagEls[j];
          }
        } catch(e) {}
        // Fallback: any clickable with text (normalized, case-insensitive)
        var norm = text.trim().toLowerCase().replace(/\s+/g,' ');
        var all = document.querySelectorAll('button, a, [role="button"], [role="option"], [data-testid]');
        for (var k = 0; k < all.length; k++) {
          var t = (all[k].innerText || all[k].textContent || '').trim().toLowerCase().replace(/\s+/g,' ');
          if (t.indexOf(norm) !== -1) return all[k];
        }
        return null;
      }
    }
  }

  // 2-6. CSS-parseable selectors
  try {
    var testIdMatch = sel.match(/^\\[data-testid="([^"]+)"\\]$/);
    if (testIdMatch) {
      var el = document.querySelector('[data-testid="' + testIdMatch[1] + '"]');
      if (el) return el;
    }
    if (/^#[\\w-]+$/.test(sel)) {
      var el2 = document.querySelector(sel);
      if (el2) return el2;
    }
    var ariaMatch = sel.match(/^\\[aria-label="([^"]+)"\\]$/);
    if (ariaMatch) {
      var el3 = document.querySelector('[aria-label="' + ariaMatch[1] + '"]');
      if (el3) return el3;
    }
    var nameMatch = sel.match(/^(input|textarea|select)(?:\\[type="(\\w+)"\\])?\\[name="([^"]+)"\\]$/);
    if (nameMatch) {
      var tag = nameMatch[1], type = nameMatch[2], name = nameMatch[3];
      var css = tag + '[name="' + name + '"]';
      if (type) css += '[type="' + type + '"]';
      var el4 = document.querySelector(css);
      if (el4) return el4;
    }
    var el5 = document.querySelector(sel);
    if (el5) return el5;
  } catch(e) {}

  // 7. Nth-child path fallback
  var parts = sel.split(/\\s*>\\s*/);
  if (parts.length > 0) {
    var current = null;
    for (var pi = 0; pi < parts.length; pi++) {
      var part = parts[pi].trim();
      var nthMatch = part.match(/^(\\w+)(?:[=:](\\w+))?:(?:nth-child|nth-of-type)\\((\\d+)\\)$/);
      if (nthMatch) {
        var tagName = nthMatch[1], idx = parseInt(nthMatch[3], 10);
        if (pi === 0) {
          var candidates = document.querySelectorAll(tagName);
          current = candidates[idx - 1] || null;
        } else if (current) {
          var children = Array.from(current.children).filter(function(c) {
            return c.tagName && c.tagName.toLowerCase() === tagName;
          });
          current = children[idx - 1] || null;
        }
        if (!current) return null;
      } else {
        if (pi === 0) { current = document.querySelector(part); }
        else if (current) { current = current.querySelector(part); }
        if (!current) return null;
      }
    }
    return current;
  }
  return null;
}`;

/**
 * Resolve a selector by running resolveSelectorGrammar in page context.
 * @param {number} tabId
 * @param {string} selector
 * @returns {Promise<Element|null>}
 */
async function resolveInPage(tabId, selector) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: 'MAIN',
    func: (sel) => {
      // Inline the resolver — same logic as RESOLVER_SOURCE and selector-grammar.js
      function resolveSelectorGrammar(s) {
        if (!s || typeof s !== 'string') return null;
        // Role + text: split on first space
        var spaceIdx = s.indexOf(' ');
        if (spaceIdx > 0) {
          var role = s.substring(0, spaceIdx);
          var rest = s.substring(spaceIdx + 1).trim();
          if (rest.charAt(0) === '"' && rest.charAt(rest.length - 1) === '"' && rest.length >= 2) {
            var text = rest.slice(1, -1);
            if (text.length > 0) {
              var tagMap = { link: 'a' };
              var tagName = tagMap[role] || role;
              var roleEls = document.querySelectorAll('[role="' + role + '"]');
              for (var i = 0; i < roleEls.length; i++) {
                if ((roleEls[i].textContent || '').trim().indexOf(text) !== -1) return roleEls[i];
              }
              try {
                var tagEls = document.querySelectorAll(tagName);
                for (var j = 0; j < tagEls.length; j++) {
                  if ((tagEls[j].textContent || '').trim().indexOf(text) !== -1) return tagEls[j];
                }
              } catch(e) {}
              var norm = text.trim().toLowerCase().replace(/\s+/g,' ');
              var all = document.querySelectorAll('button, a, [role="button"], [role="option"], [data-testid]');
              for (var k = 0; k < all.length; k++) {
                var t = (all[k].innerText || all[k].textContent || '').trim().toLowerCase().replace(/\s+/g,' ');
                if (t.indexOf(norm) !== -1) return all[k];
              }
              return null;
            }
          }
        }
        // CSS-parseable selectors
        try {
          var testIdMatch = s.match(/^\[data-testid="([^"]+)"\]$/);
          if (testIdMatch) {
            var el = document.querySelector('[data-testid="' + testIdMatch[1] + '"]');
            if (el) return el;
          }
          if (/^#[\w-]+$/.test(s)) {
            var el2 = document.querySelector(s);
            if (el2) return el2;
          }
          var ariaMatch = s.match(/^\[aria-label="([^"]+)"\]$/);
          if (ariaMatch) {
            var el3 = document.querySelector('[aria-label="' + ariaMatch[1] + '"]');
            if (el3) return el3;
          }
          var nameMatch = s.match(/^(input|textarea|select)(?:\[type="(\w+)"\])?\[name="([^"]+)"\]$/);
          if (nameMatch) {
            var tag = nameMatch[1], type = nameMatch[2], name = nameMatch[3];
            var css = tag + '[name="' + name + '"]';
            if (type) css += '[type="' + type + '"]';
            var el4 = document.querySelector(css);
            if (el4) return el4;
          }
          var el5 = document.querySelector(s);
          if (el5) return el5;
        } catch(e) {}
        // Nth-child path fallback
        var parts = s.split(/\s*>\s*/);
        if (parts.length > 0) {
          var current = null;
          for (var pi = 0; pi < parts.length; pi++) {
            var part = parts[pi].trim();
            var nthMatch = part.match(/^(\w+)(?:[=:](\w+))?:(?:nth-child|nth-of-type)\((\d+)\)$/);
            if (nthMatch) {
              var tagName2 = nthMatch[1], idx = parseInt(nthMatch[3], 10);
              if (pi === 0) {
                var candidates = document.querySelectorAll(tagName2);
                current = candidates[idx - 1] || null;
              } else if (current) {
                var children = Array.from(current.children).filter(function(c) {
                  return c.tagName && c.tagName.toLowerCase() === tagName2;
                });
                current = children[idx - 1] || null;
              }
              if (!current) return null;
            } else {
              try {
                if (pi === 0) { current = document.querySelector(part); }
                else if (current) { current = current.querySelector(part); }
              } catch(e) { return null; }
              if (!current) return null;
            }
          }
          return current;
        }
        return null;
      }
      return resolveSelectorGrammar(sel);
    },
    args: [selector],
  });
  return results?.[0]?.result || null;
}

// ═══════════════════════════════════════════════════════════════
// REPLAY RETRY — wait and retry for late-loading SPA elements
// ═══════════════════════════════════════════════════════════════

/**
 * Retry resolving a selector in page context until found or timeout.
 * Polls every 200ms for up to timeoutMs (default 5s).
 *
 * @param {number} tabId
 * @param {string} selector
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{found: boolean, attempts: number}>}
 */
async function resolveWithRetry(tabId, selector, timeoutMs = 5000) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const el = await resolveInPage(tabId, selector);
    if (el) return { found: true, attempts };
    await new Promise(r => setTimeout(r, 200));
  }
  return { found: false, attempts };
}

// ═══════════════════════════════════════════════════════════════
// HIERARCHY-First RESOLUTION — best→target→ancestor→selector
// ═══════════════════════════════════════════════════════════════

/**
 * Build a priority-ordered list of selector strategies from an action's
 * hierarchy fields. Falls back to legacy selector as last resort.
 *
 * @param {Object} action - Recorded action with hierarchy fields
 * @returns {string[]} Non-empty selector strings in retry order
 */
function _buildStrategyChain(action) {
  const strategies = [];
  if (action.bestSemanticSelector) strategies.push(action.bestSemanticSelector);
  if (action.targetSelector) strategies.push(action.targetSelector);
  if (action.ancestorSelectors && action.ancestorSelectors.length > 0) {
    for (const anc of action.ancestorSelectors) {
      if (anc) strategies.push(anc);
    }
  }
  // Legacy selector as final fallback
  if (action.selector) strategies.push(action.selector);
  return strategies;
}

/**
 * Resolve an element using the hierarchy-first fallback chain.
 * Tries bestSemanticSelector → targetSelector → ancestorSelectors → selector,
 * each with retry logic (resolveWithRetry, 2000ms per strategy).
 *
 * @param {Object} action - Recorded action with hierarchy fields
 * @param {number} tabId - Tab to resolve in
 * @returns {Promise<{found: boolean, strategy: string|null, attempts: number}>}
 */
async function resolveWithHierarchy(action, tabId) {
  const strategies = _buildStrategyChain(action);
  let totalAttempts = 0;

  for (const strategy of strategies) {
    const result = await resolveWithRetry(tabId, strategy, 2000);
    totalAttempts += result.attempts;
    if (result.found) {
      return { found: true, strategy, attempts: totalAttempts };
    }
  }

  return { found: false, strategy: null, attempts: totalAttempts };
}

// ═══════════════════════════════════════════════════════════════
// REPLAY — replay a recorded session (like CLI: wally play)
// ═══════════════════════════════════════════════════════════════

/**
 * Replay a recorded session.
 *
 * @param {string} sessionId - Session to replay
 * @param {AbortSignal} [signal] - Optional signal to stop replay mid-sequence
 * @returns {Promise<{ok: boolean, replayed?: number, total?: number, stopped?: boolean, error?: string}>}
 */
async function replaySession(sessionId, signal) {
  if (replayState) return { ok: false, error: 'Already replaying' };
  if (session && session.state === 'recording') return { ok: false, error: 'Cannot replay while recording' };

  const data = await chrome.storage.local.get(`wally-session-${sessionId}`);
  const sess = data[`wally-session-${sessionId}`];
  if (!sess || !sess.actions || sess.actions.length === 0) {
    return { ok: false, error: 'Session not found or empty' };
  }

  replayState = { sessionId, currentIndex: 0, total: sess.actions.length };

  console.log(`[Wally] Replaying session ${sessionId} (${sess.actions.length} actions)`);

  try {
    // Navigate to start URL on active tab and map original tabIds → replay tabIds
    let currentReplayTabId = null;
    if (sess.startUrl) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.update(tab.id, { url: sess.startUrl });
        await waitForTabLoad(tab.id);
        currentReplayTabId = tab.id;
      }
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) currentReplayTabId = tab.id;
    }
    // Map original tabId → replay tabId
    const tabMap = new Map();
    const firstTabId = sess.actions.find(a => a.tabId)?.tabId;
    if (firstTabId && currentReplayTabId) tabMap.set(firstTabId, currentReplayTabId);

    // Only tabs with at least one real action (not just navigate) should be recreated
    const relevantTabIds = new Set(
      sess.actions.filter(a => a.tabId && a.type !== 'navigate' && a.type !== 'click_detected' && a.type !== 'page_change').map(a => a.tabId)
    );

    // Replay each action with delay
    for (let i = 0; i < sess.actions.length; i++) {
      if (!replayState) break; // replay cancelled
      if (replayState.stopped) {
        const stoppedAt = replayState.currentIndex ?? i;
        replayState = null;
        console.log(`[Wally] Replay stopped by user at ${stoppedAt}/${sess.actions.length}`);
        return { ok: true, replayed: stoppedAt, total: sess.actions.length, stopped: true };
      }
      // AbortSignal check — stop after current action completes
      if (signal && signal.aborted) {
        replayState = null;
        console.log(`[Wally] Replay stopped by signal at action ${i}/${sess.actions.length}`);
        return { ok: true, replayed: i, total: sess.actions.length, stopped: true };
      }

      replayState.currentIndex = i;
      const action = sess.actions[i];

      // Skip synthetic polling events — not user actions
      if (action.type === 'click_detected' || action.type === 'page_change') continue;

      // Per-tab routing: ensure action runs in its original tab
      // Skip tabs that never had a real action (idle tabs open before recording)
      if (action.tabId && !relevantTabIds.has(action.tabId)) continue;
      let targetTabId = currentReplayTabId;
      if (action.tabId) {
        if (!tabMap.has(action.tabId)) {
          // New tab appeared during recording → recreate it
          const newTab = await chrome.tabs.create({ url: action.tabUrl || action.url || 'about:blank', active: false });
          await waitForTabLoad(newTab.id);
          tabMap.set(action.tabId, newTab.id);
          console.log(`[Wally] Replay created tab ${newTab.id} for original ${action.tabId}`);
        }
        targetTabId = tabMap.get(action.tabId);
        if (targetTabId !== currentReplayTabId) {
          await chrome.tabs.update(targetTabId, { active: true });
          await waitForTabLoad(targetTabId);
          currentReplayTabId = targetTabId;
        }
      }

      // Handle navigation: navigate the target tab
      if (action.type === 'navigate') {
        if (action.url) {
          await chrome.tabs.update(targetTabId, { url: action.url });
          await waitForTabLoad(targetTabId);
        }
        continue;
      }

      await replayAction(action, targetTabId);

      // Delay between actions (like real user behavior)
      const delay = getActionDelay(action);
      await new Promise(r => setTimeout(r, delay));
    }

    const result = { ok: true, replayed: replayState.currentIndex, total: sess.actions.length };
    replayState = null;
    console.log(`[Wally] Replay finished: ${result.replayed}/${result.total}`);
    return result;
  } catch (e) {
    const error = e.message || String(e);
    replayState = null;
    console.error(`[Wally] Replay failed:`, error);
    return { ok: false, error };
  }
}

async function handleStopReplay() {
  if (!replayState) return { ok: false, error: 'Not replaying' };
  // Flag for replay loop to break gracefully (keeps currentIndex)
  replayState.stopped = true;
  console.log('[Wally] Replay stop requested');
  return { ok: true, stopped: true };
}

function getActionDelay(action) {
  // Realistic delays based on action type
  switch (action.type) {
    case 'click': return 500;
    case 'fill': return 300;
    case 'select': return 400;
    case 'press': return 200;
    case 'scroll': return 300;
    case 'dblclick': return 400;
    case 'check': case 'uncheck': return 300;
    default: return 500;
  }
}

async function replayAction(action, targetTabId) {
  // Prefer the per-tab target (multi-tab replay), fallback to active tab
  let tabId = targetTabId;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      surfaceReplayError(action, 'No active tab available');
      return;
    }
    tabId = tab.id;
  }

  // Resolve selector with hierarchy-first chain (best→target→ancestor→selector)
  let resolved = null;
  try {
    resolved = await resolveWithHierarchy(action, tabId);
  } catch (e) {
    surfaceReplayError(action, 'Selector resolution error: ' + (e.message || e));
    return;
  }

  if (!resolved.found) {
    surfaceReplayError(action, `Element not found after ${resolved.attempts} attempts: ${action.selector}`);
    return;
  }

  // Execute action in page context
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: (act) => {
        function getOffset(el) {
          const rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }

        function simulateClick(el, opts = {}) {
          const pos = getOffset(el);
          const eventOpts = { bubbles: true, cancelable: true, view: window, clientX: pos.x, clientY: pos.y, ...opts };
          el.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
          el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
          el.focus();
          el.dispatchEvent(new PointerEvent('pointerup', eventOpts));
          el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
          el.dispatchEvent(new MouseEvent('click', eventOpts));
        }

        // Re-resolve in page context for the actual action execution
        // (element was verified by SW, but we need the live reference)
        function resolveInPage(sel) {
          if (!sel || typeof sel !== 'string') return null;
          // Role + text: split on first space
          var spaceIdx = sel.indexOf(' ');
          if (spaceIdx > 0) {
            var role = sel.substring(0, spaceIdx);
            var rest = sel.substring(spaceIdx + 1).trim();
            if (rest.charAt(0) === '"' && rest.charAt(rest.length - 1) === '"' && rest.length >= 2) {
              var text = rest.slice(1, -1);
              if (text.length > 0) {
                var tagMap = { link: 'a' };
                var tagName = tagMap[role] || role;
                var roleEls = document.querySelectorAll('[role="' + role + '"]');
                for (var ri = 0; ri < roleEls.length; ri++) {
                  if ((roleEls[ri].textContent || '').trim().indexOf(text) !== -1) return roleEls[ri];
                }
                try {
                  var tagEls = document.querySelectorAll(tagName);
                  for (var ti = 0; ti < tagEls.length; ti++) {
                    if ((tagEls[ti].textContent || '').trim().indexOf(text) !== -1) return tagEls[ti];
                  }
                } catch(e) {}
                return null;
              }
            }
          }
          // CSS selectors
          try { return document.querySelector(sel); } catch {}
          // Nth-child path
          const parts = sel.split(/\s*>\s*/);
          if (parts.length > 0) {
            let current = null;
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i].trim();
              const nthMatch = part.match(/^(\w+)(?:[=:](\w+))?:(?:nth-child|nth-of-type)\((\d+)\)$/);
              if (nthMatch) {
                const [, tagName, , idx] = nthMatch;
                const nth = parseInt(idx, 10);
                if (i === 0) {
                  const candidates = document.querySelectorAll(tagName);
                  current = candidates[nth - 1] || null;
                } else if (current) {
                  const children = Array.from(current.children).filter(
                    c => c.tagName && c.tagName.toLowerCase() === tagName
                  );
                  current = children[nth - 1] || null;
                }
                if (!current) return null;
              } else {
                try {
                  if (i === 0) { current = document.querySelector(part); }
                  else if (current) { current = current.querySelector(part); }
                } catch { return null; }
                if (!current) return null;
              }
            }
            return current;
          }
          return null;
        }

        const el = resolveInPage(act.selector);
        if (!el) return { ok: false, error: 'Element not found in page: ' + act.selector };

        switch (act.type) {
          case 'click':
            simulateClick(el);
            return { ok: true };
          case 'dblclick':
            simulateClick(el);
            setTimeout(() => simulateClick(el), 100);
            el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
            return { ok: true };
          case 'fill':
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
              el.focus();
              el.value = act.value || '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (el.isContentEditable) {
              el.textContent = act.value || '';
              el.dispatchEvent(new InputEvent('input', { bubbles: true }));
            }
            return { ok: true };
          case 'select':
            if (el.tagName === 'SELECT') {
              const val = (act.options && act.options[0]) || act.value || '';
              for (const opt of el.options) {
                if (opt.value === val || opt.textContent.trim() === val) {
                  el.value = opt.value;
                  break;
                }
              }
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return { ok: true };
          case 'press':
            el.focus();
            const keyEvt = new KeyboardEvent('keydown', {
              key: act.key, code: 'Key' + act.key.toUpperCase(),
              bubbles: true, cancelable: true,
              ctrlKey: (act.modifiers || []).includes('Control'),
              shiftKey: (act.modifiers || []).includes('Shift'),
              altKey: (act.modifiers || []).includes('Alt'),
              metaKey: (act.modifiers || []).includes('Meta'),
            });
            el.dispatchEvent(keyEvt);
            el.dispatchEvent(new KeyboardEvent('keyup', {
              key: act.key, bubbles: true, cancelable: true,
            }));
            if (act.key === 'Enter') {
              const form = el.form || el.closest('form');
              if (form) form.submit();
            }
            return { ok: true };
          case 'check':
            if (el.type === 'checkbox') { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
            return { ok: true };
          case 'uncheck':
            if (el.type === 'checkbox') { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
            return { ok: true };
          case 'scroll':
            window.scrollBy(0, 300);
            return { ok: true };
          default:
            return { ok: false, error: 'Unsupported action type: ' + act.type };
        }
      },
      args: [action],
    });

    // Read executeScript result — treat {ok:false} as failure
    const result = results?.[0]?.result;
    if (!result || result.ok === false) {
      surfaceReplayError(action, result?.error || 'Action execution failed');
    }
  } catch (e) {
    surfaceReplayError(action, 'Script execution error: ' + (e.message || e));
  }
}

/**
 * Surface a replay error to the sidepanel via storage.local.
 * The sidepanel listens for storage changes and displays errors in the log.
 *
 * @param {Object} action - The action that failed
 * @param {string} error - Error description
 */
function surfaceReplayError(action, error) {
  const errorEntry = {
    ts: new Date().toISOString(),
    action: { type: action.type, selector: action.selector, text: action.text },
    error,
  };

  console.warn(`[Wally] Replay error: ${action.type} "${action.selector}" — ${error}`);

  // Persist error for sidepanel to pick up
  chrome.storage.local.get('wally-replay-errors', (data) => {
    const errors = data['wally-replay-errors'] || [];
    errors.push(errorEntry);
    // Keep last 50 errors max
    if (errors.length > 50) errors.splice(0, errors.length - 50);
    chrome.storage.local.set({ 'wally-replay-errors': errors });
  });

  // Also notify sidepanel directly if open
  chrome.runtime.sendMessage({
    type: 'replay_error',
    action: errorEntry.action,
    error: errorEntry.error,
    ts: errorEntry.ts,
  }).catch(() => { /* sidepanel may not be open */ });
}

function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      setTimeout(resolve, 500);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.get(tabId).then(t => { if (t && t.status === 'complete') finish(); }).catch(finish);
  });
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
    keepAliveTimer: null,
  };

  // Re-arm recording infrastructure
  startKeepAlive();
  startPolling();

  // Sweep all open tabs and inject recording script
  await sweepAndInjectAllTabs();

  console.log(`[Wally] Session recovered: ${activeId}`);
}

// ═══════════════════════════════════════════════════════════════
// BRIDGE CLIENT — POST session bundle to local bridge server
// ═══════════════════════════════════════════════════════════════

/**
 * Get bridge connection info from storage.
 * @returns {Promise<{port: string|null, token: string|null}>}
 */
async function getBridgeConfig() {
  const data = await chrome.storage.local.get(['wally-bridge-port', 'wally-bridge-token']);
  return { port: data['wally-bridge-port'] || null, token: data['wally-bridge-token'] || null };
}

/**
 * Post a single action to the bridge live channel (fire-and-forget).
 * Best-effort: if bridge is unavailable, action is lost (page actions still recorded).
 *
 * @param {string} sessionId - Recording session id
 * @param {Object} action - Action to forward
 */
async function postActionToBridge(sessionId, action) {
  const { port, token } = await getBridgeConfig();
  if (!port || !token) return;

  try {
    await fetch(`http://127.0.0.1:${port}/actions?id=${sessionId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(action),
    });
  } catch {
    // Bridge not running — web-only mode, silently ignore
  }
}

/**
 * Fetch bridge-captured actions for merge at stop.
 * Returns empty array if bridge is unavailable.
 *
 * @param {string} sessionId - Recording session id
 * @returns {Promise<Array>} Bridge actions (empty if unavailable)
 */
async function fetchBridgeActions(sessionId) {
  const { port, token } = await getBridgeConfig();
  if (!port || !token) return [];

  try {
    const res = await fetch(`http://127.0.0.1:${port}/actions?id=${sessionId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      return data.actions || [];
    }
  } catch {
    // Bridge not available
  }
  return [];
}

/**
 * Check bridge connectivity.
 * @returns {Promise<boolean>}
 */
async function checkBridgeConnected() {
  const { port, token } = await getBridgeConfig();
  if (!port || !token) return false;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Try to send a session to the local bridge server.
 * Returns the bridge response on success, null if bridge is unavailable.
 *
 * @param {Object} session - Session bundle to send
 * @returns {Promise<Object|null>} Bridge result or null
 */
async function sendToBridge(session) {
  const { port, token } = await getBridgeConfig();
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
  const sess = data[key];
  if (sess) {
    sess.exported = true;
    await chrome.storage.local.set({ [key]: sess });
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
  const sess = data[`wally-session-${sessionId}`];
  if (!sess) return;

  // Service workers don't have URL.createObjectURL — use data: URL
  const json = JSON.stringify(sess, null, 2);
  const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);

  chrome.downloads.download({
    url: dataUrl,
    filename: `wally-session-${sessionId}.json`,
    saveAs: true,
  });
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

recoverSession();
