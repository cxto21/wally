/**
 * Wally Extension — CDP Debugger Helper (stub)
 *
 * The popup debugger path (chrome.debugger attach for cross-extension
 * pages) has been removed. chrome.debugger cannot attach to
 * chrome-extension:// URLs due to IsRestrictedUrl restrictions.
 *
 * This file is retained as a stub for potential future use (e.g.,
 * daemon bridge reusing CDP for non-extension pages).
 *
 * PR1 (wally-extension-fix): Removed dead popup debugger functions.
 * All recording now uses chrome.scripting.executeScript (MAIN world)
 * for web-only paths.
 */

// No exports — popup debugger path removed in PR1.
