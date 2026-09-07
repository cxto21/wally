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
 *
 *   --verbose                                    — enable debug logging (WALLY_VERBOSE=1)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, spawn } = require('child_process');
const { createLogger } = require('./lib/logger');
const { validateFilePath, validateUrl } = require('./lib/validator');
const { connectCDP, ensureCDP, CDP_URL, CHROME_DEFAULT_PROFILE } = require('./lib/cdp');
const { generatePlaywrightTest } = require('./lib/generate-test');
const { WallyDaemon } = require('./lib/daemon');

const log = createLogger('wally');

const WALLY_DIR = process.env.WALLY_DIR || '/tmp/opencode/wally';
const SESSIONS_DIR = path.join(WALLY_DIR, 'sessions');
const RECORDS_DIR = path.join(__dirname, '.records');
const QA_READY_PASSWORD = process.env.QA_READY_PASSWORD || '';
if (!QA_READY_PASSWORD) {
  console.warn('[Wally] QA_READY_PASSWORD not set — extension password prompts will be skipped');
}

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

/**
 * Convert a raw CDP accessibility node into a compact snapshot node.
 * Extracts interesting attributes and state properties.
 *
 * @param {Object} node - Raw CDP accessibility tree node
 * @returns {Object} Compact snapshot node with role, name, children, and state properties
 */
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

/**
 * Build a hierarchical accessibility tree from a flat list of CDP nodes.
 * Handles ignored nodes, parent-child relationships, and interesting attributes.
 *
 * @param {Array} nodes - Flat array of CDP Accessibility.getFullAXTree nodes
 * @returns {Object} Root node of the hierarchical tree (with children)
 */
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

/**
 * Render an accessibility tree node into human-readable indented lines.
 *
 * @param {Object} node - Tree node (role, name, children, state properties)
 * @param {number} [depth=0] - Current indentation depth
 * @returns {Array<string>} Array of formatted lines
 */
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

/**
 * Capture an accessibility snapshot of a Playwright page via CDP.
 * Returns structured tree + compact text representation.
 *
 * @param {import('playwright').Page} page - Playwright page to snapshot
 * @returns {Promise<{ts: string, url: string, title: string, root: Object, compact: string}>}
 */
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

/**
 * Connect to Chrome via CDP using the shared connectCDP helper.
 *
 * @returns {Promise<{browser: import('playwright').Browser, context: import('playwright').BrowserContext, page: import('playwright').Page}>}
 */
async function connect() {
  return connectCDP();
}

let _rl = null;
let _stdinLines = null;
let _stdinIdx = 0;
/**
 * Read all lines from stdin (non-TTY). Caches result for subsequent calls.
 *
 * @returns {string[]|null} Array of input lines, or null if TTY
 */
function getStdinLines() {
  if (_stdinLines === null && !process.stdin.isTTY) {
    try {
      const data = fs.readFileSync(0, 'utf-8');
      _stdinLines = data.split('\n');
      // Keep as is, will handle \r
      _stdinIdx = 0;
      // If data was empty, set to empty array to avoid re-reading
      if (_stdinLines.length === 1 && _stdinLines[0] === '') _stdinLines = [];
    } catch { _stdinLines = []; }
  }
  return _stdinLines;
}
/**
 * Get or create a readline interface for interactive prompts.
 *
 * @returns {readline.Interface}
 */
function getRL() {
  if (!_rl || _rl.closed) {
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return _rl;
}
/**
 * Prompt user for input with a default "Y" if empty.
 * Supports both TTY and piped stdin.
 *
 * @param {string} question - Prompt text
 * @returns {Promise<string>} User's trimmed input or "Y" for empty
 */
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
/**
 * Ask user a question and return raw input.
 * Supports both TTY and piped stdin.
 *
 * @param {string} question - Prompt text
 * @returns {Promise<string>} User's raw input
 */
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
/**
 * Close the readline interface if open. Safe to call multiple times.
 */
function closeRL() { try { if (_rl) _rl.close(); } catch (e) { log.debug(`closeRL: ${e.message}`); } _rl = null; }

/**
 * Normalize a user-provided URL input. Adds https:// if missing, trims whitespace.
 * Defaults to 'https://app.avnu.fi/en' if empty.
 *
 * @param {string} input - Raw URL string from user
 * @returns {string} Normalized URL with protocol
 */
function normalizeUrl(input) {
  const t = (input || '').trim();
  if (!t) return 'https://app.avnu.fi/en';
  if (/^https?:\/\//i.test(t)) return t;
  return 'https://' + t.replace(/^\/+/, '');
}

// ═══════════════════════════════════════════════════════════════════
// EXTENSION HANDLER — generic (works with any chrome-extension://)
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect and handle extension popups (password prompts, connection approval).
 * Works with any chrome-extension:// page — not wallet-specific.
 *
 * @param {import('playwright').BrowserContext} context - Browser context
 * @param {import('playwright').Page} page - Main page
 * @param {string|null} actionsFile - Path to actions.jsonl for recording
 * @returns {Promise<Array>} Array of recorded extension actions
 */
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
    const password = process.env.QA_READY_PASSWORD || process.env.QA_EXTENSION_PASSWORD || '';
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

/**
 * Execute the `snap` command — take an accessibility snapshot of a page.
 *
 * @param {string[]} args - CLI args (supports --url <url>)
 * @returns {Promise<void>}
 */
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

  try { browser.close(); } catch (e) { log.debug(`cmdSnap browser.close: ${e.message}`); }
}

/**
 * Execute the `record` command — start/stop single-page recording.
 *
 * @param {string[]} args - CLI args ('start' or 'stop')
 * @returns {Promise<void>}
 */
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

    // Record Starknet wallet connect
    await page.evaluate(() => {
      if (!window.__wally_ext_observed) {
        window.__wally_ext_observed = true;
        let wasConnected = !!window.starknet?.isConnected;
        const check = () => {
          const connected = !!window.starknet?.isConnected;
          if (connected && !wasConnected) {
            const account = window.starknet?.selectedAddress || 'unknown';
            window.__wally_actions = window.__wally_actions || [];
            window.__wally_actions.push({ type: 'extension_connect', account });
            console.log('[Wally] Wallet provider connected:', account);
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
          } else if (action.type === 'extension_connect') {
            console.log(`[Wally] Extension connect: ${action.account}`);
          }
        }
      } catch (e) { log.debug(`record poll error: ${e.message}`); }
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
    try { browser.close(); } catch (e) { log.debug(`cmdRecord browser.close: ${e.message}`); }
  }
}

/**
 * Execute the `export` command — convert recorded actions into a Playwright test script.
 *
 * @param {string[]} args - CLI args (supports --from <dir>, --output <file>)
 * @returns {Promise<void>}
 */
async function cmdExport(args) {
  // Support --from <record-dir> to regenerate from .records/ (actions.jsonl)
  const fromDir = getArg(args, '--from');
  const outputFile = getArg(args, '--output') || 'wally-export.spec.js';

  // Validate inputs
  if (fromDir) {
    const fromCheck = validateFilePath(fromDir);
    if (!fromCheck.valid) {
      console.error(`[Wally] ${fromCheck.error}`);
      process.exit(1);
    }
  }
  const outputCheck = validateFilePath(outputFile);
  if (!outputCheck.valid) {
    console.error(`[Wally] ${outputCheck.error}`);
    process.exit(1);
  }

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

  // Group actions by page (for info messages)
  const pages = new Map();
  for (const action of actions) {
    const pageLabel = action.page || 'main';
    if (!pages.has(pageLabel)) pages.set(pageLabel, []);
    pages.get(pageLabel).push(action);
  }

  // Detect extension ID for info messages
  let detectedExtId = null;
  for (const action of actions) {
    if (action.url && action.url.includes('chrome-extension://')) {
      const m = action.url.match(/chrome-extension:\/\/([a-z]+)/);
      if (m) { detectedExtId = m[1].substring(0, 8); break; }
    }
  }

  // Generate test using shared module
  const test = generatePlaywrightTest(actions);

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
  } catch (e) { log.debug(`cmdExport network report: ${e.message}`); }

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
  } catch (e) { log.debug(`cmdExport clean copy: ${e.message}`); }
}

/**
 * Execute the `ext` command — connect wallet via extension popup.
 *
 * @param {string[]} args - CLI args
 * @returns {Promise<void>}
 */
async function cmdExt(args) {
  const { browser, context, page } = await connect();
  const sessionDir = path.join(SESSIONS_DIR, 'ext');
  fs.mkdirSync(path.join(sessionDir, 'snapshots'), { recursive: true });
  const actionsFile = path.join(sessionDir, 'actions.jsonl');
  fs.writeFileSync(actionsFile, '');

  try {
    console.log('[Wally] Connected to Chrome via CDP');

    // Check if any wallet is already connected
    const extInfo = await page.evaluate(() => {
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

    if (extInfo.connected) {
      console.log(`[Wally] Wallet already connected (${extInfo.type}: ${extInfo.account})`);
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
        console.log(`[Wally] Enabled ${enabled} provider`);
      }

      // Wait for extension to potentially open
      await page.waitForTimeout(3000);

      // Handle extension if it opened
      const extActions = await handleExtension(context, page, actionsFile);

      // Record the extension_connect action
      const connectAction = { ts: new Date().toISOString(), type: 'extension_connect', extensionType: enabled };
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
      console.log(`[Wally] Wallet provider connected: ${finalState.type} (${finalState.account})`);
    } else {
      console.log('[Wally] Wallet provider connection failed or was rejected');
    }

    // Take snapshot
    const snap = await getSnapshot(page);
    fs.writeFileSync(path.join(sessionDir, 'snapshots', 'ext.json'), JSON.stringify(snap, null, 2));

    console.log(`\n=== Extension Status ===`);
    console.log(`Connected: ${finalState.connected}`);
    console.log(`Type: ${finalState.type || 'none'}`);
    console.log(`URL: ${page.url()}`);
    console.log(snap.compact);

  } finally {
    try { browser.close(); } catch (e) { log.debug(`cmdExt browser.close: ${e.message}`); }
  }
}

/**
 * Execute the `exec` command — run Playwright JS code against a live Chrome page.
 * Supports inline code, --file, stdin pipe, --page, --timeout, --snapshot.
 *
 * @param {string[]} args - CLI args
 * @returns {Promise<void>}
 */
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

  // Validate --file path
  if (filePath) {
    const fileCheck = validateFilePath(filePath);
    if (!fileCheck.valid) {
      console.error(`[Wally Exec] ${fileCheck.error}`);
      process.exit(1);
    }
  }

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
      try { code = fs.readFileSync(0, 'utf8'); } catch (e) { log.debug(`stdin read: ${e.message}`); }
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
        try { await browser.close(); } catch (e) { log.debug(`cmdExec ext page close: ${e.message}`); }
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
      try { browser.close().catch(()=>{}); } catch (e2) { log.debug(`cmdExec syntax error close: ${e2.message}`); }
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
      try { browser.close().catch(()=>{}); } catch (e2) { log.debug(`cmdExec exec error close: ${e2.message}`); }
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
    try { browser.close().catch(()=>{}); } catch (e) { log.debug(`cmdExec final close: ${e.message}`); }
    closeRL();
    // Force exit to avoid hanging WS handles (Playwright connectOverCDP)
    setTimeout(()=>process.exit(0), 100);
    process.exit(0);
  } catch (e) {
    console.error('[Wally Exec] Failed to connect to Chrome CDP:');
    console.error(e.stack || e.message);
    console.error(`\nMake sure Chrome is running with --remote-debugging-port=9222`);
    console.error(`CDP URL: ${CDP_URL}`);
    try { if (browser) browser.close().catch(()=>{}); } catch (e2) { log.debug(`cmdExec connect fail close: ${e2.message}`); }
    closeRL();
    process.exit(1);
  }
}

/**
 * Execute the `daemon` command — background multi-page recording.
 * Subcommands: start, stop, status.
 *
 * @param {string[]} args - CLI args (subcommand + flags)
 * @returns {Promise<void>}
 */
async function cmdDaemon(args) {
  const sub = args[0];

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

/**
 * Extract a named argument value from CLI args array.
 *
 * @param {string[]} args - CLI arguments array
 * @param {string} name - Argument name (e.g. '--url')
 * @returns {string|null} The value following the argument, or null if not found
 */
function getArg(args, name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

/**
 * Execute the `play` command — replay a saved recording.
 * Shows an interactive selector or plays a specific record by index.
 *
 * @param {string[]} args - Optional record index
 * @returns {Promise<void>}
 */
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
    } catch (e) { log.debug(`cmdPlay info read: ${e.message}`); }
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
  const proc = spawn('node', [spec], { stdio: 'inherit', cwd: path.dirname(spec) });
  await new Promise((res) => proc.on('close', res));
}

/**
 * Execute the `interactive` command — text-based interactive menu.
 * Offers record, play, list, status, stop options.
 *
 * @returns {Promise<void>}
 */
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

// ═══════════════════════════════════════════════════════════════════
// CREATE-SKILL — generates Agent Skill from a recorded session
// ═══════════════════════════════════════════════════════════════════

/**
 * Execute the `create-skill` command — generate an Agent Skill from a recorded session.
 * Outputs SKILL.md + optional playwright.spec.js for agent compatibility.
 *
 * @param {string[]} args - CLI args (supports -c for latest, session-id, or interactive)
 * @returns {Promise<void>}
 */
async function cmdCreateSkill(args) {
  // Flags
  const useLatest = args.includes('-c');

  // Find sessions with actions.jsonl
  const allSessions = fs.existsSync(RECORDS_DIR)
    ? fs.readdirSync(RECORDS_DIR).filter(d => {
        const full = path.join(RECORDS_DIR, d);
        return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'actions.jsonl'));
      }).sort().reverse()
    : [];

  if (allSessions.length === 0) {
    console.log('[Wally] No recorded sessions found in', RECORDS_DIR);
    console.log('Run: wally daemon start --url https://...');
    return;
  }

  let sessionDir;
  let sessionId;

  // MODE: -c flag → use latest session
  if (useLatest) {
    sessionId = allSessions[0];
    sessionDir = path.join(RECORDS_DIR, sessionId);
    console.log(`[Wally] Using latest session: ${sessionId}`);
  }
  // MODE: argument → find specific session
  else if (args[0] && !args[0].startsWith('-')) {
    const arg = args[0];
    if (fs.existsSync(arg) && fs.existsSync(path.join(arg, 'actions.jsonl'))) {
      sessionDir = arg;
      sessionId = path.basename(arg);
    } else if (fs.existsSync(path.join(RECORDS_DIR, arg))) {
      sessionDir = path.join(RECORDS_DIR, arg);
      sessionId = arg;
    } else {
      console.log(`[Wally] Error: Session not found: ${arg}`);
      console.log('[Wally] Available sessions:');
      allSessions.forEach((s, i) => console.log(`  ${i + 1}) ${s}`));
      return;
    }
  }
  // MODE: no args → interactive selector
  else {
    console.log('\n[Wally Create Skill] Available sessions:\n');
    allSessions.forEach((id, idx) => {
      const full = path.join(RECORDS_DIR, id);
      const actionsFile = path.join(full, 'actions.jsonl');
      const hasSkill = fs.existsSync(path.join(full, 'skill', 'SKILL.md'));
      let info = '';
      try {
        const lines = fs.readFileSync(actionsFile, 'utf8').trim().split('\n').filter(Boolean);
        const first = lines.length ? JSON.parse(lines[0]) : {};
        const pages = [...new Set(lines.map(l => { try { return JSON.parse(l).page || 'main'; } catch { return 'main'; } }))].join(', ');
        info = `${lines.length} actions | ${pages} | ${first.ts ? new Date(first.ts).toLocaleString() : ''}`;
      } catch (e) { log.debug(`cmdCreateSkill info read: ${e.message}`); }
      const skillMark = hasSkill ? ' [skill]' : '';
      console.log(`  ${idx + 1}) ${id}  — ${info}${skillMark}`);
    });

    const ans = await ask(`\nSelect session to create skill [1-${allSessions.length}]: `);
    const choice = parseInt(ans.trim(), 10);

    if (!choice || choice < 1 || choice > allSessions.length) {
      console.log('[Wally] Invalid selection');
      return;
    }

    sessionId = allSessions[choice - 1];
    sessionDir = path.join(RECORDS_DIR, sessionId);
  }

  // Check if skill already exists
  const skillDir = path.join(sessionDir, 'skill');
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillFile)) {
    console.log(`[Wally] Skill already exists: ${skillFile}`);
    const ans = await ask('[Wally] Overwrite? (y/N): ');
    if (ans.trim().toLowerCase() !== 'y') {
      console.log('[Wally] Aborted');
      return;
    }
  }

  // Read actions
  const actionsFile = path.join(sessionDir, 'actions.jsonl');
  const lines = fs.readFileSync(actionsFile, 'utf8').trim().split('\n').filter(Boolean);
  const actions = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  if (actions.length === 0) {
    console.log('[Wally] Error: No actions found');
    return;
  }

  // Read or generate Playwright test
  const testFile = path.join(sessionDir, 'playwright.spec.js');
  let testCode;
  if (fs.existsSync(testFile)) {
    testCode = fs.readFileSync(testFile, 'utf8');
  } else {
    // Generate from actions
    testCode = generatePlaywrightTest(actions, { includeNetwork: false });
    // Save to session for future use
    fs.writeFileSync(testFile, testCode);
    console.log(`[Wally] Generated playwright.spec.js for session`);
  }

  // Detect pages and extensions
  const pages = new Set();
  const extensions = new Set();
  actions.forEach(a => {
    if (a.page) pages.add(a.page);
    if (a.url && a.url.startsWith('chrome-extension://')) {
      const match = a.url.match(/chrome-extension:\/\/([a-z]+)/);
      if (match) extensions.add(match[1]);
    }
  });

  // Build action summary
  const actionSummary = actions.map(a => {
    switch (a.type) {
      case 'click': return `Click: ${a.selector}${a.text ? ` ("${a.text.substring(0, 30)}")` : ''}`;
      case 'fill': return `Fill: ${a.selector} = "${(a.value || '').substring(0, 30)}"`;
      case 'navigate': return `Navigate: ${a.url}`;
      case 'extension_connect': return `Extension connected: ${a.account || 'unknown'}`;
      default: return `${a.type}: ${a.selector || a.url || ''}`;
    }
  });

  // Generate skill name and directory inside the session
  fs.mkdirSync(skillDir, { recursive: true });

  // Generate SKILL.md
  const skillContent = `---
name: wally-${sessionId}
description: "Trigger: replay recorded flow, run recorded workflow, execute recorded session. Replay a browser workflow recorded with Wally (${actions.length} actions across ${pages.size} pages)."
license: BSD-3-Clause
metadata:
  author: "cxto21"
  version: "1.0"
  source: "wally-recorded-session"
  session: "${sessionId}"
  actions: "${actions.length}"
  pages: "${Array.from(pages).join(', ')}"
---

# Recorded Workflow: ${sessionId}

This skill replays a browser workflow recorded with Wally.

## Session Info

- **Actions**: ${actions.length}
- **Pages**: ${Array.from(pages).join(', ')}${extensions.size > 0 ? `\n- **Extensions**: ${Array.from(extensions).join(', ')}` : ''}
- **Recorded**: ${actions[0]?.ts || 'unknown'}

## Recorded Steps

${actionSummary.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## How to Run

### Prerequisites

- Node.js >= 18
- Google Chrome with CDP on port 9222
- Playwright: \`npm install playwright\`

### Option A: Run the generated Playwright test

\`\`\`bash
# Start Chrome with CDP
google-chrome --remote-debugging-port=9222

# Run the test
node skill/playwright.spec.js
\`\`\`

### Option B: Replay with Wally

\`\`\`bash
# Start Chrome with CDP
google-chrome --remote-debugging-port=9222

# Replay the recorded session
node wally.js play ${sessionId}
\`\`\`

## Generated Playwright Test

\`\`\`javascript
${testCode || '// Test not available — run: wally export'}
\`\`\`

## Agent Instructions

To replay this workflow:

1. Ensure Chrome is running with CDP on port 9222
2. Navigate to the starting URL: ${actions.find(a => a.type === 'navigate')?.url || 'see first action'}
3. Execute each recorded step in order
4. Handle any extension popups (auto-detected as chrome-extension:// pages)
5. Verify the final state matches expectations
`;

  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);

  // Write playwright.spec.js to skill directory
  fs.writeFileSync(path.join(skillDir, 'playwright.spec.js'), testCode);

  console.log(`[Wally] Skill created: ${skillDir}/`);
  console.log(`[Wally] Session: ${sessionId}`);
  console.log(`[Wally] Actions: ${actions.length}, Pages: ${pages.size}`);
  console.log(`[Wally] Compatible with: OpenCode, Claude Code, Cursor, VS Code, Gemini CLI, and 40+ agents`);
}

/**
 * Generate a generic Agent Skill SKILL.md template (not session-specific).
 *
 * @param {string} outDir - Output directory for the skill
 * @param {string} skillName - Name for the generated skill
 * @returns {Promise<void>}
 */
async function cmdSkillGeneric(outDir, skillName) {
  const skillDir = path.join(outDir, skillName);
  fs.mkdirSync(skillDir, { recursive: true });

  // Generate SKILL.md
  const skillContent = `---
name: ${skillName}
description: "Trigger: record browser, record extension, capture interaction, browser testing, extension testing, chrome extension, playwright export. Record browser and Chrome extension interactions via CDP and export Playwright test scripts."
license: BSD-3-Clause
metadata:
  author: "cxto21"
  version: "1.0"
  homepage: "https://cxto21.github.io/wally/"
  repository: "https://github.com/cxto21/wally"
---

# Wally — Browser & Extension Interaction Recorder

Record browser actions and Chrome extension popups via CDP. Export standalone Playwright test scripts.

## Prerequisites

- Node.js >= 18
- Google Chrome
- Playwright: \`npm install playwright\`

## Core Commands

### Start Recording (Daemon Mode)

\`\`\`bash
node wally.js daemon start --url <website-url>
\`\`\`

Options:
- \`--url <url>\` — Navigate to URL before recording
- \`--profile <name>\` — Chrome profile (default: "Profile 9")
- \`--har\` — Enable network capture (generates network.har)
- \`--har-output <path>\` — Custom HAR output path

Example:
\`\`\`bash
node wally.js daemon start --url https://example.com
node wally.js daemon start --profile "Profile 9" --url https://example.com --har
\`\`\`

### Stop Recording

\`\`\`bash
node wally.js daemon stop
\`\`\`

Output:
- \`.records/<session>/actions.jsonl\` — recorded actions
- \`.records/<session>/playwright.spec.js\` — standalone Playwright test
- \`.records/<session>/network.har\` — network capture (if --har used)

### Check Status

\`\`\`bash
node wally.js daemon status
\`\`\`

### Export to Playwright

\`\`\`bash
node wally.js export
\`\`\`

Regenerates Playwright test from last recording.

### Snapshot Page

\`\`\`bash
node wally.js snap --url <url>
\`\`\`

Takes accessibility snapshot of current page.

### Execute Live Code

\`\`\`bash
node wally.js exec "return await page.title()"
node wally.js exec "await page.getByRole('button', {name: /Approve/}).click()"
node wally.js exec --page ext "return await extPage.title()"
\`\`\`

Options:
- \`--page <ext|main>\` — Target page (default: main)
- \`--timeout <ms>\` — Timeout (default: 30000)
- \`--snapshot\` — Print accessibility tree after exec
- \`--file <path>\` — Execute JS from file

## Workflow

1. Start Chrome with CDP: \`google-chrome --remote-debugging-port=9222\`
2. Run \`node wally.js daemon start --url <target>\`
3. Interact with browser and extensions (Wally records automatically)
4. Run \`node wally.js daemon stop\`
5. Find test in \`.records/<session>/playwright.spec.js\`

## What Gets Recorded

- Clicks (buttons, links, extension popups)
- Form fills (inputs, textareas)
- Navigations
- Extension interactions (\`chrome-extension://\` pages)
- Network requests (with --har flag)

## Generated Test Structure

\`\`\`javascript
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  let page = context.pages()[0];

  // Recorded actions...
  await page.getByRole('button', { name: /Connect/ }).click();
  await page.waitForTimeout(1000);

  // Extension page handling (auto-detected)
  let extPage = context.pages().find(p => p.url().startsWith('chrome-extension://'));
  if (extPage) {
    await extPage.getByRole('button', { name: /Approve/ }).click();
  }

  await browser.close();
})();
\`\`\`

## Tips

- Extension popups are auto-detected when they open
- Use \`--page ext\` in exec to target extension pages
- Password prompts in extensions are handled automatically
- Network capture (\`--har\`) is useful for API debugging
- Generated tests are standalone — run with \`node playwright.spec.js\`
`;

  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);

  console.log(`[Wally] Skill generated: ${skillDir}/SKILL.md`);
  console.log(`[Wally] Name: ${skillName}`);
  console.log(`[Wally] Compatible with: OpenCode, Claude Code, Cursor, VS Code, Gemini CLI, and 40+ agents`);
  console.log(`[Wally] Install: copy ${skillDir}/ to your agent's skills directory`);
}

/**
 * CLI entry point — parse args, dispatch to the appropriate command handler.
 * Handles --verbose flag, directory setup, and command routing.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = process.argv.slice(2);

  // Handle --verbose flag (sets WALLY_VERBOSE for logger)
  if (args.includes('--verbose')) {
    process.env.WALLY_VERBOSE = '1';
    args.splice(args.indexOf('--verbose'), 1);
  }

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
    case 'ext': await cmdExt(args.slice(1)); break;
    case 'wallet': console.log('[Wally] Deprecation: "wallet" is now "ext". Use: wally ext'); await cmdExt(args.slice(1)); break;
    case 'daemon': await cmdDaemon(args.slice(1)); break;
    case 'exec': await cmdExec(args.slice(1)); break;
    case 'create-skill': await cmdCreateSkill(args.slice(1)); break;
    case undefined:
    case 'interactive':
      await cmdInteractive();
      break;
    default:
      console.log(`
Wally — Browser & Extension Interaction Recorder

Commands:
  wally                          Interactive menu (record / play)
  wally record                   Start recording (asks URL/profile, uses daemon)
  wally record start             Legacy single-page recording (polls clicks/fills)
  wally record stop              Stop legacy single-page recording
  wally play [N]                 Replay saved record (interactive selector)
  wally list                     List records in .records/
  wally snap [--url <url>]       Snapshot current page
  wally export [--output <file>] [--from <dir>]  Export recorded actions → Playwright test
  wally daemon start [--url <url>] [--profile <name>] [--har] [--har-output <path>]  Background recording
  wally daemon stop              Stop daemon
  wally daemon status            Show active pages + action counts
  wally exec "<code>" [--page <ext|main>] [--snapshot] [--timeout <ms>] [--file <path>]  Execute Playwright JS live
  wally create-skill [-c] [session-id]  Generate Agent Skill from recorded session

record vs daemon:
  Both record browser interactions, but serve different use cases:

  record (default) — Interactive single-page recording.
    Prompts for URL/profile, then records the current page.
    Best for quick, one-off recordings of a single page.

  daemon — Background multi-page recording.
    Records ALL pages including extension popups (chrome-extension://).
    Supports --har for network capture, --profile for Chrome profiles.
    Runs as a background process (detached PID), persists across navigations.
    Best for extension workflows, multi-tab flows, or long recording sessions.

  In practice, "wally record" (without start/stop) delegates to daemon mode.
  Use "wally record start/stop" only for the legacy single-page recorder.

Options:
  --verbose              Enable debug logging (WALLY_VERBOSE=1)
  --profile <name>       Chrome profile (default: "Profile 9")
  --url <url>            Navigate to URL
  --har                  Enable network capture (daemon)
  --har-output <path>    HAR output path

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
