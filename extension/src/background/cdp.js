/**
 * Wally Extension — CDP Debugger Helper
 *
 * chrome.debugger-based recording for extension popup pages.
 * Content scripts cannot inject into other extensions' pages,
 * so we attach the debugger, inject RECORDING_SCRIPT via
 * Runtime.evaluate, and poll captured actions.
 */

import { RECORDING_SCRIPT } from '../common/constants.js';

/**
 * Attach chrome.debugger to a tab.
 * @returns {boolean} success
 */
export async function attachPopup(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    return true;
  } catch (e) {
    console.error(`[Wally CDP] attach ${tabId} failed:`, e.message);
    return false;
  }
}

/**
 * Inject RECORDING_SCRIPT into the tab via Runtime.evaluate.
 */
export async function injectRecording(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: RECORDING_SCRIPT,
      includeCommandLineAPI: false,
    });
    return true;
  } catch (e) {
    console.error(`[Wally CDP] inject ${tabId} failed:`, e.message);
    return false;
  }
}

/**
 * Poll captured actions from the tab.
 * Reads and clears window.__wally_actions.
 * @returns {Array} captured actions
 */
export async function pollPopup(tabId) {
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'JSON.stringify(window.__wally_actions || [])',
      returnByValue: true,
    });
    const actions = JSON.parse(result?.result?.value || '[]');
    // Clear after read
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'window.__wally_actions = []',
    });
    return actions;
  } catch (e) {
    console.error(`[Wally CDP] poll ${tabId} failed:`, e.message);
    return [];
  }
}

/**
 * Detach the debugger from a tab.
 */
export async function detachPopup(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) {
    console.error(`[Wally CDP] detach ${tabId} failed:`, e.message);
  }
}

/**
 * Detach debugger from all tabs in the set.
 */
export async function detachAllPopup(tabs) {
  for (const tabId of tabs) {
    await detachPopup(tabId);
  }
}
