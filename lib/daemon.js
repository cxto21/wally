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
  RECORDING_SCRIPT,
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
const { acquireLock, releaseLock, isLocked } = require('./lock');
const { createLogger } = require('./logger');

const CDP_URL = 'http://127.0.0.1:9222';
const WALLY_DIR = process.env.WALLY_DIR || '/tmp/opencode/wally';
const SESSIONS_DIR = path.join(WALLY_DIR, 'sessions');
const RECORDS_DIR = path.join(__dirname, '..', '.records');
const DAEMON_PID_FILE = path.join(WALLY_DIR, 'daemon.pid');
const DAEMON_STATE_FILE = path.join(WALLY_DIR, 'daemon-state.json');
const DAEMON_LOCK_FILE = path.join(WALLY_DIR, 'daemon.lock');

const log = createLogger('daemon');


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
    // Ext-aux mode: capture OTHER extensions' popups only, forward to bridge
    this.extAux = false;
    this.bridgePort = null;
    this.bridgeToken = null;
    this.bridgeSessionId = null;
    this.wallyExtId = null; // Wally's own extension id to skip
  }

  async start(options = {}) {
    // Acquire lock to prevent concurrent daemons
    try {
      acquireLock(DAEMON_LOCK_FILE);
    } catch (e) {
      console.error(`[Wally Daemon] ${e.message}`);
      process.exit(1);
    }

    // Ext-aux mode setup
    this.extAux = !!options.extAux;
    this.bridgePort = options.bridgePort || null;
    this.bridgeToken = options.bridgeToken || null;
    this.bridgeSessionId = options.bridgeSessionId || `ext-aux-${Date.now()}`;

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
    if (this.extAux) {
      console.log('[Wally Daemon] Mode: ext-aux (other extensions only)');
      console.log(`[Wally Daemon] Bridge: http://127.0.0.1:${this.bridgePort} (session: ${this.bridgeSessionId})`);
    }
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
      } catch (e) { log.debug(`detach page ${info.label}: ${e.message}`); }
    }

    // Detach network sessions
    for (const [targetId, net] of this.networkSessions) {
      try { net.cleanup && await net.cleanup(); } catch (e) { log.debug(`network cleanup ${targetId}: ${e.message}`); }
      try { net.cdpSession && await net.cdpSession.detach().catch(() => {}); } catch (e) { log.debug(`network detach ${targetId}: ${e.message}`); }
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
    } catch (e) {
      log.debug(`Final snapshot skipped: ${e.message}`);
    }

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
          try { fs.copyFileSync(path.join(snapSrc, f), path.join(snapDst, f)); } catch (e) { log.debug(`copy snapshot ${f}: ${e.message}`); }
        }
      }
      // Copy network files if --har was enabled
      if (this.enableHar) {
        const netSrc = this.networkFile && fs.existsSync(this.networkFile) ? this.networkFile : path.join(this.sessionDir, 'network.jsonl');
        if (fs.existsSync(netSrc)) {
          try { fs.copyFileSync(netSrc, path.join(cleanDir, 'network.jsonl')); } catch (e) { log.debug(`copy network.jsonl: ${e.message}`); }
        }
        const harSrc = this.harOutput && fs.existsSync(this.harOutput) ? this.harOutput : path.join(this.sessionDir, 'network.har');
        if (fs.existsSync(harSrc)) {
          try { fs.copyFileSync(harSrc, path.join(cleanDir, 'network.har')); } catch (e) { log.debug(`copy network.har: ${e.message}`); }
        }
        const reqSrc = path.join(this.sessionDir, 'requests.json');
        if (fs.existsSync(reqSrc)) {
          try { fs.copyFileSync(reqSrc, path.join(cleanDir, 'requests.json')); } catch (e) { log.debug(`copy requests.json: ${e.message}`); }
        }
        // Also copy if generated at networkFile location custom harOutput
        const harAtSession = path.join(this.sessionDir, 'network.har');
        if (harAtSession !== harSrc && fs.existsSync(harAtSession)) {
          try { fs.copyFileSync(harAtSession, path.join(cleanDir, 'network.har')); } catch (e) { log.debug(`copy session har: ${e.message}`); }
        }
      }
      // Auto-generate playwright.spec.js (standalone, node runnable)
      let hasSpec = false;
      try {
        const actions = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (actions.length === 0) throw new Error('No actions recorded — nothing to generate');
        const test = generatePlaywrightTest(actions);
        fs.writeFileSync(path.join(cleanDir, 'playwright.spec.js'), test);
        console.log(`[Wally Daemon] Playwright: ${cleanDir}/playwright.spec.js`);
        hasSpec = true;
      } catch (e) { console.log('[Wally] Playwright gen skipped:', e.message); }
      console.log(`[Wally Daemon] Clean record: ${cleanDir}/`);
      console.log(`[Wally Daemon]   → actions.jsonl + snapshots/${hasSpec ? ' + playwright.spec.js' : ' (no spec — empty recording)'}`);
    } catch (e) {
      console.log(`[Wally] Clean copy failed: ${e.message}`);
    }

    // Clean up PID and lock files
    try { fs.unlinkSync(DAEMON_PID_FILE); } catch (e) { log.debug(`unlink daemon.pid: ${e.message}`); }
    try { fs.unlinkSync(DAEMON_STATE_FILE); } catch (e) { log.debug(`unlink daemon-state.json: ${e.message}`); }
    releaseLock(DAEMON_LOCK_FILE, process.pid, 'daemon stopped');

    // Detach browser (don't close Chrome)
    try { this.browser.close(); } catch (e) { log.debug(`browser.close: ${e.message}`); }

    process.exit(0);
  }

  async onTargetCreated(event) {
    const { targetInfo } = event;
    // Handle both pages AND iframes (extensions use iframes for popups/dropdowns)
    if (targetInfo.type !== 'page' && targetInfo.type !== 'iframe') return;
    if (this.pages.has(targetInfo.targetId)) return;

    // Ext-aux mode: only capture OTHER extensions' targets, skip Wally's own
    if (this.extAux) {
      const isExt = targetInfo.url && targetInfo.url.startsWith('chrome-extension://');
      if (!isExt) return; // skip non-extension pages in ext-aux mode
      if (this.isWallyExtension(targetInfo.url)) return; // skip Wally's own extension
    }

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
        try { net.cleanup && net.cleanup(); } catch (e) { log.debug(`target cleanup ${event.targetId}: ${e.message}`); }
        try { net.cdpSession && net.cdpSession.detach().catch(() => {}); } catch (e) { log.debug(`target detach ${event.targetId}: ${e.message}`); }
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

  /**
   * Check if a URL belongs to Wally's own extension.
   * @param {string} url
   * @returns {boolean}
   */
  isWallyExtension(url) {
    if (!url || !url.startsWith('chrome-extension://')) return false;
    // Lazy-detect Wally's extension id from the content-script path
    if (!this.wallyExtId) {
      const match = url.match(/chrome-extension:\/\/([a-z]+)/);
      if (match) {
        // Check if this is Wally by looking for known Wally paths
        if (url.includes('src/content/content-script.js') || url.includes('src/background/service-worker.js')) {
          this.wallyExtId = match[1];
        }
      }
    }
    if (!this.wallyExtId) return false;
    return url.startsWith(`chrome-extension://${this.wallyExtId}`);
  }

  /**
   * Forward actions to the bridge server via POST /actions?id=<session>.
   * @param {Array} actions - Actions to forward
   */
  async forwardToBridge(actions) {
    if (!this.bridgePort || !this.bridgeToken || !actions || actions.length === 0) return;

    try {
      const http = require('http');
      const postData = JSON.stringify(actions);
      const options = {
        hostname: '127.0.0.1',
        port: this.bridgePort,
        path: `/actions?id=${this.bridgeSessionId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.bridgeToken}`,
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      await new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              log.debug(`Forwarded ${actions.length} actions to bridge`);
            } else {
              log.debug(`Bridge returned ${res.statusCode}: ${body}`);
            }
            resolve();
          });
        });
        req.on('error', (e) => {
          log.debug(`Bridge forward failed: ${e.message}`);
          resolve(); // don't fail the daemon
        });
        req.write(postData);
        req.end();
      });
    } catch (e) {
      log.debug(`Bridge forward error: ${e.message}`);
    }
  }

  async attachToTarget(targetId, url) {
    try {
      const label = getPageLabel(url);
      console.log(`[Wally Daemon] Attaching to: ${label} (${url.substring(0, 60)})`);

      // Attach to target (single session)
      const { sessionId } = await this.cdp.send('Target.attachToTarget', {
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

      // If not found, wait and retry (page might still be loading/redirecting)
      if (!targetPage) {
        await new Promise(r => setTimeout(r, 1500));
        for (const p of ctx.pages()) {
          if (p.url().includes(url.substring(0, 20)) || isExtensionUrl(p.url())) {
            targetPage = p;
            break;
          }
        }
      }

      if (targetPage) {
        // For extension pages, use CDP directly to bypass CSP
        if (isExtensionUrl(url)) {
          await this.injectViaCDP(targetPage, sessionId);
        } else {
          // Use addInitScript so the recording survives SPA navigations / hash changes
          try {
            await targetPage.addInitScript(RECORDING_SCRIPT);
            console.log(`[Wally Daemon] addInitScript registered for ${label}`);
          } catch (e) {
            console.log(`[Wally Daemon] addInitScript failed (${label}): ${e.message}`);
          }
          // Also inject immediately into the current document
          try {
            await targetPage.evaluate(RECORDING_SCRIPT);
            console.log(`[Wally Daemon] Initial injection OK: ${label}`);
          } catch (e) {
            console.log(`[Wally Daemon] Initial injection failed (${label}): ${e.message}`);
          }
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
        console.log(`[Wally Daemon] Iframe detected: ${label} (${url.substring(0, 60)})`);
        this.pages.set(targetId, {
          page: null,
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
          } catch (e) {
            log.debug(`Frame CDP inject failed: ${e.message}`);
          }
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
    } catch (e) {
      log.debug(`CDP read main frame failed: ${e.message}`);
    }

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
        } catch (e) {
          log.debug(`CDP read frame failed: ${e.message}`);
        }
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

        // Ext-aux mode: only discover OTHER extensions' targets
        if (this.extAux) {
          const isExt = url.startsWith("chrome-extension://");
          if (!isExt) continue; // skip non-extension pages
          if (this.isWallyExtension(url)) continue; // skip Wally's own
        }

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
    } catch (e) {
      log.debug(`Page discovery error: ${e.message}`);
    }
  }

  async pollActions() {
    if (!this.running) return;

    const batchActions = [];

    for (const [targetId, info] of this.pages) {
      try {
        // Skip iframes that don't have a page reference (parent will collect their actions)
        if (info.isIframe && !info.page) continue;

        // Re-inject recording script if the page navigated (SPA hash changes, etc.)
        // This is cheap — the script has a guard (window.__wally_recording_injected)
        if (!isExtensionUrl(info.url) && info.page) {
          try { await info.page.evaluate(RECORDING_SCRIPT); } catch (e) { /* page navigated */ }
        }

        // Use CDP for extension pages (CSP blocks page.evaluate)
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

          // In ext-aux mode, forward to bridge; also write locally
          if (this.extAux) {
            batchActions.push(entry);
          }

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
      } catch (e) {
        // Page might have navigated or crashed
        log.debug(`Poll actions failed for ${info.label}: ${e.message}`);
      }
    }

    // Forward batch to bridge in ext-aux mode
    if (this.extAux && batchActions.length > 0) {
      await this.forwardToBridge(batchActions);
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
