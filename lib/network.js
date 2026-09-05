/**
 * Wally Network Capture — CDP Network domain helpers
 *
 * Provides:
 *  - attachNetworkCapture(cdpSession, networkFile) — enable Network domain and log events
 *  - generateHAR(events) — build HAR 1.2 from collected events
 *  - writeHAR(har, harPath)
 *  - parseNetworkLog(networkFile) — read network.jsonl
 */
const fs = require('fs');

/**
 * Attach Network capture to a CDP session.
 * Enables Network domain and logs events to networkFile (JSONL).
 * Returns a cleanup function.
 *
 * @param {import('playwright').CDPSession} cdpSession
 * @param {string} networkFile - path to network.jsonl
 * @returns {Promise<Function>} cleanup function
 */
async function attachNetworkCapture(cdpSession, networkFile) {
  const events = ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed', 'Network.requestServedFromCache', 'Network.dataReceived'];
  // Ensure file exists
  try { if (!fs.existsSync(networkFile)) fs.writeFileSync(networkFile, ''); } catch {}

  function append(type, params) {
    const entry = { ts: new Date().toISOString(), type, params };
    try { fs.appendFileSync(networkFile, JSON.stringify(entry) + '\n'); } catch {}
  }

  const handlers = {};
  handlers['Network.requestWillBeSent'] = (p) => append('Network.requestWillBeSent', p);
  handlers['Network.responseReceived'] = (p) => append('Network.responseReceived', p);
  handlers['Network.loadingFinished'] = (p) => append('Network.loadingFinished', p);
  handlers['Network.loadingFailed'] = (p) => append('Network.loadingFailed', p);
  handlers['Network.requestServedFromCache'] = (p) => append('Network.requestServedFromCache', p);
  handlers['Network.dataReceived'] = (p) => append('Network.dataReceived', p);

  for (const [evt, handler] of Object.entries(handlers)) {
    cdpSession.on(evt, handler);
  }

  try {
    await cdpSession.send('Network.enable');
  } catch (e) {
    console.log(`[Wally Network] Network.enable failed: ${e.message}`);
  }

  // Return cleanup
  return async () => {
    for (const [evt, handler] of Object.entries(handlers)) {
      try { cdpSession.off(evt, handler); } catch {}
    }
    try { await cdpSession.send('Network.disable').catch(() => {}); } catch {}
  };
}

/**
 * Parse network.jsonl into array of events.
 * @param {string} networkFile
 * @returns {Array}
 */
function parseNetworkLog(networkFile) {
  if (!fs.existsSync(networkFile)) return [];
  const content = fs.readFileSync(networkFile, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Generate HAR 1.2 JSON from collected network events.
 * Events are expected to be objects with {type, params, ts}
 * @param {Array} events
 * @returns {object} HAR object
 */
function generateHAR(events) {
  const requestMap = new Map(); // requestId -> HAR entry

  for (const ev of events) {
    const type = ev.type;
    const p = ev.params || ev;
    if (!type) continue;

    if (type === 'Network.requestWillBeSent') {
      const requestId = p.requestId;
      if (!requestId) continue;
      // Handle redirect: if existing entry has same requestId but has response already, keep but create new?
      // Simplified: if redirectResponse present, finalize previous entry
      if (p.redirectResponse && requestMap.has(requestId)) {
        // Redirect: create a new entry for the redirect request, keep old
        const prev = requestMap.get(requestId);
        if (prev) {
          prev.response.status = p.redirectResponse.status;
          prev.response.statusText = p.redirectResponse.statusText || '';
          prev.response.redirectURL = p.request.url || '';
        }
        // create new entry with new requestId? Chrome reuses requestId for redirect chain,
        // but we will suffix to avoid overwrite — store as requestId + redirect count
        // Simpler: create new entry with same id but overwrite after cloning previous
        // Instead just create a new key
        const redirectKey = requestId + '_redirect_' + Date.now() + Math.random();
        const entry = buildEntry(p, ev.ts);
        requestMap.set(redirectKey, entry);
        continue;
      }
      // If requestId already exists and not redirect, skip duplicate (retry)
      if (requestMap.has(requestId)) continue;
      const entry = buildEntry(p, ev.ts);
      requestMap.set(requestId, entry);
    } else if (type === 'Network.responseReceived') {
      const entry = requestMap.get(p.requestId);
      if (!entry) continue;
      entry.response.status = p.response.status;
      entry.response.statusText = p.response.statusText || '';
      entry.response.httpVersion = p.response.protocol ? p.response.protocol : 'HTTP/1.1';
      entry.response.headers = Object.entries(p.response.headers || {}).map(([name, value]) => ({ name, value: String(value) }));
      if (p.response.mimeType) entry.response.content.mimeType = p.response.mimeType;
      entry.response.redirectURL = p.response.headers?.location || p.response.headers?.Location || '';
      if (p.response.timing) {
        entry.timings = {
          send: p.response.timing.sendEnd >= 0 ? p.response.timing.sendEnd : 0,
          wait: p.response.timing.receiveHeadersEnd >= 0 ? p.response.timing.receiveHeadersEnd : 0,
          receive: 0,
        };
      }
      entry._responseTimestamp = p.timestamp;
    } else if (type === 'Network.loadingFinished') {
      const entry = requestMap.get(p.requestId);
      if (!entry) continue;
      if (entry._timestamp != null && p.timestamp != null) {
        entry.time = Math.max(0, (p.timestamp - entry._timestamp) * 1000);
      }
      entry.response.bodySize = p.encodedDataLength != null ? p.encodedDataLength : entry.response.bodySize;
      entry.response.content.size = p.encodedDataLength != null ? p.encodedDataLength : entry.response.content.size;
      if (entry.timings) {
        const total = entry.time;
        const known = (entry.timings.send || 0) + (entry.timings.wait || 0);
        entry.timings.receive = Math.max(0, total - known);
      }
    } else if (type === 'Network.loadingFailed') {
      const entry = requestMap.get(p.requestId);
      if (!entry) continue;
      entry._failed = true;
      entry._errorText = p.errorText || 'failed';
      entry.response.statusText = p.errorText || 'failed';
      if (p.timestamp && entry._timestamp) {
        entry.time = Math.max(0, (p.timestamp - entry._timestamp) * 1000);
      }
    } else if (type === 'Network.requestServedFromCache') {
      const entry = requestMap.get(p.requestId);
      if (entry) {
        entry._fromCache = true;
        entry.cache = { beforeRequest: { lastAccess: '', eTag: '', hitCount: 0 } };
      }
    }
  }

  const entries = Array.from(requestMap.values()).map(e => {
    const { _timestamp, _wallTime, _responseTimestamp, _failed, _errorText, _fromCache, _requestId, ...clean } = e;
    return clean;
  });

  // Sort by startedDateTime
  entries.sort((a, b) => new Date(a.startedDateTime) - new Date(b.startedDateTime));

  return {
    log: {
      version: '1.2',
      creator: { name: 'Wally', version: '1.0.0', comment: 'Generated via CDP Network domain' },
      browser: { name: 'Chrome', version: '' },
      pages: [{
        id: 'page_1',
        title: 'Wally Recording',
        startedDateTime: entries[0]?.startedDateTime || new Date().toISOString(),
        pageTimings: {},
      }],
      entries,
    }
  };
}

function buildEntry(p, ts) {
  const url = p.request?.url || p.documentURL || '';
  const method = p.request?.method || 'GET';
  const headers = p.request?.headers || {};
  const entry = {
    startedDateTime: (() => {
      if (p.wallTime) return new Date(p.wallTime * 1000).toISOString();
      if (ts) return new Date(ts).toISOString();
      return new Date().toISOString();
    })(),
    time: 0,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      headers: Object.entries(headers).map(([name, value]) => ({ name, value: String(value) })),
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      headers: [],
      cookies: [],
      content: { size: 0, mimeType: p.request?.mimeType || 'text/plain' },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    _requestId: p.requestId,
    _timestamp: p.timestamp,
    _wallTime: p.wallTime,
  };
  try {
    const u = new URL(url);
    u.searchParams.forEach((value, name) => entry.request.queryString.push({ name, value }));
  } catch {}
  // Handle POST data if present
  if (p.request?.postData) {
    entry.request.postData = { mimeType: headers['Content-Type'] || headers['content-type'] || 'text/plain', text: p.request.postData };
  }
  return entry;
}

/**
 * Write HAR object to file.
 * @param {object} har
 * @param {string} harPath
 */
function writeHAR(har, harPath) {
  fs.writeFileSync(harPath, JSON.stringify(har, null, 2));
}

module.exports = {
  attachNetworkCapture,
  parseNetworkLog,
  generateHAR,
  writeHAR,
};
