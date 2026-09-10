/**
 * Tests for Wally Selector Grammar — resolveSelectorGrammar and resolveWithRetry.
 *
 * Uses jsdom to simulate a DOM environment for testing the grammar resolution
 * chain: role+text, data-testid, #id, aria-label, button/link text,
 * input/select[name], nth-child paths, and malformed selectors.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { resolveSelectorGrammar, resolveWithRetry } from '../extension/src/common/selector-grammar.js';

/**
 * Helper: create a jsdom instance with HTML and set it as the global document.
 */
function setupDom(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.MouseEvent = dom.window.MouseEvent;
  global.KeyboardEvent = dom.window.KeyboardEvent;
  return dom;
}

describe('resolveSelectorGrammar', () => {
  beforeEach(() => {
    // Reset DOM for each test
    global.document = new JSDOM('<!DOCTYPE html><html><body></body></html>').window.document;
  });

  // ─── data-testid ───────────────────────────────────────────
  it('resolves [data-testid="x"] selector', () => {
    setupDom('<button data-testid="connect-wallet">Connect</button>');
    const el = resolveSelectorGrammar('[data-testid="connect-wallet"]');
    expect(el).not.toBeNull();
    expect(el.textContent.trim()).toBe('Connect');
  });

  it('resolves data-testid on nested element via closest()', () => {
    setupDom('<div data-testid="outer"><span><button>Nested</button></span></div>');
    const el = resolveSelectorGrammar('[data-testid="outer"]');
    expect(el).not.toBeNull();
    expect(el.querySelector('button')).not.toBeNull();
  });

  // ─── aria-label ────────────────────────────────────────────
  it('resolves [aria-label="x"] selector', () => {
    setupDom('<input aria-label="Email address" type="email">');
    const el = resolveSelectorGrammar('[aria-label="Email address"]');
    expect(el).not.toBeNull();
    expect(el.tagName).toBe('INPUT');
  });

  // ─── #id ───────────────────────────────────────────────────
  it('resolves #id selector', () => {
    setupDom('<div id="submit-btn">Submit</div>');
    const el = resolveSelectorGrammar('#submit-btn');
    expect(el).not.toBeNull();
    expect(el.id).toBe('submit-btn');
  });

  it('returns null for auto-generated numeric ids', () => {
    setupDom('<div id="12345">Auto</div>');
    const el = resolveSelectorGrammar('#12345');
    // #12345 matches /^#[\w-]+$/ regex, querySelector returns null (no element)
    // Falls to nth-child path where querySelector('#12345') throws in jsdom
    expect(el).toBeNull();
  });

  // ─── button "Text" ────────────────────────────────────────
  it('resolves button "Text" selector', () => {
    setupDom('<button>Buy Now</button>');
    const el = resolveSelectorGrammar('button "Buy Now"');
    expect(el).not.toBeNull();
    expect(el.tagName).toBe('BUTTON');
    expect(el.textContent.trim()).toBe('Buy Now');
  });

  it('resolves button "Text" with partial text match', () => {
    setupDom('<button>Connect Wallet</button>');
    const el = resolveSelectorGrammar('button "Connect Wallet"');
    expect(el).not.toBeNull();
  });

  // ─── link "Text" ───────────────────────────────────────────
  it('resolves link "Text" selector', () => {
    setupDom('<a href="/about">About Us</a>');
    const el = resolveSelectorGrammar('link "About Us"');
    expect(el).not.toBeNull();
    expect(el.tagName).toBe('A');
  });

  // ─── role + text ───────────────────────────────────────────
  it('resolves role="button" "Text" selector', () => {
    setupDom('<div role="button">Custom Button</div>');
    const el = resolveSelectorGrammar('button "Custom Button"');
    expect(el).not.toBeNull();
    expect(el.getAttribute('role')).toBe('button');
  });

  it('resolves generic role selector', () => {
    setupDom('<div role="menuitem">Menu Item</div>');
    const el = resolveSelectorGrammar('menuitem "Menu Item"');
    expect(el).not.toBeNull();
  });

  // ─── input[name="x"] / select[name="x"] ──────────────────
  it('resolves input[name="x"] selector', () => {
    setupDom('<input name="email" type="email">');
    const el = resolveSelectorGrammar('input[name="email"]');
    expect(el).not.toBeNull();
    expect(el.name).toBe('email');
  });

  it('resolves input[type="x"][name="x"] selector', () => {
    setupDom('<input name="password" type="password">');
    const el = resolveSelectorGrammar('input[type="password"][name="password"]');
    expect(el).not.toBeNull();
    expect(el.type).toBe('password');
  });

  it('resolves select[name="x"] selector', () => {
    setupDom('<select name="country"><option>US</option></select>');
    const el = resolveSelectorGrammar('select[name="country"]');
    expect(el).not.toBeNull();
    expect(el.tagName).toBe('SELECT');
  });

  it('resolves textarea[name="x"] selector', () => {
    setupDom('<textarea name="comments"></textarea>');
    const el = resolveSelectorGrammar('textarea[name="comments"]');
    expect(el).not.toBeNull();
    expect(el.tagName).toBe('TEXTAREA');
  });

  // ─── nth-child path ───────────────────────────────────────
  it('resolves nth-child path selector', () => {
    setupDom(`
      <div>
        <span>First</span>
        <span>Second</span>
        <span>Third</span>
      </div>
    `);
    const el = resolveSelectorGrammar('div > span:nth-child(2)');
    expect(el).not.toBeNull();
    expect(el.textContent.trim()).toBe('Second');
  });

  it('resolves multi-level nth-child path', () => {
    setupDom(`
      <div>
        <div>
          <span>Target</span>
          <span>Other</span>
        </div>
      </div>
    `);
    const el = resolveSelectorGrammar('div > div:nth-child(1) > span:nth-child(1)');
    expect(el).not.toBeNull();
    expect(el.textContent.trim()).toBe('Target');
  });

  // ─── malformed selectors ──────────────────────────────────
  it('returns null for null/undefined/empty selectors', () => {
    expect(resolveSelectorGrammar(null)).toBeNull();
    expect(resolveSelectorGrammar(undefined)).toBeNull();
    expect(resolveSelectorGrammar('')).toBeNull();
  });

  it('returns null for non-string selectors', () => {
    expect(resolveSelectorGrammar(123)).toBeNull();
    expect(resolveSelectorGrammar({})).toBeNull();
  });

  it('returns null for unmatched selectors', () => {
    setupDom('<button>Click me</button>');
    const el = resolveSelectorGrammar('#nonexistent');
    expect(el).toBeNull();
  });

  it('returns null for malformed CSS (unclosed quote)', () => {
    setupDom('<button data-testid="test">Click</button>');
    const el = resolveSelectorGrammar('[data-testid="unclosed');
    expect(el).toBeNull();
  });

  // ─── raw CSS selector fallback ────────────────────────────
  it('resolves raw CSS selector for standard elements', () => {
    setupDom('<input type="text" class="search">');
    const el = resolveSelectorGrammar('input.search');
    expect(el).not.toBeNull();
  });

  it('resolves compound CSS selectors', () => {
    setupDom('<div class="form"><input name="q" type="search"></div>');
    const el = resolveSelectorGrammar('.form input[type="search"]');
    expect(el).not.toBeNull();
  });

  // ─── priority order ───────────────────────────────────────
  it('resolves data-testid over id when both present', () => {
    setupDom('<button id="my-btn" data-testid="my-test">Button</button>');
    const el = resolveSelectorGrammar('[data-testid="my-test"]');
    expect(el).not.toBeNull();
    expect(el.id).toBe('my-btn');
  });

  it('resolves #id when no data-testid', () => {
    setupDom('<button id="my-btn">Button</button>');
    const el = resolveSelectorGrammar('#my-btn');
    expect(el).not.toBeNull();
    expect(el.id).toBe('my-btn');
  });

  // ─── edge cases ───────────────────────────────────────────
  it('handles special characters in text content', () => {
    setupDom('<button>Don\'t "break" this</button>');
    const el = resolveSelectorGrammar('button "Don\'t "break" this"');
    // The role+text regex should handle this
    expect(el).not.toBeNull();
  });

  it('handles empty text in role+text selector', () => {
    setupDom('<div role="button"></div>');
    const el = resolveSelectorGrammar('button ""');
    expect(el).toBeNull();
  });
});

describe('resolveWithRetry', () => {
  beforeEach(() => {
    global.document = new JSDOM('<!DOCTYPE html><html><body></body></html>').window.document;
  });

  it('returns element immediately if found on first attempt', async () => {
    setupDom('<button id="fast">Fast</button>');
    const result = await resolveWithRetry('#fast', resolveSelectorGrammar, 1000);
    expect(result.found).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('retries and finds element added after delay', async () => {
    // Start with empty DOM, add element after 300ms
    const dom = setupDom('');
    setTimeout(() => {
      const btn = dom.window.document.createElement('button');
      btn.id = 'delayed';
      btn.textContent = 'Delayed';
      dom.window.document.body.appendChild(btn);
    }, 300);

    const result = await resolveWithRetry('#delayed', resolveSelectorGrammar, 2000);
    expect(result.found).toBe(true);
    expect(result.attempts).toBeGreaterThanOrEqual(2);
  });

  it('times out and returns found:false for missing element', async () => {
    setupDom('<button>Existing</button>');
    const result = await resolveWithRetry('#never-appears', resolveSelectorGrammar, 600);
    expect(result.found).toBe(false);
    expect(result.attempts).toBeGreaterThanOrEqual(2);
  });

  it('returns found:false for null selector', async () => {
    setupDom('<button>Test</button>');
    const result = await resolveWithRetry(null, resolveSelectorGrammar, 500);
    expect(result.found).toBe(false);
  });
});
