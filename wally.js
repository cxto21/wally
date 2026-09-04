/**
 * Wally — DVX Workflow Recorder + Snapshot Tool
 *
 * Built on libretto's MIT primitives (saffron-health/libretto)
 *   - Accessibility snapshot via CDP
 *   - actions.jsonl recording format
 *   - Network capture
 *   - Multi-page daemon (records extension popups, wallet flows)
 *
 * Usage:
 *   node wally.js snap                          — snapshot current page
 *   node wally.js snap --url https://ownerz.pages.dev  — navigate + snapshot
 *   node wally.js record start                  — start recording actions
 *   node wally.js record stop                   — stop + show actions
 *   node wally.js export                        — export actions → Playwright test
 *   node wally.js daemon start                  — start background multi-page recording
 *   node wally.js daemon stop                   — stop daemon + show summary
 *   node wally.js daemon status                 — show active pages + action counts
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
// SNAPSHOT — libretto MIT primitive
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

  // Wait for CDP to become available
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    const check = await checkCDP();
    if (check.ok) {
      console.log('[Wally] Chrome CDP ready.');
      return true;
    }
  }
  console.log('[Wally] Chrome started but CDP not ready. Try again in a few seconds.');
  return false;
}

function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => {
      resolve(data.trim() || 'Y');
    });
  });
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
  // Support both 'recording' and 'daemon-*' session dirs
  let sessionDir = path.join(SESSIONS_DIR, 'recording');
  let actionsFile = path.join(sessionDir, 'actions.jsonl');

  // If no recording session, find latest daemon session
  if (!fs.existsSync(actionsFile) || fs.statSync(actionsFile).size === 0) {
    const daemonSessions = fs.readdirSync(SESSIONS_DIR)
      .filter(d => d.startsWith('daemon-'))
      .sort()
      .reverse();
    if (daemonSessions.length > 0) {
      sessionDir = path.join(SESSIONS_DIR, daemonSessions[0]);
      actionsFile = path.join(sessionDir, 'actions.jsonl');
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
  for (const action of actions) {
    if (action.page && action.page.startsWith('ext:')) {
      // Extract extension ID from page label (format: "ext:dlcobpji")
      const match = action.page.match(/ext:(.+)/);
      if (match) detectedExtId = match[1];
      break;
    }
  }

  let test = `/**
 * Auto-generated by Wally (built on libretto MIT primitives)
 * Recorded: ${actions[0]?.ts || new Date().toISOString()}
 * Actions: ${actions.length}
 * Pages: ${Array.from(pages.keys()).join(', ')}
 * Extension: ${detectedExtId ? 'detected (' + detectedExtId + ')' : 'none detected'}
 */
const { chromium } = require('playwright');

const CDP_URL = '${CDP_URL}';

describe('DVX Workflow', () => {
  let browser, context, page;

  beforeAll(async () => {
    browser = await chromium.connectOverCDP(CDP_URL);
    const contexts = browser.contexts();
    context = contexts.find(c => c.pages().length > 0) || contexts[0];
    // Find main page (not an extension)
    page = context.pages().find(p => !p.url().startsWith('chrome-extension://')) || context.pages()[0];
  });

  afterAll(async () => { try { browser.close(); } catch {} });

  it('replays recorded workflow', async () => {
`;

  let lastPage = 'main';

  for (const action of actions) {
    const actionPage = action.page || 'main';

    // If switching to extension page, add page switch logic
    if (actionPage !== lastPage && actionPage.startsWith('ext:')) {
      test += `\n    // Switch to extension page (any chrome-extension:// URL)\n`;
      test += `    let extPage = context.pages().find(p => p.url().startsWith('chrome-extension://'));\n`;
      test += `    if (!extPage) {\n`;
      test += `      // Wait for extension to open\n`;
      test += `      for (let i = 0; i < 15; i++) {\n`;
      test += `        extPage = context.pages().find(p => p.url().startsWith('chrome-extension://'));\n`;
      test += `        if (extPage) break;\n`;
      test += `        await page.waitForTimeout(1000);\n`;
      test += `      }\n`;
      test += `    }\n`;
      test += `    if (extPage) {\n`;
      test += `      await extPage.waitForLoadState('domcontentloaded').catch(() => {});\n`;
      test += `      await extPage.waitForTimeout(2000);\n`;
      lastPage = actionPage;
    } else if (actionPage !== lastPage && actionPage === 'main') {
      test += `\n    // Switch back to main page\n`;
      test += `    page = context.pages().find(p => !p.url().startsWith('chrome-extension://')) || context.pages()[0];\n`;
      lastPage = actionPage;
    }

    const indent = (lastPage !== 'main' && lastPage.startsWith('ext:')) ? '      ' : '    ';

    if (action.type === 'navigate') {
      test += `${indent}await page.goto('${action.url}', { waitUntil: 'networkidle', timeout: 30000 });\n`;
      test += `${indent}await page.waitForTimeout(3000);\n`;
    } else if (action.type === 'click') {
      const sel = action.selector;
      const target = (lastPage.startsWith('ext:') && lastPage !== 'main') ? 'extPage' : 'page';
      if (sel.startsWith('[data-testid=') || sel.startsWith('#') || sel.startsWith('[aria-label=')) {
        test += `${indent}await ${target}.locator('${sel}').click({ force: true, timeout: 5000 });\n`;
      } else if (sel.startsWith('button "') || sel.startsWith('link "')) {
        // Text-based selector
        const text = sel.match(/"(.+)"/)?.[1] || sel;
        const role = sel.split(' ')[0];
        test += `${indent}await ${target}.getByRole('${role}', { name: /${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/i }).first().click({ timeout: 5000 });\n`;
      } else {
        test += `${indent}await ${target}.getByRole('${sel}').first().click({ timeout: 5000 });\n`;
      }
      test += `${indent}await page.waitForTimeout(1000);\n`;
    } else if (action.type === 'fill') {
      const escaped = (action.value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const target = (lastPage.startsWith('ext:') && lastPage !== 'main') ? 'extPage' : 'page';
      test += `${indent}await ${target}.locator('${action.selector}').fill('${escaped}');\n`;
      test += `${indent}await page.waitForTimeout(500);\n`;
    } else if (action.type === 'wallet_connect') {
      const walletType = action.walletType || 'unknown';
      test += `${indent}// Wallet connected: ${walletType} (${action.account || 'unknown'})\n`;
      test += `${indent}await page.waitForTimeout(2000);\n`;
    }

    // Close extension block if next action is on main page
    const nextAction = actions[actions.indexOf(action) + 1];
    if (nextAction && lastPage.startsWith('ext:') && (nextAction.page || 'main') === 'main') {
      test += `    }\n\n`;
    }
  }

  // Close any open extension block
  if (lastPage.startsWith('ext:')) {
    test += `    }\n`;
  }

  test += `    expect(page.url()).toBeDefined();\n`;
  test += `  });\n});\n`;

  const outputPath = path.resolve(outputFile);
  fs.writeFileSync(outputPath, test);
  console.log(`[Wally] Exported ${actions.length} actions → ${outputPath}`);
  console.log(`[Wally] Pages: ${Array.from(pages.keys()).join(', ')}`);
  if (detectedExtId) console.log(`[Wally] Extension detected: ${detectedExtId}`);
  console.log(`[Wally] Run: npx playwright test ${outputPath}`);

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

async function cmdDaemon(args) {
  const sub = args[0];
  const { WallyDaemon } = require('./lib/daemon');

  if (sub === 'start') {
    const url = getArg(args, '--url');
    const profile = getArg(args, '--profile') || CHROME_DEFAULT_PROFILE;

    // Ensure Chrome CDP is available
    const ok = await ensureCDP(profile, url);
    if (!ok) return;

    const daemon = new WallyDaemon();
    await daemon.start({ url });
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
  node wally.js daemon start [--url <url>] [--profile <name>]   Start recording
  node wally.js daemon stop                                      Stop daemon
  node wally.js daemon status                                    Show pages + actions

Options:
  --url <url>       Navigate to URL before recording
  --profile <name>  Chrome profile to use (default: "Profile 9")

If Chrome CDP is not running, Wally will ask to launch it automatically.

Examples:
  node wally.js daemon start                          Record current page
  node wally.js daemon start --url https://avnu.fi   Navigate + record
  node wally.js daemon start --profile "Profile 1"   Use different profile
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

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const sub = args[1];

  fs.mkdirSync(WALLY_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(RECORDS_DIR, { recursive: true });

  switch (cmd) {
    case 'snap': await cmdSnap(args.slice(1)); break;
    case 'record': await cmdRecord(args.slice(1)); break;
    case 'export': await cmdExport(args.slice(1)); break;
    case 'wallet': await cmdWallet(args.slice(1)); break;
    case 'daemon': await cmdDaemon(args.slice(1)); break;
    default:
      console.log(`
Wally — DVX Workflow Recorder
Built on libretto MIT primitives (saffron-health/libretto)

Commands:
  node wally.js snap [--url <url>]          Snapshot current page (or navigate + snapshot)
  node wally.js record start               Start recording clicks + navigations
  node wally.js record stop                Stop recording, take final snapshot
  node wally.js export [--output <file>]   Export recorded actions → Playwright test
  node wally.js wallet                     Connect wallet via starknet.enable() + handle Ready extension
  node wally.js daemon start               Start background multi-page recording
  node wally.js daemon stop                Stop daemon + show summary
  node wally.js daemon status              Show active pages + action counts

Options:
  --profile <name>  Chrome profile (default: "Profile 9")
  --url <url>       Navigate to URL

CDP: ${CDP_URL}
Sessions: ${SESSIONS_DIR} (tmp, locks)
Records:  ${RECORDS_DIR}/<sessionId>/ (clean: actions.jsonl + playwright.spec.js)
`);
  }
}

main().catch(err => {
  console.error(`[Wally] Error: ${err.message}`);
  process.exit(1);
});
