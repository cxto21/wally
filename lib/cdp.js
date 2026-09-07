/**
 * Wally CDP — Chrome DevTools Protocol connection management.
 *
 * Handles connecting to Chrome via CDP, launching Chrome with proper flags,
 * and ensuring CDP is available before recording starts.
 */
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CDP_URL = 'http://127.0.0.1:9222';
const CHROME_DATA_DIR = '/tmp/opencode/chrome-cdp';
const CHROME_DEFAULT_PROFILE = 'Profile 9';

/**
 * Check if Chrome CDP is available on the expected port.
 */
function checkCDP() {
  return new Promise((resolve) => {
    http.get(`${CDP_URL}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ ok: true, data }));
    }).on('error', () => resolve({ ok: false }));
  });
}

/**
 * Kill any running Chrome instances with remote-debugging-port.
 */
function killChrome() {
  try {
    const { execSync } = require('child_process');
    execSync('pkill -9 -f "chrome.*remote-debugging-port"', { stdio: 'ignore' });
  } catch {}
}

/**
 * Set up the Chrome data directory with profile symlinks.
 */
function setupChromeDataDir(profileName) {
  fs.mkdirSync(CHROME_DATA_DIR, { recursive: true });

  const srcProfile = path.join(
    require('os').homedir(),
    '.config/google-chrome',
    profileName
  );
  const dstProfile = path.join(CHROME_DATA_DIR, profileName);

  // Symlink profile (Chrome resolves user-data-dir but not profile dirs inside)
  if (!fs.existsSync(dstProfile)) {
    try { fs.symlinkSync(srcProfile, dstProfile); } catch {}
  }

  // Copy Local State (needed for profile discovery)
  const srcLocalState = path.join(require('os').homedir(), '.config/google-chrome', 'Local State');
  const dstLocalState = path.join(CHROME_DATA_DIR, 'Local State');
  if (fs.existsSync(srcLocalState) && !fs.existsSync(dstLocalState)) {
    fs.copyFileSync(srcLocalState, dstLocalState);
  }

  // Fix broken Service Worker cache symlinks in profile
  const swCacheDir = path.join(dstProfile, 'Service Worker', 'CacheStorage');
  if (!fs.existsSync(swCacheDir)) {
    fs.mkdirSync(swCacheDir, { recursive: true });
  }
}

/**
 * Launch Chrome with remote debugging enabled.
 * @param {string} profileName - Chrome profile name (e.g. "Profile 9")
 * @param {string} [url] - Optional URL to open
 */
function launchChrome(profileName, url) {
  setupChromeDataDir(profileName);
  const flags = [
    '--remote-debugging-port=9222',
    `--user-data-dir=${CHROME_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (url) flags.push(url);

  const { spawn } = require('child_process');
  const child = spawn('google-chrome', flags, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * Connect to Chrome via CDP.
 * @returns {Promise<{browser: Browser, context: BrowserContext, page: Page}>}
 */
async function connectCDP() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  const context = contexts.find(c => c.pages().length > 0) || contexts[0];
  // Find main page (not an extension)
  const page = context.pages().find(p => !p.url().startsWith('chrome-extension://')) || context.pages()[0];
  return { browser, context, page };
}

/**
 * Ensure Chrome CDP is available, prompting to launch if needed.
 * @param {string} [profileName] - Chrome profile name
 * @param {string} [url] - Optional URL to open
 * @param {number} [retries=60] - Max wait iterations (each 500ms)
 * @returns {Promise<boolean>} true if CDP is ready
 */
async function ensureCDP(profileName, url, retries = 60) {
  const status = await checkCDP();
  if (status.ok) return true;

  // Chrome not running — ask to launch
  const profile = profileName || CHROME_DEFAULT_PROFILE;
  console.log(`[Wally] Chrome CDP not detected on port 9222.`);

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question(`Start Chrome with profile "${profile}"? (Y/n) `, ans => {
      rl.close();
      resolve(ans.trim() || 'Y');
    });
  });

  if (answer === 'n' || answer === 'N') {
    console.log('[Wally] Aborted.');
    return false;
  }

  // Kill existing Chrome if any
  const hasChrome = require('child_process')
    .execSync('pgrep -f "chrome" || true', { encoding: 'utf8' }).trim();
  if (hasChrome) {
    console.log('[Wally] Killing existing Chrome...');
    killChrome();
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[Wally] Starting Chrome with profile "${profile}"...`);
  launchChrome(profile, url);

  // Wait for CDP to become available (Profile 9 is heavy, needs up to 30s)
  for (let i = 0; i < retries; i++) {
    await new Promise(r => setTimeout(r, 500));
    const check = await checkCDP();
    if (check.ok) {
      console.log('[Wally] Chrome CDP ready.');
      // Give it a moment to settle before daemon attaches
      await new Promise(r => setTimeout(r, 1500));
      return true;
    }
    if (i % 10 === 9) console.log(`[Wally] Waiting for CDP... ${Math.round((i+1)*0.5)}s`);
  }
  console.log('[Wally] Chrome started but CDP not ready after 30s. Retrying once...');
  // One more try after a short pause
  await new Promise(r => setTimeout(r, 2000));
  const finalCheck = await checkCDP();
  if (finalCheck.ok) {
    console.log('[Wally] Chrome CDP ready (retry).');
    return true;
  }
  console.log('[Wally] Chrome started but CDP still not ready. Please run wally record again.');
  return false;
}

module.exports = {
  CDP_URL,
  CHROME_DATA_DIR,
  CHROME_DEFAULT_PROFILE,
  checkCDP,
  killChrome,
  setupChromeDataDir,
  launchChrome,
  connectCDP,
  ensureCDP,
};
