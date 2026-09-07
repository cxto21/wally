/**
 * Wally Daemon — background multi-page recorder
 *
 * Monitors Chrome via CDP Target discovery.
 * Automatically attaches to new pages (extensions, popups) and records actions.
 *
 * Usage:
 *   node wally.js daemon start    — start background recording
 *   node wally.js daemon stop     — stop recording, show summary
 *   node wally.js daemon status   — show active pages + action counts
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  PRE_NAVIGATE_SCRIPT,
  injectRecordingListeners,
  readActions,
  isExtensionUrl,
  getPageLabel,
} = require('./recorder');
const {
  attachNetworkCapture,
  parseNetworkLog,
  generateHAR,
  writeHAR,
} = require('./network');

const CDP_URL = 'http://127.0.0.1:9222';
const WALLY_DIR = '/tmp/opencode/wally';
const SESSIONS_DIR = path.join(WALLY_DIR, 'sessions');
const RECORDS_DIR = path.join(__dirname, '..', '.records');
const DAEMON_PID_FILE = path.join(WALLY_DIR, 'daemon.pid');
const DAEMON_STATE_FILE = path.join(WALLY_DIR, 'daemon-state.json');


//
// Structured logging utility
const log = {
  info: function(message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: "info",
      daemon: "WallyDaemon",
      ...data,
      message
    };
    console.log(JSON.stringify(entry));
  },
  warn: function(message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: "warn",
      daemon: "WallyDaemon",
      ...data,
      message
    };
    console.warn(JSON.stringify(entry));
  },
  error: function(message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: "error",
      daemon: "WallyDaemon",
      ...data,
      message
    };
    console.error(JSON.stringify(entry));
  }
};


class WallyDaemon {
  constructor() {
    this.browser = null;
    this.cdp = null;
    this.pages = new Map(); // targetId → { page, cdpSession, url, label, actionsCount }
    this.poll = null;
    this.actionsFile = null;
    this.sessionDir = null;
    this.running = false;
    // Network capture
    this.enableHar = false;
    this.networkFile = null;
    this.harOutput = null;
    this.networkSessions = new Map(); // targetId -> { cdpSession, cleanup }
  }

  async start(options = {}) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.sessionDir = path.join(SESSIONS_DIR, 'record-' + Date.now());
    fs.mkdirSync(path.join(this.sessionDir, 'snapshots'), { recursive: true });
    this.actionsFile = path.join(this.sessionDir, 'actions.jsonl');
    fs.writeFileSync(this.actionsFile, '');
    // Network capture setup
    this.enableHar = !!options.har;
    if (this.enableHar) {
      this.networkFile = options.harOutput ? path.resolve(options.harOutput) : path.join(this.sessionDir, 'network.jsonl');
      // If harOutput is a har file path, derive jsonl alongside
      if (this.networkFile.endsWith('.har')) {
        this.harOutput = this.networkFile;
        this.networkFile = this.networkFile.replace(/\.har$/, '.jsonl');
      } else if (options.harOutput) {
        this.harOutput = path.join(path.dirname(this.networkFile), 'network.har');
      } else {
        this.harOutput = path.join(this.sessionDir, 'network.har');
      }
      fs.writeFileSync(this.networkFile, '');
      console.log(`[Wally Daemon] Network capture enabled → ${this.networkFile}`);
    }

    // Save PID
    fs.writeFileSync(DAEMON_PID_FILE, String(process.pid));

    console.log('[Wally Daemon] Starting...');
    console.log(`[Wally Daemon] Session: ${this.sessionDir}`);

    // Connect to Chrome via CDP
    this.browser = await chromium.connectOverCDP(CDP_URL);
    const ctx = this.browser.contexts()[0];
    if (!ctx) {
      console.error('[Wally Daemon] No browser context found');
      process.exit(1);
    }

    // Navigate to URL if provided
    if (options.url) {
      console.log(`[Wally Daemon] Navigating to: ${options.url}`);
      const page = ctx.pages()[0];
      await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);
    }

    // Get browser-level CDP session for Target discovery
    const page = ctx.pages()[0];
    this.cdp = await ctx.newCDPSession(page);

    // Enable Target discovery
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });

    // Listen for new targets
    this.cdp.on('Target.targetCreated', (event) => this.onTargetCreated(event));
    this.cdp.on('Target.targetDestroyed', (event) => this.onTargetDestroyed(event));
    this.cdp.on('Target.targetInfoChanged', (event) => this.onTargetInfoChanged(event));

    // Attach to existing pages
    const existingTargets = await this.cdp.send('Target.getTargets');
    for (const target of existingTargets.targetInfos) {
      if (target.type === 'page') {
        await this.attachToTarget(target.targetId, target.url);
      }
    }

    // Start polling for actions
    this.running = true;
    this.poll = setInterval(() => this.pollActions(), 500);
    // Discovery: detect pages opened directly (e.g. extension from toolbar)
    this.discovery = setInterval(() => this.discoverPages(), 2000);

    // Save state
    this.saveState();

    console.log(`[Wally Daemon] Recording started. ${this.pages.size} pages attached.`);
    console.log(`[Wally Daemon] Actions: ${this.actionsFile}`);
    console.log('[Wally Daemon] Interact with the browser. Run "node wally.js daemon stop" when done.');

    // Keep process alive
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  async stop() {
    if (!this.running) return;
    this.running = false;

    if (this.poll) clearInterval(this.poll);
    if (this.discovery) clearInterval(this.discovery);

    console.log('\n[Wally Daemon] Stopping...');

    // Final poll
    await this.pollActions();

    // Detach from all pages
    for (const [targetId, info] of this.pages) {
      try {
        if (info.cdpSession) await info.cdpSession.detach();
      } catch {}
    }

    // Detach network sessions
    for (const [targetId, net] of this.networkSessions) {
      try { net.cleanup && await net.cleanup(); } catch {}
      try { net.cdpSession && await net.cdpSession.detach().catch(() => {}); } catch {}
    }
    this.networkSessions.clear();

    // Generate HAR if network capture enabled
    if (this.enableHar && this.networkFile && fs.existsSync(this.networkFile)) {
      try {
        const events = parseNetworkLog(this.networkFile);
        const har = generateHAR(events);
        const harPath = this.harOutput || path.join(this.sessionDir, 'network.har');
        writeHAR(har, harPath);
        console.log(`[Wally Daemon] Network HAR generated: ${harPath} (${har.log.entries.length} entries)`);
        // Also generate requests.json summary
        const summary = har.log.entries.map(e => ({
          url: e.request.url,
          method: e.request.method,
          status: e.response.status,
          mimeType: e.response.content.mimeType,
          time: e.time,
        }));
        const summaryPath = path.join(this.sessionDir, 'requests.json');
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
      } catch (e) {
        console.log(`[Wally Daemon] HAR generation failed: ${e.message}`);
      }
    }

    // Take final snapshot of main page
    try {
      const ctx = this.browser.contexts()[0];
      const mainPage = ctx.pages().find(p => !isExtensionUrl(p.url()));
      if (mainPage) {
        const snap = await this.takeSnapshot(mainPage);
        fs.writeFileSync(
          path.join(this.sessionDir, 'snapshots', 'final.json'),
          JSON.stringify(snap, null, 2)
        );
      }
    } catch {}

    // Count total actions
    const lines = fs.existsSync(this.actionsFile)
      ? fs.readFileSync(this.actionsFile, 'utf8').trim().split('\n').filter(Boolean)
      : [];

    console.log(`[Wally Daemon] Recording stopped.`);
    console.log(`[Wally Daemon] Total actions: ${lines.length}`);
    console.log(`[Wally Daemon] Pages tracked: ${this.pages.size}`);
    console.log(`[Wally Daemon] Session: ${this.sessionDir}`);

    // Copy clean record to .records/<sessionId>/ for visibility + auto-generate playwright
    try {
      const sessionId = path.basename(this.sessionDir);
      const cleanDir = path.join(RECORDS_DIR, sessionId);
      fs.mkdirSync(cleanDir, { recursive: true });
      if (fs.existsSync(this.actionsFile)) {
        fs.copyFileSync(this.actionsFile, path.join(cleanDir, 'actions.jsonl'));
      }
      const snapSrc = path.join(this.sessionDir, 'snapshots');
      if (fs.existsSync(snapSrc)) {
        const snapDst = path.join(cleanDir, 'snapshots');
        fs.mkdirSync(snapDst, { recursive: true });
        for (const f of fs.readdirSync(snapSrc)) {
          try { fs.copyFileSync(path.join(snapSrc, f), path.join(snapDst, f)); } catch {}
        }
      }
      // Copy network files if --har was enabled
      if (this.enableHar) {
        const netSrc = this.networkFile && fs.existsSync(this.networkFile) ? this.networkFile : path.join(this.sessionDir, 'network.jsonl');
        if (fs.existsSync(netSrc)) {
          try { fs.copyFileSync(netSrc, path.join(cleanDir, 'network.jsonl')); } catch {}
        }
        const harSrc = this.harOutput && fs.existsSync(this.harOutput) ? this.harOutput : path.join(this.sessionDir, 'network.har');
        if (fs.existsSync(harSrc)) {
          try { fs.copyFileSync(harSrc, path.join(cleanDir, 'network.har')); } catch {}
        }
        const reqSrc = path.join(this.sessionDir, 'requests.json');
        if (fs.existsSync(reqSrc)) {
          try { fs.copyFileSync(reqSrc, path.join(cleanDir, 'requests.json')); } catch {}
        }
        // Also copy if generated at networkFile location custom harOutput
        const harAtSession = path.join(this.sessionDir, 'network.har');
        if (harAtSession !== harSrc && fs.existsSync(harAtSession)) {
          try { fs.copyFileSync(harAtSession, path.join(cleanDir, 'network.har')); } catch {}
        }
      }
      // Auto-generate playwright.spec.js (standalone, node runnable)
      try {
        const actions = lines.map(l => JSON.parse(l));
        const pages = new Map();
        for (const a of actions) {
          const lbl = a.page || 'main';
          if (!pages.has(lbl)) pages.set(lbl, []);
          pages.get(lbl).push(a);
        }
        let detectedExtFullId = null;
        for (const a of actions) {
          if (a.url && a.url.includes('chrome-extension://')) {
            const m = a.url.match(/chrome-extension:\/\/([a-z]+)/);
            if (m) { detectedExtFullId = m[1]; break; }
          }
        }
        let test = `/**\n * Auto-generated by Wally\n * Recorded: ${actions[0]?.ts || new Date().toISOString()}\n * Actions: ${actions.length}\n * Pages: ${Array.from(pages.keys()).join(', ')}\n * Run: node playwright.spec.js\n */\nconst { chromium } = require('playwright');\nconst assert = require('assert');\nconst CDP_URL = '${CDP_URL}';\n(async () => {\n  const browser = await chromium.connectOverCDP(CDP_URL);\n  const contexts = browser.contexts();\n  const context = contexts.find(c => c.pages().length > 0) || contexts[0];\n  let page = context.pages().find(p => !p.url().startsWith('chrome-extension://')) || context.pages()[0];\n  let extPage = context.pages().find(p => p.url().startsWith('chrome-extension://'));\n`;
        let lastPage = 'main';
        for (const action of actions) {
          const ap = action.page || 'main';
          if (ap !== lastPage && ap.startsWith('ext:')) {
            test += `\n  extPage = context.pages().find(p => p.url().startsWith('chrome-extension://'));\n  if (!extPage) { for (let i=0;i<15;i++){ extPage = context.pages().find(p => p.url().startsWith('chrome-extension://')); if(extPage)break; await page.waitForTimeout(1000);} }\n`;
            if (detectedExtFullId) {
              test += `  if (!extPage) { extPage = await context.newPage(); await extPage.goto('chrome-extension://${detectedExtFullId}/index.html', {waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{}); await extPage.waitForTimeout(2000); }\n`;
            }
            test += `  if (extPage) {\n    await extPage.bringToFront().catch(()=>{});\n    await extPage.waitForLoadState('domcontentloaded').catch(()=>{});\n    await extPage.waitForTimeout(1500);\n    console.log('[Wally] Extension visible:', extPage.url());\n`;
            lastPage = ap;
          } else if (ap !== lastPage && !ap.startsWith('ext:')) {
            test += `\n  page = context.pages().find(p => !p.url().startsWith('chrome-extension://')) || context.pages()[0];\n  await page.bringToFront().catch(()=>{});\n`;
            lastPage = ap;
          }
          const isExtAction = action.page && action.page.startsWith('ext:');
          const indent = isExtAction ? '    ' : '  ';
          if (action.type === 'navigate') {
            const navTarget = isExtAction ? 'extPage' : 'page';
            test += `${indent}await ${navTarget}.goto('${action.url}', {waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});\n${indent}await ${navTarget}.waitForTimeout(2000);\n`;
          } else if (action.type === 'click') {
            const sel = action.selector; const target = isExtAction ? 'extPage' : 'page';
            if (sel.includes('password')) {
              test += `${indent}{ const _pw=${target}.locator('${sel}').first(); if(await _pw.isVisible().catch(()=>false)) await _pw.click({force:true,timeout:5000}); else console.log('[Wally] Skip password click not visible'); }\n`;
            } else if (sel.startsWith('[data-testid=') || sel.startsWith('#') || sel.startsWith('[aria-label=')) {
              test += `${indent}{ const _el=${target}.locator('${sel}').first(); if(await _el.isVisible().catch(()=>false)) await _el.click({force:true,timeout:5000}); else console.log('[Wally] Skip not visible: ${sel}'); }\n`;
            } else if (sel.startsWith('button "') || sel.startsWith('link "')) {
              const text = sel.match(/"(.+)"/)?.[1] || sel; const role = sel.split(' ')[0];
              const isOptional = /^(OK|Close|Cancel|Dismiss|Bridge)$/i.test(text.trim());
              if (isOptional) {
                const v = `_b${Math.random().toString(36).substring(2,4)}`;
                test += `${indent}{ const ${v}=${target}.getByRole('${role}', {name:/${text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/i}).first(); if(await ${v}.isVisible().catch(()=>false)) { try { await ${v}.click({timeout:10000}); } catch(e) { console.log('[Wally] Click failed (continuing):', e.message.split(String.fromCharCode(10))[0]); } } else console.log('[Wally] Skip optional button not visible: ' + ${JSON.stringify(text)}); }\n`;
              } else {
                const v2 = `_b${Math.random().toString(36).substring(2,4)}`;
                test += `${indent}{ const ${v2}=${target}.getByRole('${role}', {name:/${text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/i}).first(); if(await ${v2}.isVisible().catch(()=>false)) { try { await ${v2}.click({timeout:10000}); } catch(e) { console.log('[Wally] Click failed (continuing):', e.message.split(String.fromCharCode(10))[0]); } } else console.log('[Wally] Skip button not visible: ' + ${JSON.stringify(text)}); }\n`;
              }
            } else if (sel.includes(' > ') || sel.includes(':nth-child') || sel.startsWith('div') || sel.startsWith('span') || sel.startsWith('p')) {
              const txt = action.text||''; const isWallet = ['Ready','Argent','Wallet'].some(k=>txt.includes(k));
              const isErrorOverlay = txt.includes('Contrase') || txt.includes('Loading') || txt.includes('Bloq May') || txt.includes('Desbloque');
              const isTextOnly = (sel==='p' || sel.endsWith(' > p') || (sel.endsWith(' > span') && !sel.includes('button'))) && txt.length>15 && !isWallet;
              if (isTextOnly || isErrorOverlay) test += `${indent}// Skipped: ${sel} "${txt.substring(0,30).replace(/\n/g,' ')}"\n`;
              else if (isWallet && txt) {
                const esc = txt.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').substring(0,30);
                const v = `_w${Math.random().toString(36).substring(2,6)}`;
                test += `${indent}{ const ${v}=${target}.getByText(/${esc}/i).first(); if(await ${v}.isVisible().catch(()=>false)) { try { await ${v}.click({force:true,timeout:10000}); } catch(e) { console.log('[Wally] Wallet click failed (continuing):', e.message.split(String.fromCharCode(10))[0]); } } else console.log('[Wally] Skip wallet not visible: ' + ${JSON.stringify(esc)}); }\n`;
              } else test += `${indent}{ const _el=${target}.locator('${sel}').first(); if(await _el.isVisible().catch(()=>false)) await _el.click({force:true,timeout:10000}); else console.log('[Wally] Skip not visible: ${sel}'); }\n`;
            } else if (sel.startsWith('input[') || sel.startsWith('textarea[')) {
              test += `${indent}{ const _inp=${target}.locator('${sel}').first(); if(await _inp.isVisible().catch(()=>false)) { try { await _inp.click({force:true,timeout:10000}); } catch(e) { console.log('[Wally] Input click failed (continuing):', e.message.split(String.fromCharCode(10))[0]); } } else { console.log('[Wally] Skip input not visible: ${sel}'); } }\n`;
            } else {
              test += `${indent}{ const _el=${target}.locator('${sel}').first(); if(await _el.isVisible().catch(()=>false)) { try { await _el.click({force:true,timeout:10000}); } catch(e) { console.log('[Wally] Click failed (continuing):', e.message.split(String.fromCharCode(10))[0]); } } else { console.log('[Wally] Skip not visible: ${sel}'); } }\n`;
            }
            test += `${indent}await page.waitForTimeout(1000);\n`;
          } else if (action.type === 'fill') {
            const esc = (action.value||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
            const target = (lastPage.startsWith('ext:') ? 'extPage' : 'page');
            test += `${indent}{ const _fill=${target}.locator('${action.selector}').first(); if(await _fill.isVisible().catch(()=>false)) { try { await _fill.fill('${esc}'); } catch(e) { console.log('[Wally] Fill failed (continuing):', e.message.split(String.fromCharCode(10))[0]); } } else { console.log('[Wally] Skip fill not visible: ${action.selector}'); } }\n${indent}await page.waitForTimeout(500);\n`;
          }
          const next = actions[actions.indexOf(action)+1];
          const nextPage = next ? (next.page || 'main') : null;
          if (next && lastPage.startsWith('ext:') && nextPage && !nextPage.startsWith('ext:')) test += `  }\n\n`;
        }
        if (lastPage.startsWith('ext:')) test += `  }\n`;
        test += `  console.log('[Wally] Replay done:', page.url());\n  if(extPage) await extPage.bringToFront().catch(()=>{}); else await page.bringToFront().catch(()=>{});\n  await page.waitForTimeout(8000);\n  await browser.close();\n})().catch(e=>{console.error(e);process.exit(1);});\n`;
        fs.writeFileSync(path.join(cleanDir, 'playwright.spec.js'), test);
        console.log(`[Wally Daemon] Playwright: ${cleanDir}/playwright.spec.js`);
      } catch (e) { console.log('[Wally] Playwright gen failed:', e.message); }
      console.log(`[Wally Daemon] Clean record: ${cleanDir}/`);
      console.log(`[Wally Daemon]   → actions.jsonl + snapshots/ + playwright.spec.js`);
    } catch (e) {
      console.log(`[Wally] Clean copy failed: ${e.message}`);
    }

    // Clean up PID file
    try { fs.unlinkSync(DAEMON_PID_FILE); } catch {}
    try { fs.unlinkSync(DAEMON_STATE_FILE); } catch {}

    // Detach browser (don't close Chrome)
    try { this.browser.close(); } catch {}

    process.exit(0);
  }

  async onTargetCreated(event) {
    const { targetInfo } = event;
    // Handle both pages AND iframes (extensions use iframes for popups/dropdowns)
    if (targetInfo.type !== 'page' && targetInfo.type !== 'iframe') return;
    if (this.pages.has(targetInfo.targetId)) return;

    // Small delay to let the page initialize
    await new Promise(r => setTimeout(r, 500));

    await this.attachToTarget(targetInfo.targetId, targetInfo.url);
  }

  onTargetDestroyed(event) {
    const info = this.pages.get(event.targetId);
    if (info) {
      console.log(`[Wally Daemon] Page closed: ${info.label} (${info.url})`);
      this.pages.delete(event.targetId);
      // Cleanup network session if exists
      // Record page close action
      if (this.actionsFile) {
        const closeAction = {
          ts: new Date().toISOString(),
          type: "page_close",
          url: info.url,
          page: info.label,
        };
        fs.appendFileSync(this.actionsFile, JSON.stringify(closeAction) + "\n");
      }
      const net = this.networkSessions.get(event.targetId);
      if (net) {
        try { net.cleanup && net.cleanup(); } catch {}
        try { net.cdpSession && net.cdpSession.detach().catch(() => {}); } catch {}
        this.networkSessions.delete(event.targetId);
      }
      this.saveState();
    }
  }

  onTargetInfoChanged(event) {
    const info = this.pages.get(event.targetInfo.targetId);
    if (info) {
      info.url = event.targetInfo.url;
      info.label = getPageLabel(event.targetInfo.url);
    }
  }

  async attachToTarget(targetId, url) {
    try {
      const label = getPageLabel(url);
      console.log(`[Wally Daemon] Attaching to: ${label} (${url.substring(0, 60)})`);

      // Attach to target
      const { sessionId } = await this.cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });

      // Create a CDP session for this target
      const session = await this.cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });

      // Get the Playwright page for this target
      const ctx = this.browser.contexts()[0];
      let targetPage = null;

      // Try to find by URL
      for (const p of ctx.pages()) {
        if (p.url() === url || p.url().includes(url.substring(0, 30))) {
          targetPage = p;
          break;
        }
      }

      // If not found, wait and retry
      if (!targetPage) {
        await new Promise(r => setTimeout(r, 1000));
        for (const p of ctx.pages()) {
          if (p.url().includes(url.substring(0, 20)) || isExtensionUrl(p.url())) {
            targetPage = p;
            break;
          }
        }
      }

      if (targetPage) {
        // For extension pages, use CDP directly to bypass CSP
        // This injects into main frame AND all iframes
        if (isExtensionUrl(url)) {
          await this.injectViaCDP(targetPage, sessionId);
        } else {
          // Inject recording listeners for normal pages
          await injectRecordingListeners(targetPage);
        }

        this.pages.set(targetId, {
          page: targetPage,
          sessionId,
          url,
          label,
          actionsCount: 0,
          isIframe: false,
        });

        console.log(`[Wally Daemon] Attached + recording: ${label}`);

        // Enable Network capture for this page if --har
        if (this.enableHar && this.networkFile) {
          try {
            const netSession = await targetPage.context().newCDPSession(targetPage);
            const cleanup = await attachNetworkCapture(netSession, this.networkFile);
            this.networkSessions.set(targetId, { cdpSession: netSession, cleanup });
            console.log(`[Wally Daemon] Network capture enabled for ${label}`);
          } catch (e) {
            console.log(`[Wally Daemon] Network capture failed for ${label}: ${e.message}`);
          }
        }
      } else {
        // Iframe might not have a matching page — store by targetId for polling
        // The iframe's parent page will collect its actions
        console.log(`[Wally Daemon] Iframe detected: ${label} (${url.substring(0, 60)})`);
        this.pages.set(targetId, {
          page: null, // Will be resolved via parent page's frames
          sessionId,
          url,
          label,
          actionsCount: 0,
          isIframe: true,
          parentId: null,
        });
      }

      this.saveState();
    } catch (e) {
      console.log(`[Wally Daemon] Attach failed for ${url}: ${e.message}`);
    }
  }

  /**
   * Inject recording script via CDP Runtime.evaluate (bypasses CSP).
   * Also injects into all frames (iframes within extension pages).
   */
  async injectViaCDP(page, sessionId) {
    const { RECORDING_SCRIPT } = require('./recorder');
    const isExt = isExtensionUrl(page.url());
    try {
      // Inject into main frame
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Runtime.evaluate', {
        expression: RECORDING_SCRIPT,
        includeCommandLineAPI: false,
      });

      // For extension pages: also init localStorage and patch to persist actions there
      // (window.__wally_actions is lost on navigation, localStorage survives)
      if (isExt) {
        await cdp.send('Runtime.evaluate', {
          expression: `
            if (!localStorage.getItem('wally_actions')) localStorage.setItem('wally_actions', '[]');
            // Patch __wally_actions push to also write to localStorage
            const _origPush = window.__wally_actions.push.bind(window.__wally_actions);
            window.__wally_actions.push = function(...args) {
              _origPush(...args);
              try {
                const stored = JSON.parse(localStorage.getItem('wally_actions') || '[]');
                stored.push(...args);
                localStorage.setItem('wally_actions', JSON.stringify(stored));
              } catch {}
            };
          `,
        });
        console.log(`[Wally Daemon] Injected recording script via CDP (main frame) + localStorage bridge`);
      } else {
        console.log(`[Wally Daemon] Injected recording script via CDP (main frame)`);
      }

      // Also inject into all iframes/frames within this page
      const frames = page.frames();
      for (const frame of frames) {
        if (frame === page.mainFrame()) continue;
        try {
          await frame.evaluate(RECORDING_SCRIPT);
          console.log(`[Wally Daemon] Injected into frame: ${frame.url().substring(0, 60)}`);
        } catch {
          // Frame might have CSP too — try CDP
          try {
            const frameCdp = await page.context().newCDPSession(page);
            // Get frame ID
            const { frameTree } = await frameCdp.send('Page.getFrameTree');
            const findFrame = (tree, url) => {
              if (tree.frame.url === url) return tree.frame.id;
              for (const child of tree.childFrames || []) {
                const found = findFrame(child, url);
                if (found) return found;
              }
              return null;
            };
            const frameId = findFrame(frameTree, frame.url());
            if (frameId) {
              await frameCdp.send('Runtime.evaluate', {
                expression: RECORDING_SCRIPT,
                contextId: undefined, // Will use default context
              });
            }
          } catch {}
        }
      }
    } catch (e) {
      console.log(`[Wally Daemon] CDP inject failed: ${e.message}`);
    }
  }

  /**
   * Read actions from a page via CDP (for extension pages where page.evaluate fails).
   * Also reads from all frames within the page.
   */
  async readActionsViaCDP(page) {
    const allActions = [];
    const isExt = isExtensionUrl(page.url());

    // Read from main frame (atomic read+clear for localStorage)
    try {
      const cdp = await page.context().newCDPSession(page);
      if (isExt) {
        const result = await cdp.send('Runtime.evaluate', {
          expression: `(function(){ var a=localStorage.getItem('wally_actions'); localStorage.setItem('wally_actions','[]'); return a||'[]'; })()`,
          returnByValue: true,
        });
        allActions.push(...JSON.parse(result.result.value || '[]'));
      } else {
        const result = await cdp.send('Runtime.evaluate', {
          expression: 'JSON.stringify(window.__wally_actions || [])',
          returnByValue: true,
        });
        await cdp.send('Runtime.evaluate', {
          expression: 'window.__wally_actions = []',
        });
        allActions.push(...JSON.parse(result.result.value || '[]'));
      }
    } catch {}

    // Read from all frames
    const frames = page.frames();
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      try {
        const actions = await frame.evaluate(() => {
          const a = window.__wally_actions || [];
          window.__wally_actions = [];
          return a;
        });
        allActions.push(...actions);
      } catch {
        // Frame might have CSP — try CDP
        try {
          const cdp = await page.context().newCDPSession(page);
          const { frameTree } = await cdp.send('Page.getFrameTree');
          const findFrame = (tree, url) => {
            if (tree.frame.url === url) return tree.frame.id;
            for (const child of tree.childFrames || []) {
              const found = findFrame(child, url);
              if (found) return found;
            }
            return null;
          };
          const frameId = findFrame(frameTree, frame.url());
          if (frameId) {
            if (isExt) {
              const result = await cdp.send('Runtime.evaluate', {
                expression: `(function(){ var a=localStorage.getItem('wally_actions'); localStorage.setItem('wally_actions','[]'); return a||'[]'; })()`,
                returnByValue: true,
              });
              allActions.push(...JSON.parse(result.result.value || '[]'));
            } else {
              const result = await cdp.send('Runtime.evaluate', {
                expression: 'JSON.stringify(window.__wally_actions || [])',
                returnByValue: true,
              });
              await cdp.send('Runtime.evaluate', {
                expression: 'window.__wally_actions = []',
              });
              allActions.push(...JSON.parse(result.result.value || '[]'));
            }
          }
        } catch {}
      }
    }

    // Deduplicate: keep only unique actions (same type+selector+text)
    const seen = new Set();
    return allActions.filter(a => {
      const key = `${a.type}|${a.selector || ''}|${a.text || ''}|${a.value || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Discover pages opened directly (e.g. extension from toolbar).
   * Chrome may not fire Target.targetCreated for all popup types.
   */
  async discoverPages() {
    if (!this.running) return;
    try {
      const ctx = this.browser.contexts()[0];
      if (!ctx) return;
      for (const p of ctx.pages()) {
        const url = p.url();
        if (!url || url === "about:blank") continue;
        // Check if this page is already attached
        let found = false;
        for (const [, info] of this.pages) {
          if (info.page === p || (info.url && url.includes(info.url.substring(0, 30)))) {
            found = true;
            break;
          }
        }
        if (!found) {
          const isExt = url.startsWith("chrome-extension://");
          console.log("[Wally Daemon] Discovered " + (isExt ? "extension" : "page") + ": " + url.substring(0, 60));
          await this.attachToTarget("discovered-" + Date.now(), url);
          // Re-attach with the actual page reference
          for (const [targetId, info] of this.pages) {
            if (!info.page && info.url === url) {
              info.page = p;
              if (isExt) {
                await this.injectViaCDP(p, info.sessionId);
              } else {
                await injectRecordingListeners(p);
              }
              console.log("[Wally Daemon] Attached + recording: " + info.label);
            }
          }
        }
      }
    } catch {}
  }

  async pollActions() {
    if (!this.running) return;

    for (const [targetId, info] of this.pages) {
      try {
        // Skip iframes that don't have a page reference (parent will collect their actions)
        if (info.isIframe && !info.page) continue;

        // Use CDP for extension pages (CSP blocks page.evaluate)
        // readActionsViaCDP also collects actions from all frames within the page
        const isExt = isExtensionUrl(info.url);
        const actions = isExt
          ? await this.readActionsViaCDP(info.page)
          : await readActions(info.page);

        for (const action of actions) {
          const entry = {
            ts: new Date().toISOString(),
            ...action,
            url: info.page.url(),
            page: info.label,
          };
          fs.appendFileSync(this.actionsFile, JSON.stringify(entry) + '\n');
          info.actionsCount++;

          // Log with context
          const prefix = info.label === 'main' ? '' : `[${info.label}] `;
          if (action.type === 'click') {
            console.log(`[Wally] ${prefix}Click: ${action.selector} "${action.text}"`);
          } else if (action.type === 'click_detected') {
            console.log(`[Wally] ${prefix}Click (detected): ${action.selector} "${action.text}"`);
          } else if (action.type === 'page_change') {
            console.log(`[Wally] ${prefix}Page change: "${action.heading}"`);
          } else if (action.type === 'navigate') {
            console.log(`[Wally] ${prefix}Navigate: ${action.url}`);
          } else if (action.type === 'fill') {
            console.log(`[Wally] ${prefix}Fill: ${action.selector} "${(action.value || '').substring(0, 60)}"`);
          } else if (action.type === 'wallet_connect') {
            console.log(`[Wally] ${prefix}Wallet connect: ${action.account}`);
          }
        }
      } catch {
        // Page might have navigated or crashed
      }
    }
  }

  async takeSnapshot(page) {
    try {
      const { getSnapshot } = require('./wally-snap');
      return await getSnapshot(page);
    } catch {
      // Fallback: basic snapshot
      return { url: page.url(), title: await page.title(), compact: '' };
    }
  }

  saveState() {
    const state = {
      pid: process.pid,
      sessionDir: this.sessionDir,
      actionsFile: this.actionsFile,
      networkFile: this.networkFile || null,
      harEnabled: !!this.enableHar,
      pages: {},
      startedAt: new Date().toISOString(),
    };
    for (const [targetId, info] of this.pages) {
      state.pages[targetId] = {
        url: info.url,
        label: info.label,
        actionsCount: info.actionsCount,
      };
    }
    fs.writeFileSync(DAEMON_STATE_FILE, JSON.stringify(state, null, 2));
  }

  static async status() {
    if (!fs.existsSync(DAEMON_STATE_FILE)) {
      console.log('[Wally Daemon] Not running (no state file)');
      return;
    }

    const state = JSON.parse(fs.readFileSync(DAEMON_STATE_FILE, 'utf8'));
    const alive = fs.existsSync(DAEMON_PID_FILE) && process.kill(state.pid, 0);

    if (!alive) {
      console.log('[Wally Daemon] Not running (stale state)');
      return;
    }

    console.log(`[Wally Daemon] Running (PID ${state.pid})`);
    console.log(`[Wally Daemon] Session: ${state.sessionDir}`);
    console.log(`[Wally Daemon] Started: ${state.startedAt}`);
    console.log(`[Wally Daemon] Pages:`);

    for (const [targetId, page] of Object.entries(state.pages)) {
      console.log(`  - ${page.label}: ${page.actionsCount} actions (${page.url.substring(0, 60)})`);
    }

    // Count total actions in file
    if (fs.existsSync(state.actionsFile)) {
      const lines = fs.readFileSync(state.actionsFile, 'utf8').trim().split('\n').filter(Boolean);
      console.log(`[Wally Daemon] Total actions: ${lines.length}`);
    }
    if (state.harEnabled && state.networkFile && fs.existsSync(state.networkFile)) {
      const nlines = fs.readFileSync(state.networkFile, 'utf8').trim().split('\n').filter(Boolean);
      console.log(`[Wally Daemon] Network events: ${nlines.length}`);
      const harPath = state.networkFile.replace(/\.jsonl$/, '.har');
      if (fs.existsSync(harPath)) console.log(`[Wally Daemon] HAR: ${harPath}`);
    } else if (state.harEnabled) {
      console.log(`[Wally Daemon] Network capture: enabled (waiting for events)`);
    }
  }
}

module.exports = { WallyDaemon, log };
