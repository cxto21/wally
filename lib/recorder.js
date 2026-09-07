/**
 * Wally Recorder — reusable recording module
 *
 * Injects click/fill/extension listeners into any page via CDP.
 * Used by both `record start` and `daemon start`.
 *
 * Key features:
 * - Uses deepEventTarget() to traverse shadow DOM
 * - Captures pointerdown/pointerup (not just click)
 * - Handles select elements (dropdowns)
 * - Handles dblclick, contextmenu, focus events
 * - Uses capture phase for all listeners
 */

const { RECORDING_SCRIPT, PRE_NAVIGATE_SCRIPT } = require('./recording-script');
const { createLogger } = require('./logger');
const log = createLogger('recorder');

/**
 * Inject recording listeners into a Playwright page.
 * Uses RECORDING_SCRIPT to capture clicks, fills, and extension interactions.
 *
 * @param {import('playwright').Page} page - Playwright page to instrument
 * @returns {Promise<void>}
 */
async function injectRecordingListeners(page) {
  try {
    await page.evaluate(RECORDING_SCRIPT);
  } catch (e) {
    // Page might be navigating or crashed
    log.debug(`injectRecordingListeners: ${e.message}`);
  }
}

/**
 * Read and clear recorded actions from a page's window.__wally_actions array.
 *
 * @param {import('playwright').Page} page - Playwright page with injected recording
 * @returns {Promise<Array>} Array of action objects (click, fill, navigate, etc.)
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
 * Check if a URL is an extension popup (chrome-extension:// protocol).
 *
 * @param {string} url - URL to check
 * @returns {boolean} true if the URL is an extension page
 */
function isExtensionUrl(url) {
  return url && url.startsWith('chrome-extension://');
}

/**
 * Get a human-readable label for a page based on its URL.
 * Extension pages get 'ext:<id>', normal pages get hostname.
 *
 * @param {string} url - Page URL
 * @returns {string} Human-readable page label (e.g. 'ext:a1b2c3d4', 'example.com')
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
