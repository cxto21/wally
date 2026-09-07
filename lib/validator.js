/**
 * Input validation utilities for Wally CLI arguments.
 *
 * @module lib/validator
 *
 * Validates session IDs, file paths, and URLs to prevent injection
 * and path traversal attacks.
 */

const path = require('path');

/**
 * Validate a session ID — must contain only alphanumeric characters and hyphens.
 *
 * @param {string} id - The session ID to validate.
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSessionId(id) {
  if (!id || typeof id !== 'string') {
    return { valid: false, error: 'Session ID is required' };
  }
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    return {
      valid: false,
      error: `Invalid session ID "${id}": only alphanumeric characters and hyphens are allowed`,
    };
  }
  return { valid: true };
}

/**
 * Validate a file path — reject traversal, shell metacharacters.
 *
 * @param {string} filePath - The file path to validate.
 * @param {Object} [opts] - Options.
 * @param {string} [opts.baseDir] - Allowed base directory (defaults to cwd).
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFilePath(filePath, opts = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, error: 'File path is required' };
  }

  // Reject shell metacharacters
  if (/[;&|`$!<>{}()\[\]!#~]/.test(filePath)) {
    return {
      valid: false,
      error: `Invalid file path "${filePath}": contains disallowed characters`,
    };
  }

  // Reject path traversal
  if (filePath.includes('..')) {
    return {
      valid: false,
      error: `Invalid file path "${filePath}": path traversal ("..") is not allowed`,
    };
  }

  // Reject absolute paths outside project if baseDir specified
  if (opts.baseDir && path.isAbsolute(filePath)) {
    const resolved = path.resolve(filePath);
    const base = path.resolve(opts.baseDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return {
        valid: false,
        error: `Invalid file path "${filePath}": absolute path outside project directory`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate a URL — must start with http:// or https://.
 *
 * @param {string} url - The URL to validate.
 * @returns {{ valid: boolean, error?: string }}
 */
function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required' };
  }
  if (!/^https?:\/\/[^\s]+$/.test(url)) {
    return {
      valid: false,
      error: `Invalid URL "${url}": must start with http:// or https://`,
    };
  }
  return { valid: true };
}

module.exports = { validateSessionId, validateFilePath, validateUrl };
