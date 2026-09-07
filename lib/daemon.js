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
const { generatePlaywrightTest } = require('./generate-test');

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
        const test = generatePlaywrightTest(actions);
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
          } else if (action.type === 'extension_connect') {
            console.log(`[Wally] ${prefix}Extension connect: ${action.account}`);
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
