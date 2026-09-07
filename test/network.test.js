import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateHAR, parseNetworkLog, buildEntry, writeHAR } from '../lib/network.js';

describe('parseNetworkLog', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wally-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for non-existent file', () => {
    const result = parseNetworkLog('/nonexistent/path.jsonl');
    expect(result).toEqual([]);
  });

  it('returns empty array for empty file', () => {
    const file = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    const result = parseNetworkLog(file);
    expect(result).toEqual([]);
  });

  it('parses valid JSONL entries', () => {
    const file = path.join(tmpDir, 'network.jsonl');
    const entries = [
      { ts: '2024-01-01T00:00:00.000Z', type: 'Network.requestWillBeSent', params: { requestId: '1' } },
      { ts: '2024-01-01T00:00:01.000Z', type: 'Network.responseReceived', params: { requestId: '1' } },
    ];
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    const result = parseNetworkLog(file);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('Network.requestWillBeSent');
    expect(result[1].type).toBe('Network.responseReceived');
  });

  it('skips malformed JSON lines', () => {
    const file = path.join(tmpDir, 'mixed.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ ts: '2024-01-01T00:00:00.000Z', type: 'Network.requestWillBeSent', params: { requestId: '1' } }),
      'not valid json',
      JSON.stringify({ ts: '2024-01-01T00:00:01.000Z', type: 'Network.responseReceived', params: { requestId: '2' } }),
    ].join('\n') + '\n');

    const result = parseNetworkLog(file);
    expect(result).toHaveLength(2);
  });

  it('handles trailing newlines and whitespace', () => {
    const file = path.join(tmpDir, 'trailing.jsonl');
    fs.writeFileSync(file, JSON.stringify({ ts: '2024-01-01T00:00:00.000Z', type: 'test', params: {} }) + '\n\n\n');

    const result = parseNetworkLog(file);
    expect(result).toHaveLength(1);
  });
});

describe('buildEntry', () => {
  it('creates a basic HAR entry from request params', () => {
    const params = {
      requestId: 'req-1',
      request: {
        url: 'https://example.com/api?foo=bar',
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      },
    };
    const ts = '2024-01-01T00:00:00.000Z';

    const entry = buildEntry(params, ts);

    expect(entry.startedDateTime).toBe(new Date(ts).toISOString());
    expect(entry.time).toBe(0);
    expect(entry.request.method).toBe('GET');
    expect(entry.request.url).toBe('https://example.com/api?foo=bar');
    expect(entry.request.queryString).toEqual([{ name: 'foo', value: 'bar' }]);
    expect(entry.request.headers).toEqual([{ name: 'Accept', value: 'application/json' }]);
    expect(entry.response.status).toBe(0);
    expect(entry.timings).toEqual({ send: 0, wait: 0, receive: 0 });
  });

  it('parses query string parameters', () => {
    const params = {
      requestId: 'req-2',
      request: {
        url: 'https://example.com/page?a=1&b=2&c=3',
        method: 'GET',
        headers: {},
      },
    };

    const entry = buildEntry(params, '2024-01-01T00:00:00.000Z');
    expect(entry.request.queryString).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
      { name: 'c', value: '3' },
    ]);
  });

  it('handles POST data', () => {
    const params = {
      requestId: 'req-3',
      request: {
        url: 'https://example.com/api',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        postData: '{"key":"value"}',
      },
    };

    const entry = buildEntry(params, '2024-01-01T00:00:00.000Z');
    expect(entry.request.postData).toEqual({
      mimeType: 'application/json',
      text: '{"key":"value"}',
    });
  });

  it('uses wallTime when available', () => {
    const params = {
      requestId: 'req-4',
      request: { url: 'https://example.com', method: 'GET', headers: {} },
      wallTime: 1704067200,
    };

    const entry = buildEntry(params, '2024-01-01T00:00:00.000Z');
    expect(entry.startedDateTime).toBe(new Date(1704067200 * 1000).toISOString());
  });

  it('handles invalid URL gracefully', () => {
    const params = {
      requestId: 'req-5',
      request: { url: 'not-a-valid-url', method: 'GET', headers: {} },
    };

    const entry = buildEntry(params, '2024-01-01T00:00:00.000Z');
    expect(entry.request.url).toBe('not-a-valid-url');
    expect(entry.request.queryString).toEqual([]);
  });
});

describe('generateHAR', () => {
  it('produces valid HAR 1.2 format with empty events', () => {
    const har = generateHAR([]);

    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('Wally');
    expect(har.log.browser.name).toBe('Chrome');
    expect(har.log.pages).toHaveLength(1);
    expect(har.log.entries).toEqual([]);
  });

  it('generates HAR entries from request events', () => {
    const events = [
      {
        type: 'Network.requestWillBeSent',
        ts: '2024-01-01T00:00:00.000Z',
        params: {
          requestId: 'req-1',
          request: { url: 'https://example.com', method: 'GET', headers: {} },
          timestamp: 1704067200,
        },
      },
      {
        type: 'Network.responseReceived',
        ts: '2024-01-01T00:00:01.000Z',
        params: {
          requestId: 'req-1',
          response: {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/html' },
          },
          timestamp: 1704067201,
        },
      },
      {
        type: 'Network.loadingFinished',
        ts: '2024-01-01T00:00:02.000Z',
        params: {
          requestId: 'req-1',
          encodedDataLength: 1234,
          timestamp: 1704067202,
        },
      },
    ];

    const har = generateHAR(events);

    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(1);

    const entry = har.log.entries[0];
    expect(entry.request.method).toBe('GET');
    expect(entry.request.url).toBe('https://example.com');
    expect(entry.response.status).toBe(200);
    expect(entry.response.statusText).toBe('OK');
    expect(entry.response.bodySize).toBe(1234);
  });

  it('handles requestServedFromCache events', () => {
    const events = [
      {
        type: 'Network.requestWillBeSent',
        ts: '2024-01-01T00:00:00.000Z',
        params: {
          requestId: 'req-cache',
          request: { url: 'https://example.com/cached.js', method: 'GET', headers: {} },
          timestamp: 1704067200,
        },
      },
      {
        type: 'Network.requestServedFromCache',
        ts: '2024-01-01T00:00:00.100Z',
        params: { requestId: 'req-cache' },
      },
    ];

    const har = generateHAR(events);
    const entry = har.log.entries[0];
    expect(entry.cache.beforeRequest).toBeDefined();
  });

  it('sorts entries by startedDateTime', () => {
    const events = [
      {
        type: 'Network.requestWillBeSent',
        ts: '2024-01-01T00:00:02.000Z',
        params: {
          requestId: 'req-2',
          request: { url: 'https://example.com/second', method: 'GET', headers: {} },
          timestamp: 1704067202,
        },
      },
      {
        type: 'Network.requestWillBeSent',
        ts: '2024-01-01T00:00:00.000Z',
        params: {
          requestId: 'req-1',
          request: { url: 'https://example.com/first', method: 'GET', headers: {} },
          timestamp: 1704067200,
        },
      },
    ];

    const har = generateHAR(events);
    expect(har.log.entries[0].request.url).toBe('https://example.com/first');
    expect(har.log.entries[1].request.url).toBe('https://example.com/second');
  });

  it('skips events without type', () => {
    const events = [
      { ts: '2024-01-01T00:00:00.000Z', params: {} },
      {
        type: 'Network.requestWillBeSent',
        ts: '2024-01-01T00:00:00.000Z',
        params: {
          requestId: 'req-1',
          request: { url: 'https://example.com', method: 'GET', headers: {} },
          timestamp: 1704067200,
        },
      },
    ];

    const har = generateHAR(events);
    expect(har.log.entries).toHaveLength(1);
  });

  it('handles redirect responses', () => {
    const events = [
      {
        type: 'Network.requestWillBeSent',
        ts: '2024-01-01T00:00:00.000Z',
        params: {
          requestId: 'req-redirect',
          request: { url: 'https://example.com/new', method: 'GET', headers: {} },
          redirectResponse: { status: 301, statusText: 'Moved Permanently' },
          timestamp: 1704067200,
        },
      },
    ];

    const har = generateHAR(events);
    // Should have at least the original entry with redirect status
    expect(har.log.entries.length).toBeGreaterThanOrEqual(1);
  });
});

describe('writeHAR', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wally-test-har-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes HAR object to file as formatted JSON', () => {
    const har = { log: { version: '1.2', entries: [] } };
    const harPath = path.join(tmpDir, 'test.har');

    writeHAR(har, harPath);

    const content = fs.readFileSync(harPath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.log.version).toBe('1.2');
  });
});
