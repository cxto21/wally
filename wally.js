#!/usr/bin/env node
/**
 * Wally — Browser & Extension Interaction Recorder
 *
 * Records browser and extension actions via Chrome CDP and exports
 * standalone Playwright test scripts.
 *   - Accessibility snapshot via CDP
 *   - actions.jsonl recording format
 *   - Network capture
 *   - Multi-page daemon (records extension popups and extension pages)
 *
 * Usage:
 *   node wally.js snap                          — snapshot current page
 *   node wally.js snap --url https://example.com  — navigate + snapshot
 *   node wally.js record start                  — start recording actions
 *   node wally.js record stop                   — stop + show actions
 *   node wally.js export                        — export actions → Playwright test
 *   node wally.js daemon start                  — start background multi-page recording
 *   node wally.js daemon stop                   — stop daemon + show summary
 *   node wally.js daemon status                 — show active pages + action counts
 *   node wally.js exec "<code>"                — execute Playwright JS live
 *   node wally.js daemon start --har            — record with network capture
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'http://127.0.0.1:9222';
const WALLY_DIR = '/tmp/opencode/wally';
const SESSIONS_DIR = path.join(WALLY_DIR, 'sessions');
const RECORDS_DIR = path.join(__dirname, '.records');
const QA_READY_PASSWORD = process.env.QA_READY_PASSWORD || 'MMOR4MORA!';
const CHROME_DATA_DIR = '/tmp/opencode/chrome-cdp';
const CHROME_DEFAULT_PROFILE = 'Profile 9';

// ═══════════════════════════════════════════════════════════════════
// SNAPSHOT — Accessibility snapshot via CDP
// ═══════════════════════════════════════════════════════════════════

const INTERESTING_ROLES = new Set([
  'RootWebArea', 'main', 'navigation', 'banner', 'contentinfo',
  'form', 'search', 'article', 'section', 'region', 'heading',
  'button', 'link', 'textbox', 'textField', 'checkbox', 'radio',
  'switch', 'combobox', 'listbox', 'menuitem', 'tab', 'slider',
  'dialog', 'alertdialog', 'img', 'list', 'tree', 'table',
]);

const INTERESTING_ATTRS = new Set([
  'data-testid', 'data-test', 'data-qa', 'data-cy',
  'id', 'name', 'type', 'placeholder', 'href', 'src',
  'aria-label', 'aria-modal', 'aria-expanded', 'aria-pressed',
  'aria-selected', 'aria-checked', 'role', 'title', 'alt',
  'onclick', 'tabindex', 'value',
]);

const STATE_PROPS = [
  'disabled', 'checked', 'expanded', 'selected',
  'pressed', 'focused', 'required', 'invalid', 'readonly',
];

function toSnapNode(node) {
  const snap = { role: node.role, name: node.name || '' };
  if (node.children?.length) snap.children = node.children.map(toSnapNode);
  if (node.properties) {
    for (const prop of node.properties) {
      if (STATE_PROPS.includes(prop.name)) snap[prop.name] = prop.value;
      if (INTERESTING_ATTRS.has(prop.name)) snap[prop.name] = prop.value;
    }
  }
  return snap;
}

// Build tree from flat nodes (getFullAXTree returns flat list)
function buildAXTree(nodes) {
  const byId = {};
  for (const n of nodes) {
    byId[n.nodeId] = {
      role: n.role?.value || 'unknown',
      name: n.name?.value || '',
      nodeId: n.nodeId,
      parentId: n.parentId,
      childIds: n.childIds || [],
      properties: n.properties || [],
      ignored: n.ignored,
    };
  }
  function build(nodeId) {
    const n = byId[nodeId];
    if (!n) return null;
    // Skip ignored nodes BUT still traverse their children
    if (n.ignored) {
      const children = n.childIds.map(build).filter(Boolean);
      return children.length === 1 ? children[0] : (children.length > 1 ? { role: 'group', name: '', children } : null);
    }
    const snap = { role: n.role, name: n.name };
    const children = n.childIds.map(build).filter(Boolean);
    if (children.length) snap.children = children;
    for (const prop of n.properties) {
      const val = prop.value?.value;
      if (val === undefined || val === null) continue;
      if (STATE_PROPS.includes(prop.name)) snap[prop.name] = val;
      if (INTERESTING_ATTRS.has(prop.name)) snap[prop.name] = String(val);
    }
    return snap;
  }
  // Find root (no parentId)
  const roots = nodes.filter(n => !n.parentId && !n.ignored);
  if (roots.length === 0) return { role: 'empty', name: '' };
  return build(roots[0].nodeId) || { role: 'empty', name: '' };
}

function renderTree(node, depth = 0) {
  const indent = '  '.repeat(depth);
  const attrs = [];
  if (node.id) attrs.push(`id="${node.id}"`);
  if (node['data-testid']) attrs.push(`data-testid="${node['data-testid']}"`);
  if (node['aria-label']) attrs.push(`aria-label="${node['aria-label']}"`);
  if (node.placeholder) attrs.push(`placeholder="${node.placeholder}"`);
  if (node.href) attrs.push(`href="${node.href}"`);
  if (node.type) attrs.push(`type="${node.type}"`);
  if (node.value) attrs.push(`value="${node.value}"`);
  const states = STATE_PROPS.filter(p => node[p]).join(', ');
  const stateStr = states ? ` [${states}]` : '';
  const attrStr = attrs.length ? ` (${attrs.join(', ')})` : '';
  const name = node.name ? `"${node.name}"` : '';
  const lines = [`${indent}${node.role} ${name}${stateStr}${attrStr}`];
  if (node.children) {
    for (const child of node.children) {
      lines.push(...renderTree(child, depth + 1));
    }
  }
  return lines;
}

async function getSnapshot(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable').catch(() => {});
    await cdp.send('Accessibility.enable').catch(() => {});
    const result = await cdp.send('Accessibility.getFullAXTree');
    const root = buildAXTree(result.nodes || []);
    return {
      ts: new Date().toISOString(),
      url: page.url(),
      title: await page.title().catch(() => ''),
      root,
      compact: renderTree(root).join('\n'),
    };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════
// CONNECT — reuse existing Chrome CDP
// ═══════════════════════════════════════════════════════════════════

async function connect() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  const context = contexts.find(c => c.pages().length > 0) || contexts[0];
  // Find main page (not an extension)
  const page = context.pages().find(p => !p.url().startsWith('chrome-extension://')) || context.pages()[0];
  return { browser, context, page };
}

// ═══════════════════════════════════════════════════════════════════
// CHROME AUTO-LAUNCH — detect CDP, prompt to start if needed
// ═══════════════════════════════════════════════════════════════════

const http = require('http');

function checkCDP() {
  return new Promise((resolve) => {
    http.get(`${CDP_URL}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ ok: true, data }));
    }).on('error', () => resolve({ ok: false }));
  });
}

function killChrome() {
  try {
    const { execSync } = require('child_process');
    execSync('pkill -9 -f "chrome.*remote-debugging-port"', { stdio: 'ignore' });
  } catch {}
}

function setupChromeDataDir(profileName) {
  const fs = require('fs');
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

async function ensureCDP(profileName, url) {
  const status = await checkCDP();
  if (status.ok) return true;

  // Chrome not running — ask to launch
  const profile = profileName || CHROME_DEFAULT_PROFILE;
  console.log(`[Wally] Chrome CDP not detected on port 9222.`);
  const answer = await prompt(`Start Chrome with profile "${profile}"? (Y/n) `);
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
  for (let i = 0; i < 60; i++) {
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

let _rl = null;
let _stdinLines = null;
let _stdinIdx = 0;
function getStdinLines() {
  if (_stdinLines === null && !process.stdin.isTTY) {
    try {
      const data = require('fs').readFileSync(0, 'utf-8');
      _stdinLines = data.split('\n');
      // Keep as is, will handle \r
      _stdinIdx = 0;
      // If data was empty, set to empty array to avoid re-reading
      if (_stdinLines.length === 1 && _stdinLines[0] === '') _stdinLines = [];
    } catch { _stdinLines = []; }
  }
  return _stdinLines;
}
function getRL() {
  if (!_rl || _rl.closed) {
    _rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  }
  return _rl;
}
function prompt(question) {
  const lines = getStdinLines();
  if (lines !== null) {
    process.stdout.write(question);
    const ans = (lines[_stdinIdx++] || '').replace(/\r$/, '');
    process.stdout.write(ans + '\n');
    return Promise.resolve(ans.trim() || 'Y');
  }
  return new Promise((resolve) => getRL().question(question, ans => resolve(ans.trim() || 'Y')));
}
function ask(question) {
  const lines = getStdinLines();
  if (lines !== null) {
    process.stdout.write(question);
    const ans = (lines[_stdinIdx++] || '').replace(/\r$/, '');
    process.stdout.write(ans + '\n');
    return Promise.resolve(ans);
  }
  return new Promise(resolve => getRL().question(question, ans => resolve(ans)));
}
function closeRL() { try { if (_rl) _rl.close(); } catch {} _rl = null; }

function normalizeUrl(input) {
  const t = (input || '').trim();
  if (!t) return 'https://app.avnu.fi/en';
  if (/^https?:\/\//i.test(t)) return t;
  return 'https://' + t.replace(/^\/+/, '');
}

// ═══════════════════════════════════════════════════════════════════
// EXTENSION HANDLER — generic (works with any wallet extension)
// ═══════════════════════════════════════════════════════════════════

async function handleExtension(context, page, actionsFile) {
  // Find any extension page (chrome-extension://)
  const extPage = context.pages().find(p => p.url().startsWith('chrome-extension://'));
  if (!extPage) return [];

  const recorded = [];
  const extUrl = extPage.url();

  // Wait for extension page to load
  await extPage.waitForTimeout(2000);

  // Handle password/unlock screen (common pattern)
  const extText = await extPage.locator('body').textContent().catch(() => '');
  if (/password|contraseña|desbloquear|unlock|enter password|type password/i.test(extText)) {
    console.log(`[Wally] Extension: detected password prompt (${extUrl.substring(0, 40)}...)`);

    // Try to fill password from env or common default
    const password = process.env.QA_READY_PASSWORD || process.env.QA_WALLET_PASSWORD || '';
    if (password) {
      const pwInput = extPage.locator('input[type="password"], input[placeholder*="password" i], input[placeholder*="contraseña" i]').first();
      if (await pwInput.isVisible().catch(() => false)) {
        await pwInput.fill(password);

        // Click unlock/submit button
        const unlockBtn = extPage.getByRole('button', { name: /unlock|desbloquear|submit|enter|ok|confirm/i });
        if (await unlockBtn.isVisible().catch(() => false)) {
          await unlockBtn.click();
          await extPage.waitForTimeout(3000);
        }
      }
    }

    const action = { ts: new Date().toISOString(), type: 'extension_unlock', extUrl };
    recorded.push(action);
    if (actionsFile) fs.appendFileSync(actionsFile, JSON.stringify(action) + '\n');
    console.log('[Wally] Extension: unlock attempted');
  }

  // Handle connection approval (common pattern)
  const approveText = await extPage.locator('body').textContent().catch(() => '');
  if (/approve|connect|authorize|conectar|autorizar|confirm|sign|accept/i.test(approveText)) {
    console.log(`[Wally] Extension: detected connection approval`);

    // Try various approve button patterns
    const approveBtn = extPage.getByRole('button', {
      name: /approve|connect|authorize|conectar|autorizar|confirm|sign|accept|allow/i
    }).last();

    if (await approveBtn.isVisible().catch(() => false)) {
      await approveBtn.click();
      await page.waitForTimeout(3000);

      const action = { ts: new Date().toISOString(), type: 'extension_approve', extUrl };
      recorded.push(action);
      if (actionsFile) fs.appendFileSync(actionsFile, JSON.stringify(action) + '\n');
      console.log('[Wally] Extension: approved');
    }
  }

  return recorded;
}

// Keep backward compatibility
const handleReadyExtension = handleExtension;

// ═══════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════

async function cmdSnap(args) {
  const { browser, page } = await connect();

  // Navigate if --url
  const url = getArg(args, '--url');
  if (url) {
    console.log(`[Wally] Navigating to ${url}...`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    // Dismiss popup
    const popup = await page.locator('.dv-popup-overlay').isVisible().catch(() => false);
    if (popup) {
      await page.evaluate(() => {
        const btn = document.querySelector('.dv-popup-overlay button');
        if (btn) btn.click();
      });
      await page.waitForTimeout(1500);
      console.log(`[Wally] Popup dismissed`);
    }
  }

  const snap = await getSnapshot(page);

  // Save
  const sessionDir = path.join(SESSIONS_DIR, 'current');
  fs.mkdirSync(path.join(sessionDir, 'snapshots'), { recursive: true });
  const snapId = Date.now();
  fs.writeFileSync(path.join(sessionDir, 'snapshots', `${snapId}.json`), JSON.stringify(snap, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'snapshots', `${snapId}.txt`), snap.compact);

  console.log(`\n=== Snapshot: ${snap.url} ===`);
  console.log(`Title: ${snap.title}`);
  console.log(snap.compact);
  console.log(`\nSaved: ${sessionDir}/snapshots/${snapId}.json`);

  try { browser.close(); } catch {}
}

async function cmdRecord(args) {
  const sub = args[0];
  const { browser, page } = await connect();
  const sessionDir = path.join(SESSIONS_DIR, 'recording');
  fs.mkdirSync(path.join(sessionDir, 'snapshots'), { recursive: true });
  const actionsFile = path.join(sessionDir, 'actions.jsonl');

  if (sub === 'start') {
    // Clear previous
    fs.writeFileSync(actionsFile, '');

    // Record navigation
    let lastUrl = page.url();
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url() !== lastUrl) {
        lastUrl = frame.url();
        fs.appendFileSync(actionsFile, JSON.stringify({
          ts: new Date().toISOString(), type: 'navigate', url: frame.url(),
        }) + '\n');
        console.log(`[Wally] Navigate: ${frame.url()}`);
      }
    });

    // Record clicks via CDP
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');

    // Helper: resolve best selector for an element
    await page.evaluate(() => {
      if (!window.__wally_resolveSelector) {
        window.__wally_resolveSelector = (el) => {
          if (el.closest?.('[data-testid]')) {
            return `[data-testid="${el.closest('[data-testid]').dataset.testid}"]`;
          }
          if (el.id) return `#${el.id}`;
          if (el.getAttribute?.('aria-label')) {
            return `[aria-label="${el.getAttribute('aria-label')}"]`;
          }
          return el.tagName?.toLowerCase() || 'element';
        };
      }
    });

    // Listen for click events via JS injection
    await page.evaluate(() => {
      document.addEventListener('click', (e) => {
        const el = e.target;
        const selector = window.__wally_resolveSelector(el);
        window.__wally_actions = window.__wally_actions || [];
        window.__wally_actions.push({ type: 'click', selector, text: el.textContent?.substring(0, 50) });
      }, true);
    }, true);

    // Listen for fill/typing events on form elements via JS injection
    await page.evaluate(() => {
      const FORM_SELECTOR = 'input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="url"], input[type="tel"], input:not([type]), textarea, [role="textbox"], [role="spinbutton"]';
      const RECORDABLE = new Set(['INPUT', 'TEXTAREA', 'TEXTAREA']);
      let currentFill = null;

      function commitFill() {
        if (currentFill && currentFill.value) {
          window.__wally_actions = window.__wally_actions || [];
          window.__wally_actions.push({
            type: 'fill',
            selector: currentFill.selector,
            value: currentFill.value,
          });
        }
        currentFill = null;
      }

      function onChange(e) {
        const el = e.target;
        if (!RECORDABLE.has(el.tagName)) return;
        const selector = window.__wally_resolveSelector(el);
        const value = el.value || '';
        if (value) {
          window.__wally_actions = window.__wally_actions || [];
          window.__wally_actions.push({ type: 'fill', selector, value });
        }
      }

      function onInput(e) {
        const el = e.target;
        if (!RECORDABLE.has(el.tagName)) return;
        const selector = window.__wally_resolveSelector(el);
        const value = el.value || '';
        if (!currentFill || currentFill.selector !== selector) {
          commitFill();
          currentFill = { selector, value: '' };
        }
        currentFill.value = value;
      }

      document.addEventListener('input', onInput, true);
      document.addEventListener('change', onChange, true);
      document.addEventListener('focusout', commitFill, true);
      document.addEventListener('click', commitFill, true);
    }, true);

    // Inject fill state tracking (for CDP key capture)
    await page.evaluate(() => {
      window.__wally_fill_state = { active: false, selector: '', value: '', lastKey: 0 };
    });

    // Record keystrokes via CDP Input.dispatchKeyEvent → accumulated fill actions
    let keyBuffer = [];
    let keySelector = '';
    let keyFlushTimer = null;

    function flushKeys() {
      if (keyBuffer.length === 0) return;
      const value = keyBuffer.map(k => k).join('');
      keyBuffer = [];
      if (keySelector) {
        const entry = {
          ts: new Date().toISOString(),
          type: 'fill',
          selector: keySelector,
          value,
          url: page.url(),
        };
        fs.appendFileSync(actionsFile, JSON.stringify(entry) + '\n');
        console.log(`[Wally] Fill: ${keySelector} "${value.substring(0, 60)}"`);
      }
      keySelector = '';
    }

    cdp.on('Input.dispatchKeyEvent', (params) => {
      if (params.type === 'keyDown' && params.key && params.key.length === 1 && !params.ctrlKey && !params.metaKey) {
        // Accumulate printable characters
        keyBuffer.push(params.text || params.key);
        // Resolve selector from focused element
        page.evaluate(() => {
          const el = document.activeElement;
          return window.__wally_resolveSelector(el);
        }).then(sel => {
          keySelector = sel;
          if (keyFlushTimer) clearTimeout(keyFlushTimer);
          keyFlushTimer = setTimeout(flushKeys, 500);
        }).catch(() => {});
      } else if (params.type === 'keyDown' && (params.key === 'Enter' || params.key === 'Tab')) {
        flushKeys();
      }
    });

    // Record starknet wallet connect
    await page.evaluate(() => {
      if (!window.__wally_wallet_observed) {
        window.__wally_wallet_observed = true;
        let wasConnected = !!window.starknet?.isConnected;
        const check = () => {
          const connected = !!window.starknet?.isConnected;
          if (connected && !wasConnected) {
            const account = window.starknet?.selectedAddress || 'unknown';
            window.__wally_actions = window.__wally_actions || [];
            window.__wally_actions.push({ type: 'wallet_connect', account });
            console.log('[Wally] Wallet connected:', account);
          }
          wasConnected = connected;
        };
        setInterval(check, 1000);
        // Also patch enable if available
        if (window.starknet && typeof window.starknet.enable === 'function') {
          const origEnable = window.starknet.enable.bind(window.starknet);
          window.starknet.enable = async (...args) => {
            const result = await origEnable(...args);
            setTimeout(check, 200);
            return result;
          };
        }
      }
    });

    // Poll for actions
    const poll = setInterval(async () => {
      try {
        const actions = await page.evaluate(() => {
          const a = window.__wally_actions || [];
          window.__wally_actions = [];
          return a;
        });
        for (const action of actions) {
          fs.appendFileSync(actionsFile, JSON.stringify({
            ts: new Date().toISOString(), ...action, url: page.url(),
          }) + '\n');
          if (action.type === 'click') {
            console.log(`[Wally] Click: ${action.selector} "${action.text}"`);
          } else if (action.type === 'fill') {
            console.log(`[Wally] Fill: ${action.selector} "${(action.value || '').substring(0, 60)}"`);
          } else if (action.type === 'wallet_connect') {
            console.log(`[Wally] Wallet connect: ${action.account}`);
          }
        }
      } catch {}
    }, 500);

    // Take initial snapshot
    const snap = await getSnapshot(page);
    fs.writeFileSync(path.join(sessionDir, 'snapshots', 'initial.json'), JSON.stringify(snap, null, 2));

    console.log(`[Wally] 🔴 Recording started`);
    console.log(`[Wally] Actions: ${actionsFile}`);
    console.log(`[Wally] Interact with the browser, then run: node wally.js record stop`);
    console.log(`[Wally] (polling every 500ms for clicks)`);

    // Save poll ref for cleanup
    global.__wally_poll = poll;
    global.__wally_browser = browser;
    global.__wally_cdp = cdp;

  } else if (sub === 'stop') {
    if (global.__wally_poll) clearInterval(global.__wally_poll);

    const snap = await getSnapshot(page);
    fs.writeFileSync(path.join(sessionDir, 'snapshots', 'final.json'), JSON.stringify(snap, null, 2));

    // Count actions
    const lines = fs.existsSync(actionsFile)
      ? fs.readFileSync(actionsFile, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    console.log(`[Wally] 🔴 Recording stopped. ${lines.length} actions captured.`);

    if (global.__wally_cdp) await global.__wally_cdp.detach().catch(() => {});
    try { browser.close(); } catch {}
  }
}

async function cmdExport(args) {
  // Support --from <record-dir> to regenerate from .records/ (actions.jsonl)
  const fromDir = getArg(args, '--from');
  let sessionDir, actionsFile;

  if (fromDir && fs.existsSync(path.join(fromDir, 'actions.jsonl'))) {
    sessionDir = fromDir;
    actionsFile = path.join(fromDir, 'actions.jsonl');
  } else {
    // Default: look in sessions/
    sessionDir = path.join(SESSIONS_DIR, 'recording');
    actionsFile = path.join(sessionDir, 'actions.jsonl');

    if (!fs.existsSync(actionsFile) || fs.statSync(actionsFile).size === 0) {
      const daemonSessions = fs.readdirSync(SESSIONS_DIR)
        .filter(d => d.startsWith('record-') || d.startsWith('daemon-'))
        .sort()
        .reverse();
      if (daemonSessions.length > 0) {
        sessionDir = path.join(SESSIONS_DIR, daemonSessions[0]);
        actionsFile = path.join(sessionDir, 'actions.jsonl');
      }
    }
  }

  if (!fs.existsSync(actionsFile)) {
    console.error(`[Wally] No recorded actions. Run 'record start' or 'daemon start' first.`);
    process.exit(1);
  }

  const lines = fs.readFileSync(actionsFile, 'utf8').trim().split('\n').filter(Boolean);
  const actions = lines.map(l => JSON.parse(l));

  if (actions.length === 0) {
    console.error(`[Wally] Actions file is empty.`);
    process.exit(1);
  }

  const outputFile = getArg(args, '--output') || 'wally-export.spec.js';

  // Group actions by page
  const pages = new Map();
  for (const action of actions) {
    const pageLabel = action.page || 'main';
    if (!pages.has(pageLabel)) pages.set(pageLabel, []);
    pages.get(pageLabel).push(action);
  }

  // Detect extension ID from recorded actions (if any extension was used)
  let detectedExtId = null;
  let detectedExtFullId = null;
  for (const action of actions) {
    if (action.url && action.url.includes('chrome-extension://')) {
      const m = action.url.match(/chrome-extension:\/\/([a-z]+)/);
      if (m) { detectedExtFullId = m[1]; detectedExtId = m[1].substring(0, 8); break; }
    }
  }
  if (!detectedExtFullId) {
    for (const action of actions) {
      if (action.page && action.page.startsWith('ext:')) {
        const match = action.page.match(/ext:(.+)/);
        if (match) detectedExtId = match[1];
        break;
      }
    }
  }

  let test = `/**
 * Auto-generated by Wally
 * Recorded: ${actions[0]?.ts || new Date().toISOString()}
 * Actions: ${actions.length}
 * Pages: ${Array.from(pages.keys()).join(', ')}
 * Extension: ${detectedExtId ? 'detected (' + detectedExtId + ')' : 'none detected'}
 * Run: node playwright.spec.js  (needs Chrome with --remote-debugging-port=9222 and Profile 9)
 */
const { chromium } = require('playwright');
const assert = require('assert');

const CDP_URL = '${CDP_URL}';

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  const context = contexts.find(c => c.pages().length > 0) || contexts[0];
  let page = context.pages().find(p => !p.url().startsWith('chrome-extension://')) || context.pages()[0];
  let extPage = context.pages().find(p => p.url().startsWith('chrome-extension://'));
`;

  let lastPage = 'main';

  for (const action of actions) {
    const actionPage = action.page || 'main';

    // If switching to extension page, add page switch logic
    if (actionPage !== lastPage && actionPage.startsWith('ext:')) {
      test += `\n  // Switch to extension page (any chrome-extension:// URL)\n`;
      test += `  extPage = context.pages().find(p => p.url().startsWith('chrome-extension://'));\n`;
      test += `  if (!extPage) {\n`;
      test += `    // Wait for extension to open (triggered by prior page click)\n`;
      test += `    for (let i = 0; i < 15; i++) {\n`;
      test += `      extPage = context.pages().find(p => p.url().startsWith('chrome-extension://'));\n`;
      test += `      if (extPage) break;\n`;
      test += `      console.log('[Wally] Waiting for extension popup...', i);\n`;
      test += `      await page.waitForTimeout(1000);\n`;
      test += `    }\n`;
      test += `  }\n`;
      if (detectedExtFullId) {
        test += `  if (!extPage) {\n`;
        test += `    console.log('[Wally] Extension not auto-opened, opening as tab...');\n`;
        test += `    extPage = await context.newPage();\n`;
        test += `    await extPage.goto('chrome-extension://${detectedExtFullId}/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});\n`;
        test += `    await extPage.waitForTimeout(2000);\n`;
        test += `  }\n`;
      }
      test += `  if (extPage) {\n`;
      test += `    await extPage.bringToFront().catch(() => {});\n`;
      test += `    await extPage.waitForLoadState('domcontentloaded').catch(() => {});\n`;
      test += `    await extPage.waitForTimeout(1500);\n`;
      test += `    console.log('[Wally] Extension visible:', extPage.url());\n`;
      lastPage = actionPage;
    } else if (actionPage !== lastPage && !actionPage.startsWith('ext:')) {
      test += `\n    // Switch back to main page\n`;
      test += `    page = context.pages().find(p => !p.url().startsWith('chrome-extension://')) || context.pages()[0];\n`;
      test += `    await page.bringToFront().catch(()=>{});\n`;
      lastPage = actionPage;
    }

    const isExtAction = action.page && action.page.startsWith('ext:');
    const indent = isExtAction ? '    ' : '  ';

    if (action.type === 'navigate') {
      const navTarget = isExtAction ? 'extPage' : 'page';
      test += `${indent}await ${navTarget}.goto('${action.url}', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});\n`;
      test += `${indent}await ${navTarget}.waitForTimeout(2000);\n`;
    } else if (action.type === 'click') {
      const sel = action.selector;
      const target = isExtAction ? 'extPage' : 'page';
      // Password inputs are optional (wallet may already be unlocked)
      if (sel.includes('password')) {
        test += `${indent}{ const _pw = ${target}.locator('${sel}').first(); if (await _pw.isVisible().catch(()=>false)) await _pw.click({ force: true, timeout: 5000 }); else console.log('[Wally] Skip password click not visible'); }\n`;
      } else       if (sel.startsWith('[data-testid=') || sel.startsWith('#') || sel.startsWith('[aria-label=')) {
        // data-testid clicks are often one-time (unlock, network switch) — make optional
        test += `${indent}{ const _el = ${target}.locator('${sel}').first(); if (await _el.isVisible().catch(()=>false)) await _el.click({ force: true, timeout: 5000 }); else console.log('[Wally] Skip not visible: ${sel}'); }\n`;
      } else if (sel.startsWith('button "') || sel.startsWith('link "')) {
        // Text-based selector — OK/Close/Cancel are often one-time modals, make optional
        const text = sel.match(/"(.+)"/)?.[1] || sel;
        const role = sel.split(' ')[0];
        const isOptional = /^(OK|Close|Cancel|Dismiss)$/i.test(text.trim());
        if (isOptional) {
          const v = `_btn${Math.random().toString(36).substring(2,4)}`;
          test += `${indent}{ const ${v} = ${target}.getByRole('${role}', { name: /${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/i }).first(); if (await ${v}.isVisible().catch(()=>false)) await ${v}.click({ timeout: 5000 }); else console.log('[Wally] Skip optional button not visible: ' + ${JSON.stringify(text)}); }\n`;
        } else {
          const v2 = `_btn${Math.random().toString(36).substring(2,4)}`;
          test += `${indent}{ const ${v2} = ${target}.getByRole('${role}', { name: /${text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/i }).first(); if (await ${v2}.isVisible().catch(()=>false)) { try { await ${v2}.click({ timeout: 10000 }); } catch(e) { console.log('[Wally] Click failed (continuing):', e.message.split(String.fromCharCode(10))[0]); } } else { console.log('[Wally] Skip button not visible: ' + ${JSON.stringify(text)}); } }\n`;
        }
      } else if (sel.includes(' > ') || sel.includes(':nth-child') || sel.startsWith('div') || sel.startsWith('span') || sel.startsWith('p') || sel === 'html' || sel === 'body') {
        // CSS path (fallback nth-child) — fragile and often non-interactive (loading overlays, error messages)
        const text = action.text || '';
        const walletKeywords = ['Ready', 'Argent', 'Braavos', 'Wallet', 'Carrot', 'STRK', 'Connect'];
        const isWalletOption = walletKeywords.some(k => text.includes(k));
        const isErrorOverlay = text.includes('Contrase') || text.includes('Loading') || text.includes('Bloq May') || text.includes('Desbloque');
        const isTextOnly = (sel === 'p' || sel.endsWith(' > p') || (sel.endsWith(' > span') && !sel.includes('button') && !sel.includes('a'))) && text.length > 15 && !isWalletOption;
        if (isTextOnly || isErrorOverlay) {
          test += `${indent}// Skipped non-interactive: ${sel} "${text.substring(0, 40).replace(/'/g, "\\'").replace(/\n/g,' ')}"\n`;
        } else if (isWalletOption && text) {
          const escText = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').substring(0, 30);
          const varName = `_wallet_${Math.random().toString(36).substring(2,6)}`;
          test += `${indent}{ const ${varName} = ${target}.getByText(/${escText}/i).first(); if (await ${varName}.isVisible().catch(()=>false)) { try { await ${varName}.click({ force: true, timeout: 10000 }); } catch(e) { console.log('[Wally] Wallet click failed (continuing):', e.message.split(String.fromCharCode(10))[0]); } } else { console.log('[Wally] Skip wallet selector not visible: ' + ${JSON.stringify(escText)}); } }\n`;
        } else {
          // Robust: wait for visible with longer timeout for network/latency, skip if not found
          test += `${indent}{ const _el = ${target}.locator('${sel}').first(); if (await _el.isVisible().catch(()=>false)) { await _el.click({ force: true, timeout: 10000 }); } else { console.log('[Wally] Skip not visible (fragile): ${sel}'); } }\n`;
        }
      } else if (sel.startsWith('input[') || sel.startsWith('textarea[')) {
        // Input/textarea selectors — make optional (page may not have loaded, or name changed)
        test += `${indent}{ const _inp = ${target}.locator('${sel}').first(); if (await _inp.isVisible().catch(()=>false)) { try { await _inp.click({ force: true, timeout: 10000 }); } catch(e) { console.log('[Wally] Input click failed (continuing):', e.message.split(String.fromCharCode(10))[0]); } } else { console.log('[Wally] Skip input not visible: ${sel}'); } }\n`;
      } else {
        test += `${indent}{ const _el = ${target}.locator('${sel}').first(); if (await _el.isVisible().catch(()=>false)) { try { await _el.click({ force: true, timeout: 10000 }); } catch(e) { console.log('[Wally] Click failed (continuing):', e.message.split(String.fromCharCode(10))[0]); } } else { console.log('[Wally] Skip not visible: ${sel}'); } }\n`;
      }
      test += `${indent}await page.waitForTimeout(1000);\n`;
    } else if (action.type === 'fill') {
      const escaped = (action.value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const target = (lastPage.startsWith('ext:') && lastPage !== 'main') ? 'extPage' : 'page';
      // All fills are optional — page may not have loaded, or element may be transient
      test += `${indent}{ const _fill = ${target}.locator('${action.selector}').first(); if (await _fill.isVisible().catch(()=>false)) { try { await _fill.fill('${escaped}'); } catch(e) { console.log('[Wally] Fill failed (continuing):', e.message.split(String.fromCharCode(10))[0]); } } else { console.log('[Wally] Skip fill not visible: ${action.selector}'); } }\n`;
      test += `${indent}await page.waitForTimeout(500);\n`;
    } else if (action.type === 'wallet_connect') {
      const walletType = action.walletType || 'unknown';
      test += `${indent}// Wallet connected: ${walletType} (${action.account || 'unknown'})\n`;
      test += `${indent}await page.waitForTimeout(2000);\n`;
    }

    // Close extension block if next action is on main page
    const nextAction = actions[actions.indexOf(action) + 1];
    const nextPage = nextAction ? (nextAction.page || 'main') : null;
    if (nextAction && lastPage.startsWith('ext:') && nextPage && !nextPage.startsWith('ext:')) {
      test += `  }\n\n`;
    }
  }

  // Close any open extension block
  if (lastPage.startsWith('ext:')) {
    test += `  }\n`;
  }

  test += `  console.log('[Wally] Replay done, final URL:', page.url());\n`;
  test += `  if (extPage) {\n`;
  test += `    console.log('[Wally] Extension final URL:', extPage.url());\n`;
  test += `    await extPage.bringToFront().catch(() => {});\n`;
  test += `  } else {\n`;
  test += `    await page.bringToFront().catch(() => {});\n`;
  test += `  }\n`;
  test += `  console.log('[Wally] Keeping browser open 10s for visual check...');\n`;
  test += `  await page.waitForTimeout(10000);\n`;
  test += `  await browser.close();\n`;
  test += `})().catch(e => { console.error(e); process.exit(1); });\n`;

  const outputPath = path.resolve(outputFile);
  fs.writeFileSync(outputPath, test);
  console.log(`[Wally] Exported ${actions.length} actions → ${outputPath}`);
  console.log(`[Wally] Pages: ${Array.from(pages.keys()).join(', ')}`);
  if (detectedExtId) console.log(`[Wally] Extension detected: ${detectedExtId}`);
  console.log(`[Wally] Run: node ${outputPath}`);
  // Report network capture if present
  try {
    const netFile = path.join(sessionDir, 'network.jsonl');
    const harFile = path.join(sessionDir, 'network.har');
    if (fs.existsSync(netFile) || fs.existsSync(harFile)) {
      if (fs.existsSync(netFile)) console.log(`[Wally] Network log: ${netFile}`);
      if (fs.existsSync(harFile)) console.log(`[Wally] HAR: ${harFile}`);
    }
    const cleanNet = path.join(RECORDS_DIR, path.basename(sessionDir), 'network.har');
    if (fs.existsSync(cleanNet)) console.log(`[Wally] Network HAR (clean): ${cleanNet}`);
  } catch {}

  // Also copy to clean .records/<sessionId>/ for visibility
  try {
    const sessionId = path.basename(sessionDir);
    const cleanDir = path.join(RECORDS_DIR, sessionId);
    fs.mkdirSync(cleanDir, { recursive: true });
    if (fs.existsSync(actionsFile)) {
      fs.copyFileSync(actionsFile, path.join(cleanDir, 'actions.jsonl'));
    }
    fs.writeFileSync(path.join(cleanDir, 'playwright.spec.js'), test);
    console.log(`[Wally] Clean copy → ${cleanDir}/ (actions.jsonl + playwright.spec.js)`);
  } catch {}
}

async function cmdWallet(args) {
  const { browser, context, page } = await connect();
  const sessionDir = path.join(SESSIONS_DIR, 'wallet');
  fs.mkdirSync(path.join(sessionDir, 'snapshots'), { recursive: true });
  const actionsFile = path.join(sessionDir, 'actions.jsonl');
  fs.writeFileSync(actionsFile, '');

  try {
    console.log('[Wally] Connected to Chrome via CDP');

    // Check if any wallet is already connected
    const walletInfo = await page.evaluate(() => {
      // EVM wallets
      if (window.ethereum && window.ethereum.selectedAddress) {
        return { type: 'evm', account: window.ethereum.selectedAddress, connected: true };
      }
      // Starknet wallets
      if (window.starknet && window.starknet.isConnected) {
        return { type: 'starknet', account: window.starknet.selectedAddress, connected: true };
      }
      // Solana wallets
      if (window.solana && window.solana.isConnected) {
        return { type: 'solana', account: window.solana.publicKey?.toString(), connected: true };
      }
      return { type: null, account: null, connected: false };
    }).catch(() => ({ type: null, account: null, connected: false }));

    if (walletInfo.connected) {
      console.log(`[Wally] Wallet already connected (${walletInfo.type}: ${walletInfo.account})`);
    } else {
      console.log('[Wally] Attempting to connect wallet...');

      // Try to enable any available wallet
      const enabled = await page.evaluate(async () => {
        // Try starknet
        if (window.starknet && typeof window.starknet.enable === 'function') {
          try { await window.starknet.enable(); return 'starknet'; } catch {}
        }
        // Try ethereum
        if (window.ethereum && typeof window.ethereum.enable === 'function') {
          try { await window.ethereum.enable(); return 'ethereum'; } catch {}
        }
        // Try ethereum request
        if (window.ethereum && typeof window.ethereum.request === 'function') {
          try {
            await window.ethereum.request({ method: 'eth_requestAccounts' });
            return 'ethereum';
          } catch {}
        }
        return null;
      }).catch(() => null);

      if (enabled) {
        console.log(`[Wally] Enabled ${enabled} wallet`);
      }

      // Wait for extension to potentially open
      await page.waitForTimeout(3000);

      // Handle extension if it opened
      const extActions = await handleExtension(context, page, actionsFile);

      // Record the wallet_connect action
      const connectAction = { ts: new Date().toISOString(), type: 'wallet_connect', walletType: enabled };
      fs.appendFileSync(actionsFile, JSON.stringify(connectAction) + '\n');
    }

    // Verify connection
    const finalState = await page.evaluate(() => {
      if (window.ethereum && window.ethereum.selectedAddress) {
        return { connected: true, type: 'evm', account: window.ethereum.selectedAddress };
      }
      if (window.starknet && window.starknet.isConnected) {
        return { connected: true, type: 'starknet', account: window.starknet.selectedAddress };
      }
      if (window.solana && window.solana.isConnected) {
        return { connected: true, type: 'solana', account: window.solana.publicKey?.toString() };
      }
      return { connected: false };
    }).catch(() => ({ connected: false }));

    if (finalState.connected) {
      console.log(`[Wally] Wallet connected: ${finalState.type} (${finalState.account})`);
    } else {
      console.log('[Wally] Wallet connection failed or was rejected');
    }

    // Take snapshot
    const snap = await getSnapshot(page);
    fs.writeFileSync(path.join(sessionDir, 'snapshots', 'wallet.json'), JSON.stringify(snap, null, 2));

    console.log(`\n=== Wallet Status ===`);
    console.log(`Connected: ${finalState.connected}`);
    console.log(`Type: ${finalState.type || 'none'}`);
    console.log(`URL: ${page.url()}`);
    console.log(snap.compact);

  } finally {
    try { browser.close(); } catch {}
  }
}

async function cmdExec(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Wally Exec — Run Playwright JS against live Chrome page

Usage:
  node wally.js exec "<code>"
  node wally.js exec --file <path>
  echo "<code>" | node wally.js exec
  node wally.js exec --help

Options:
  --file <path>       Read code from file
  --page <ext|main>   Target page (default: main)
  --timeout <ms>      Execution timeout in ms (default: 30000)
  --snapshot          Take snapshot after execution and print compact tree

Context available in code:
  page    — Playwright Page (main or extension)
  context — BrowserContext
  browser — Browser

Examples:
  node wally.js exec "return await page.title()"
  node wally.js exec "await page.getByRole('button', {name: /Approve/}).click()"
  node wally.js exec "await page.screenshot({path: '/tmp/out.png'})"
  echo "return await page.url()" | node wally.js exec
`);
    return;
  }

  let filePath = getArg(args, '--file');
  let pageTarget = getArg(args, '--page') || 'main';
  let timeoutStr = getArg(args, '--timeout');
  let timeout = timeoutStr ? parseInt(timeoutStr, 10) : 30000;
  let wantSnapshot = args.includes('--snapshot');

  // Filter out known flags to get positional code
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && i + 1 < args.length) { i++; continue; }
    if (args[i] === '--page' && i + 1 < args.length) { i++; continue; }
    if (args[i] === '--timeout' && i + 1 < args.length) { i++; continue; }
    if (args[i] === '--snapshot') continue;
    filtered.push(args[i]);
  }

  let code = null;
  if (filePath) {
    try { code = fs.readFileSync(path.resolve(filePath), 'utf8'); }
    catch (e) { console.error(`[Wally Exec] Failed to read file ${filePath}: ${e.message}`); process.exit(1); }
  } else if (filtered.length > 0) {
    code = filtered.join(' ');
  } else {
    // Try stdin if no args
    if (!process.stdin.isTTY) {
      try { code = fs.readFileSync(0, 'utf8'); } catch {}
      if (!code || !code.trim()) code = null;
    }
    // Fallback: also check getStdinLines (existing helper for piped input)
    if (!code) {
      const lines = getStdinLines();
      if (lines && lines.length > 0) {
        const joined = lines.join('\n').trim();
        if (joined) code = joined;
      }
    }
  }

  if (!code || !code.trim()) {
    console.error('[Wally Exec] No code provided. Use: node wally.js exec "<code>" or --file <path> or pipe via stdin');
    console.error('Run node wally.js exec --help for usage');
    process.exit(1);
  }
  code = code.trim();

  // Connect to Chrome
  let browser;
  try {
    const conn = await connect();
    browser = conn.browser;
    const context = conn.context;
    let page = conn.page;

    // Select target page
    if (pageTarget === 'ext' || pageTarget === 'extension') {
      const extPage = context.pages().find(p => p.url().startsWith('chrome-extension://'));
      if (extPage) page = extPage;
      else {
        console.error('[Wally Exec] No extension page found. Available pages:');
        context.pages().forEach(p => console.error('  -', p.url()));
        try { await browser.close(); } catch {}
        process.exit(1);
      }
    } else if (pageTarget !== 'main') {
      // Try to find page by URL substring
      const found = context.pages().find(p => p.url().includes(pageTarget));
      if (found) page = found;
    }

    console.log(`[Wally Exec] Target: ${page.url().substring(0, 80)}`);
    console.log(`[Wally Exec] Executing...`);

    // Prepare code: auto-return single expressions, handle 'return' statements
    let wrappedCode = code;
    const hasReturn = /\breturn\b/.test(code);
    const isSingleExpression = !code.includes(';') && !code.includes('\n') && !code.trim().endsWith('}');
    if (!hasReturn && isSingleExpression) {
      wrappedCode = `return (${code})`;
    }

    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    let fn;
    try {
      fn = new AsyncFunction('page', 'context', 'browser', wrappedCode);
    } catch (e) {
      console.error('[Wally Exec] Syntax error in code:');
      console.error(e.stack || e.message);
      try { browser.close().catch(()=>{}); } catch {}
      closeRL();
      process.exit(1);
    }

    let result;
    let execError = null;
    const execPromise = (async () => fn(page, context, browser))();
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Execution timed out after ${timeout}ms`)), timeout));

    try {
      result = await Promise.race([execPromise, timeoutPromise]);
    } catch (e) {
      execError = e;
    }

    if (execError) {
      console.error('[Wally Exec] Error:');
      console.error(execError.stack || execError.message);
      try { browser.close().catch(()=>{}); } catch {}
      closeRL();
      process.exit(1);
    }

    if (result !== undefined) {
      if (typeof result === 'object') {
        try { console.log(JSON.stringify(result, null, 2)); } catch { console.log(String(result)); }
      } else {
        console.log(String(result));
      }
    } else {
      console.log('[Wally Exec] Done (no return value)');
    }

    if (wantSnapshot) {
      try {
        const snap = await getSnapshot(page);
        console.log('\n=== Snapshot after exec ===');
        console.log(snap.compact);
      } catch (e) {
        console.error('[Wally Exec] Snapshot failed:', e.message);
      }
    }

    // Detach without awaiting hang (Playwright connectOverCDP close can hang)
    try { browser.close().catch(()=>{}); } catch {}
    closeRL();
    // Force exit to avoid hanging WS handles (Playwright connectOverCDP)
    setTimeout(()=>process.exit(0), 100);
    process.exit(0);
  } catch (e) {
    console.error('[Wally Exec] Failed to connect to Chrome CDP:');
    console.error(e.stack || e.message);
    console.error(`\nMake sure Chrome is running with --remote-debugging-port=9222`);
    console.error(`CDP URL: ${CDP_URL}`);
    try { if (browser) browser.close().catch(()=>{}); } catch {}
    closeRL();
    process.exit(1);
  }
}

async function cmdDaemon(args) {
  const sub = args[0];
  const { WallyDaemon } = require('./lib/daemon');

  if (sub === 'start') {
    if (args.includes('--help') || args.includes('-h')) {
      console.log(`
Wally Daemon — Background Multi-Page Recorder

Usage:
  node wally.js daemon start [--url <url>] [--profile <name>] [--har] [--har-output <path>]   Start recording
  node wally.js daemon stop                                      Stop daemon
  node wally.js daemon status                                    Show pages + actions

Options:
  --url <url>          Navigate to URL before recording
  --profile <name>     Chrome profile to use (default: "Profile 9")
  --har                Enable network capture (Network.enable via CDP)
  --har-output <path>  HAR output path (default: <sessionDir>/network.har)

If Chrome CDP is not running, Wally will ask to launch it automatically.

Examples:
  node wally.js daemon start                          Record current page
  node wally.js daemon start --url https://avnu.fi   Navigate + record
  node wally.js daemon start --profile "Profile 1"   Use different profile
  node wally.js daemon start --har                    Record with network capture
  node wally.js daemon start --har --har-output /tmp/out.har  Custom HAR path
`);
      return;
    }
    const url = getArg(args, '--url');
    const profile = getArg(args, '--profile') || CHROME_DEFAULT_PROFILE;
    const har = args.includes('--har');
    const harOutput = getArg(args, '--har-output') || getArg(args, '--harOutput');

    // Ensure Chrome CDP is available
    const ok = await ensureCDP(profile, url);
    if (!ok) return;

    const daemon = new WallyDaemon();
    await daemon.start({ url, har, harOutput });
  } else if (sub === 'stop') {
    // Send SIGINT to running daemon
    const pidFile = path.join(WALLY_DIR, 'daemon.pid');
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
      try {
        process.kill(pid, 0); // check if alive
        console.log(`[Wally Daemon] Stopping PID ${pid}...`);
        process.kill(pid, 'SIGINT');
      } catch {
        console.log(`[Wally Daemon] PID ${pid} not running (stale pid file)`);
        fs.unlinkSync(pidFile);
      }
    } else {
      console.log('[Wally Daemon] Not running');
    }
  } else if (sub === 'status') {
    const { WallyDaemon } = require('./lib/daemon');
    await WallyDaemon.status();
  } else {
    console.log(`
Wally Daemon — Background Multi-Page Recorder

Usage:
  node wally.js daemon start [--url <url>] [--profile <name>] [--har] [--har-output <path>]   Start recording
  node wally.js daemon stop                                      Stop daemon
  node wally.js daemon status                                    Show pages + actions

Options:
  --url <url>          Navigate to URL before recording
  --profile <name>     Chrome profile to use (default: "Profile 9")
  --har                Enable network capture (Network.enable via CDP)
  --har-output <path>  HAR output path (default: <sessionDir>/network.har)

If Chrome CDP is not running, Wally will ask to launch it automatically.

Examples:
  node wally.js daemon start                          Record current page
  node wally.js daemon start --url https://avnu.fi   Navigate + record
  node wally.js daemon start --profile "Profile 1"   Use different profile
  node wally.js daemon start --har                    Record with network capture
`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════

function getArg(args, name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

async function cmdPlay(args) {
  const allRecords = fs.existsSync(RECORDS_DIR) ? fs.readdirSync(RECORDS_DIR).filter(d => {
    const full = path.join(RECORDS_DIR, d);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'playwright.spec.js'));
  }) : [];
  // Show all, most recent first (reliable, no filtering)
  const records = allRecords.sort().reverse();

  if (records.length === 0) {
    console.log('[Wally] No records with playwright.spec.js in', RECORDS_DIR);
    console.log('Run: wally record  or  node wally.js daemon start --url https://...');
    return;
  }

  console.log('\n[Wally Play] Available records:\n');
  records.forEach((id, idx) => {
    const full = path.join(RECORDS_DIR, id);
    const actionsFile = path.join(full, 'actions.jsonl');
    let info = '';
    try {
      const lines = fs.readFileSync(actionsFile, 'utf8').trim().split('\n').filter(Boolean);
      const first = lines.length ? JSON.parse(lines[0]) : {};
      const last = lines.length ? JSON.parse(lines[lines.length-1]) : {};
      const pages = [...new Set(lines.map(l => { try { return JSON.parse(l).page || 'main'; } catch { return 'main'; } }))].join(', ');
      info = `${lines.length} actions | ${pages} | ${first.ts ? new Date(first.ts).toLocaleString() : ''}`;
    } catch {}
    console.log(`  ${idx + 1}) ${id}  — ${info}`);
  });

  const sel = args[0] && /^\d+$/.test(args[0]) ? args[0] : null;
  let choice;
  if (sel) {
    choice = parseInt(sel, 10);
  } else {
    const ans = await ask(`\nSelect record to play [1-${records.length}]: `);
    choice = parseInt(ans.trim(), 10);
  }

  if (!choice || choice < 1 || choice > records.length) {
    console.log('[Wally] Invalid selection');
    return;
  }

  const id = records[choice - 1];
  const spec = path.join(RECORDS_DIR, id, 'playwright.spec.js');
  console.log(`\n[Wally] Playing ${id} → ${spec}\n`);
  const { spawn } = require('child_process');
  const proc = spawn('node', [spec], { stdio: 'inherit', cwd: path.dirname(spec) });
  await new Promise((res) => proc.on('close', res));
}

async function cmdInteractive() {
  console.log(`
Wally — Interactive

  1) record  — start recording (daemon)
  2) play    — replay a saved record
  3) list    — show records
  4) status  — daemon status
  5) stop    — stop daemon
`);
  const ans = await ask('Select [1-5] (just number, e.g. 1): ');
  const c = ans.trim().toLowerCase().replace(/^wally\s+/, '').trim();
  if (c === '1' || c === 'record' || c.startsWith('1 ')) {
    const url = await ask('URL to record [https://app.avnu.fi/en]: ');
    const profile = await ask('Chrome profile [Profile 9]: ');
    const args = ['start', '--url', normalizeUrl(url)];
    if (profile.trim()) { args.push('--profile', profile.trim()); }
    await cmdDaemon(args);
  } else if (c === '2' || c === 'play' || c.startsWith('2 ')) {
    await cmdPlay([]);
  } else if (c === '3' || c === 'list' || c.startsWith('3 ')) {
    const records = fs.existsSync(RECORDS_DIR) ? fs.readdirSync(RECORDS_DIR).filter(d => fs.statSync(path.join(RECORDS_DIR,d)).isDirectory()) : [];
    console.log('\nRecords in', RECORDS_DIR);
    records.forEach(r => console.log('  -', r));
  } else if (c === '4' || c === 'status' || c.startsWith('4 ')) {
    await cmdDaemon(['status']);
  } else if (c === '5' || c === 'stop' || c.startsWith('5 ')) {
    await cmdDaemon(['stop']);
  } else if (/^\d+$/.test(c)) {
    // User typed just a number outside range? treat as play selection
    await cmdPlay([c]);
  } else {
    console.log('Unknown option — type just 1, 2, 3, 4 or 5');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const sub = args[1];

  fs.mkdirSync(WALLY_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(RECORDS_DIR, { recursive: true });

  // wally 1 / wally 2 as shortcut for wally play 1 / 2
  if (/^\d+$/.test(cmd)) {
    await cmdPlay([cmd]);
    return;
  }

  switch (cmd) {
    case 'snap': await cmdSnap(args.slice(1)); break;
    case 'record': {
      // wally record  → interactive daemon start, wally record start/stop → legacy
      if (!sub || sub === 'start' && args.length === 1) {
        // interactive record
        const url = await ask('URL to record [https://app.avnu.fi/en]: ');
        const profileAns = await ask('Chrome profile [Profile 9]: ');
        const dArgs = ['start', '--url', normalizeUrl(url)];
        if (profileAns.trim()) dArgs.push('--profile', profileAns.trim());
        await cmdDaemon(dArgs);
      } else {
        await cmdRecord(args.slice(1));
      }
      break;
    }
    case 'play': await cmdPlay(args.slice(1)); break;
    case 'list': {
      const records = fs.existsSync(RECORDS_DIR) ? fs.readdirSync(RECORDS_DIR).filter(d => fs.statSync(path.join(RECORDS_DIR,d)).isDirectory()).sort().reverse() : [];
      console.log(`Records in ${RECORDS_DIR}:`);
      records.forEach(r => console.log(' ', r));
      break;
    }
    case 'export': await cmdExport(args.slice(1)); break;
    case 'wallet': await cmdWallet(args.slice(1)); break;
    case 'daemon': await cmdDaemon(args.slice(1)); break;
    case 'exec': await cmdExec(args.slice(1)); break;
    case undefined:
    case 'interactive':
      await cmdInteractive();
      break;
    default:
      console.log(`
Wally — Browser & Extension Interaction Recorder

Commands:
  wally                          Interactive menu (record / play)
  wally record                   Start recording (asks URL/profile)
  wally play [N]                 Replay saved record (interactive selector)
  wally list                     List records in .records/
  wally snap [--url <url>]       Snapshot current page
  wally export [--output <file>] [--from <dir>]  Export recorded actions → Playwright test
  wally daemon start [--url <url>] [--profile <name>] [--har] [--har-output <path>]  Background recording
  wally daemon stop              Stop daemon
  wally daemon status            Show active pages + action counts
  wally exec "<code>" [--page <ext|main>] [--snapshot] [--timeout <ms>] [--file <path>]  Execute Playwright JS live

Options:
  --profile <name>  Chrome profile (default: "Profile 9")
  --url <url>       Navigate to URL
  --har             Enable network capture (daemon)
  --har-output <path>  HAR output path

CDP: ${CDP_URL}
Sessions: ${SESSIONS_DIR} (tmp, locks)
Records:  ${RECORDS_DIR}/<sessionId>/ (clean: actions.jsonl + playwright.spec.js + network.har)
`);
  }
  // Close readline if not keeping daemon alive
  if (!(cmd === 'daemon' && sub === 'start')) closeRL();
}

main().catch(err => {
  closeRL();
  console.error(`[Wally] Error: ${err.message}`);
  process.exit(1);
});
