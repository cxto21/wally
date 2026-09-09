/**
 * Wally Bridge — localhost HTTP server
 *
 * Receives session bundles from the Wally browser extension and
 * materializes them into .records/ for the CLI pipeline.
 *
 * Security: binds to 127.0.0.1 only, random per-run crypto token.
 *
 * Usage:
 *   const { createServer } = require('./lib/bridge');
 *   const { server, token } = createServer(port);
 *   server.listen(port, '127.0.0.1', () => { ... });
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const RECORDS_DIR = path.join(__dirname, '..', '.records');

/**
 * Generate a random 16-byte hex token for bridge auth.
 * @returns {string} 32-char hex string
 */
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Materialize a session bundle into .records/<id>/.
 *
 * Creates:
 *   - actions.jsonl  (one JSON action per line)
 *   - metadata.json  (session metadata)
 *   - network.jsonl  (if network data present)
 *
 * @param {Object} session - Session bundle from extension
 * @param {Array}  session.actions - Recorded actions
 * @param {string} [session.startUrl] - Starting URL
 * @param {number} [session.startTime] - Recording start timestamp
 * @param {number} [session.endTime] - Recording end timestamp
 * @param {Array}  [session.network] - Network capture data
 * @returns {{ sessionId: string, path: string, actions: number }}
 */
function materializeSession(session) {
  if (!session.actions || !Array.isArray(session.actions)) {
    throw new Error('Invalid session: missing actions array');
  }

  const sessionId = `ext-${Date.now()}`;
  const sessionDir = path.join(RECORDS_DIR, sessionId);

  fs.mkdirSync(sessionDir, { recursive: true });

  // Write actions.jsonl
  const actionsJsonl = session.actions
    .map(a => JSON.stringify(a))
    .join('\n');
  fs.writeFileSync(path.join(sessionDir, 'actions.jsonl'), actionsJsonl);

  // Write metadata
  const metadata = {
    id: sessionId,
    startUrl: session.startUrl || '',
    startTime: session.startTime || Date.now(),
    endTime: session.endTime || Date.now(),
    source: 'extension',
    actionCount: session.actions.length,
  };
  fs.writeFileSync(
    path.join(sessionDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  // Write network if present
  if (session.network && session.network.length > 0) {
    const networkJsonl = session.network
      .map(n => JSON.stringify(n))
      .join('\n');
    fs.writeFileSync(path.join(sessionDir, 'network.jsonl'), networkJsonl);
  }

  return { sessionId, path: sessionDir, actions: session.actions.length };
}

/**
 * Create the bridge HTTP server.
 *
 * Endpoints:
 *   POST /session  — receive session bundle from extension
 *   GET  /health   — health check (no auth required)
 *
 * @param {number} port - Port to listen on (for health response only; caller binds)
 * @returns {{ server: http.Server, token: string }}
 */
function createServer(port) {
  const token = generateToken();

  const server = http.createServer((req, res) => {
    // CORS headers for extension
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check — no auth required
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port }));
      return;
    }

    // Auth check for all other endpoints
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // POST /session — receive session from extension
    if (req.method === 'POST' && req.url === '/session') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          // Size guard (10 MB)
          if (body.length > 10 * 1024 * 1024) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            return;
          }

          const session = JSON.parse(body);
          const result = materializeSession(session);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  return { server, token };
}

module.exports = { createServer, materializeSession, generateToken, HOST, RECORDS_DIR };
