import { describe, it, expect } from 'vitest';
import { validateSessionId, validateFilePath, validateUrl } from '../lib/validator.js';

// getArg is defined in wally.js but not exported.
// It's a simple utility: args.indexOf(name) → args[idx+1] or null.
// We test its logic here as a standalone function.
function getArg(args, name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

describe('getArg', () => {
  it('extracts value for existing flag', () => {
    expect(getArg(['--url', 'https://example.com'], '--url')).toBe('https://example.com');
  });

  it('returns null when flag is not present', () => {
    expect(getArg(['--url', 'https://example.com'], '--output')).toBeNull();
  });

  it('returns null when flag is last argument (no value)', () => {
    expect(getArg(['--url'], '--url')).toBeUndefined();
  });

  it('handles empty args array', () => {
    expect(getArg([], '--url')).toBeNull();
  });

  it('returns the value after the flag, not the flag itself', () => {
    const args = ['start', '--url', 'https://test.com', '--har'];
    expect(getArg(args, '--url')).toBe('https://test.com');
    // --har is last arg with no value following it — indexOf returns 3, args[4] is undefined
    expect(getArg(args, '--har')).toBeUndefined();
  });

  it('handles multiple flags correctly', () => {
    const args = ['--url', 'https://a.com', '--profile', 'Profile 1'];
    expect(getArg(args, '--url')).toBe('https://a.com');
    expect(getArg(args, '--profile')).toBe('Profile 1');
    expect(getArg(args, '--output')).toBeNull();
  });
});

describe('validateSessionId', () => {
  it('accepts valid alphanumeric ID', () => {
    expect(validateSessionId('abc123')).toEqual({ valid: true });
  });

  it('accepts ID with hyphens', () => {
    expect(validateSessionId('record-2024-01-01')).toEqual({ valid: true });
  });

  it('rejects null/undefined', () => {
    expect(validateSessionId(null).valid).toBe(false);
    expect(validateSessionId(undefined).valid).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateSessionId('').valid).toBe(false);
  });

  it('rejects non-string types', () => {
    expect(validateSessionId(123).valid).toBe(false);
  });

  it('rejects IDs with spaces', () => {
    const result = validateSessionId('abc 123');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('alphanumeric');
  });

  it('rejects IDs with special characters', () => {
    expect(validateSessionId('abc!@#').valid).toBe(false);
    expect(validateSessionId('abc;rm -rf /').valid).toBe(false);
    expect(validateSessionId('../etc/passwd').valid).toBe(false);
  });

  it('rejects IDs with shell metacharacters', () => {
    expect(validateSessionId('test$(whoami)').valid).toBe(false);
    expect(validateSessionId('test`id`').valid).toBe(false);
    expect(validateSessionId('test|cat').valid).toBe(false);
  });
});

describe('validateFilePath', () => {
  it('accepts valid relative path', () => {
    expect(validateFilePath('output/test.spec.js')).toEqual({ valid: true });
  });

  it('accepts simple filename', () => {
    expect(validateFilePath('test.js')).toEqual({ valid: true });
  });

  it('rejects null/undefined', () => {
    expect(validateFilePath(null).valid).toBe(false);
    expect(validateFilePath(undefined).valid).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateFilePath('').valid).toBe(false);
  });

  it('rejects path traversal', () => {
    const result = validateFilePath('../../etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('path traversal');
  });

  it('rejects shell metacharacters', () => {
    expect(validateFilePath('test;rm -rf /').valid).toBe(false);
    expect(validateFilePath('test|cat /etc/passwd').valid).toBe(false);
    expect(validateFilePath('test`whoami`').valid).toBe(false);
    expect(validateFilePath('test$(id)').valid).toBe(false);
    expect(validateFilePath('test&bg').valid).toBe(false);
    expect(validateFilePath('test>file').valid).toBe(false);
    expect(validateFilePath('test<input').valid).toBe(false);
    expect(validateFilePath('test{a,b}').valid).toBe(false);
    expect(validateFilePath('test[file]').valid).toBe(false);
  });

  it('rejects absolute path outside baseDir', () => {
    const result = validateFilePath('/etc/passwd', { baseDir: '/home/user' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('outside project');
  });

  it('accepts absolute path inside baseDir', () => {
    const result = validateFilePath('/home/user/output/test.js', { baseDir: '/home/user' });
    expect(result.valid).toBe(true);
  });

  it('accepts absolute path without baseDir', () => {
    expect(validateFilePath('/tmp/test.js')).toEqual({ valid: true });
  });
});

describe('validateUrl', () => {
  it('accepts valid HTTPS URL', () => {
    expect(validateUrl('https://example.com')).toEqual({ valid: true });
  });

  it('accepts valid HTTP URL', () => {
    expect(validateUrl('http://localhost:3000')).toEqual({ valid: true });
  });

  it('accepts URL with path and query', () => {
    expect(validateUrl('https://example.com/path?q=1&r=2')).toEqual({ valid: true });
  });

  it('rejects null/undefined', () => {
    expect(validateUrl(null).valid).toBe(false);
    expect(validateUrl(undefined).valid).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateUrl('').valid).toBe(false);
  });

  it('rejects non-string types', () => {
    expect(validateUrl(123).valid).toBe(false);
  });

  it('rejects URL without protocol', () => {
    const result = validateUrl('example.com');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must start with http:// or https://');
  });

  it('rejects FTP protocol', () => {
    expect(validateUrl('ftp://example.com').valid).toBe(false);
  });

  it('rejects javascript: protocol', () => {
    expect(validateUrl('javascript:alert(1)').valid).toBe(false);
  });

  it('rejects URL with spaces', () => {
    expect(validateUrl('https://exam ple.com').valid).toBe(false);
  });
});
