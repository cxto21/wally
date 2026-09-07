/**
 * Wally Lock — PID-based file locking utility.
 *
 * Prevents concurrent daemon instances from running.
 * Uses JSON lock files with stale lock detection (checks if PID is alive).
 * Stale locks older than 1 hour are auto-released.
 *
 * @module lib/lock
 */
const fs = require('fs');
const os = require('os');

const STALE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

/**
 * Try to acquire a lock file. Throws if another process holds it.
 *
 * @param {string} lockPath - Absolute path to the lock file.
 * @returns {{ pid: number, acquired: boolean }} Lock metadata.
 * @throws {Error} If lock is held by a live process.
 */
function acquireLock(lockPath) {
  // Check existing lock
  if (fs.existsSync(lockPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const age = Date.now() - new Date(data.timestamp).getTime();

      // Check if holder process is alive
      const alive = isProcessAlive(data.pid);
      if (alive && age < STALE_TIMEOUT_MS) {
        throw new Error(
          `Lock held by PID ${data.pid} (${Math.round(age / 1000)}s old). ` +
          `Another daemon is running. Use "node wally.js daemon stop" first.`
        );
      }

      // Stale lock — auto-release
      if (!alive || age >= STALE_TIMEOUT_MS) {
        const reason = !alive ? `PID ${data.pid} not running` : `lock is ${Math.round(age / 1000)}s old (stale)`;
        releaseLock(lockPath, data.pid, reason);
      }
    } catch (e) {
      if (e.message.includes('Lock held')) throw e;
      // Corrupt lock file — remove and proceed
      releaseLock(lockPath, null, 'corrupt lock file');
    }
  }

  // Write lock
  const lockData = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
  };

  fs.mkdirSync(require('path').dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2));

  return { pid: process.pid, acquired: true };
}

/**
 * Release a lock file.
 *
 * @param {string} lockPath - Absolute path to the lock file.
 * @param {number|null} [pid] - PID that held the lock (for logging).
 * @param {string} [reason] - Reason for release (for logging).
 */
function releaseLock(lockPath, pid, reason) {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
    const msg = pid
      ? `[Lock] Released lock (PID ${pid})${reason ? ': ' + reason : ''}`
      : `[Lock] Released lock${reason ? ': ' + reason : ''}`;
    console.log(msg);
  } catch {
    // Best effort — file may already be gone
  }
}

/**
 * Check if a lock file exists and is held by a live process.
 *
 * @param {string} lockPath - Absolute path to the lock file.
 * @returns {boolean} true if a live process holds the lock.
 */
function isLocked(lockPath) {
  if (!fs.existsSync(lockPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const age = Date.now() - new Date(data.timestamp).getTime();
    return isProcessAlive(data.pid) && age < STALE_TIMEOUT_MS;
  } catch {
    return false;
  }
}

/**
 * Check if a process with the given PID is alive.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // Signal 0 = check existence without killing
    return true;
  } catch {
    return false;
  }
}

module.exports = { acquireLock, releaseLock, isLocked, isProcessAlive };
