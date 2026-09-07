/**
 * Structured logging utility for Wally.
 *
 * @module lib/logger
 *
 * Usage:
 *   const { createLogger } = require('./lib/logger');
 *   const log = createLogger('daemon');
 *   log.info('Daemon started');
 *   log.debug('Polling actions');
 *   log.warn('Stale lock detected');
 *   log.error('CDP connection failed');
 *
 * Levels: debug < info < warn < error
 * Debug output is enabled when WALLY_VERBOSE=1 or NODE_ENV=debug.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function isEnabled(level) {
  const threshold =
    process.env.WALLY_VERBOSE === '1' || process.env.NODE_ENV === 'debug'
      ? 'debug'
      : 'info';
  return LEVELS[level] >= LEVELS[threshold];
}

function formatEntry(level, component, message) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    module: component,
    msg: message,
  });
}

/**
 * Create a logger bound to a specific component/module.
 *
 * @param {string} component - Module or component name (e.g. 'daemon', 'export').
 * @returns {{ info: Function, warn: Function, error: Function, debug: Function }}
 */
function createLogger(component) {
  return {
    info(msg) {
      if (isEnabled('info')) console.log(formatEntry('info', component, msg));
    },
    warn(msg) {
      if (isEnabled('warn')) console.warn(formatEntry('warn', component, msg));
    },
    error(msg) {
      console.error(formatEntry('error', component, msg));
    },
    debug(msg) {
      if (isEnabled('debug')) console.debug(formatEntry('debug', component, msg));
    },
  };
}

module.exports = { createLogger };
