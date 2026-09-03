# Wally — AI Workflow Recorder

> Built on libretto MIT primitives (saffron-health/libretto)

Wally is an AI-powered workflow recorder that captures browser actions via Chrome CDP and exports Playwright tests. It works with **any website** and **any wallet extension** (MetaMask, Ready, Argent, etc.).

## What is this?

Wally is our adaptation of [libretto](https://github.com/saffron-health/libretto) — an open-source AI toolkit for building browser automations. We've extended it with:

- **Wally Daemon** — background multi-page recorder that auto-detects extension popups
- **Generic wallet detection** — works with EVM, Starknet, and Solana wallets
- **Chrome CDP integration** — connects to existing Chrome sessions
- **Playwright test export** — generates runnable tests from recorded actions

## Quick Start

```bash
# Install dependencies
npm install

# Take a snapshot of the current page
node wally.js snap

# Start recording (interactive)
node wally.js record start
# ... interact with the browser ...
node wally.js record stop

# Start daemon (background, multi-page)
node wally.js daemon start --url https://ownerz.pages.dev
# ... interact with the browser ...
node wally.js daemon stop

# Export recorded actions to Playwright test
node wally.js export --output my-test.spec.js
```

## Commands

| Command | Description |
|---------|-------------|
| `snap` | Take a snapshot of the current page (accessibility tree) |
| `record start` | Start recording actions on current page |
| `record stop` | Stop recording and save session |
| `daemon start [--url <url>]` | Start background daemon (multi-page recording) |
| `daemon stop` | Stop daemon and show summary |
| `daemon status` | Show active pages + action counts |
| `wallet` | Connect wallet via CDP + handle extension |
| `export [--output <file>]` | Export recorded actions to Playwright test |

## How It Works

### 1. Chrome CDP Setup

Wally connects to Chrome via Chrome DevTools Protocol (CDP). You need to launch Chrome with remote debugging:

```bash
# Setup symlinked Profile 9 (for wallet extensions)
mkdir -p /tmp/wally-chrome
ln -sf ~/.config/google-chrome/Profile\ 9 /tmp/wally-chrome/Profile\ 9
cp ~/.config/google-chrome/Local\ State /tmp/wally-chrome/Local\ State

# Launch Chrome with CDP
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/wally-chrome "https://example.com"
```

### 2. Recording Actions

Wally injects a recording script that captures:
- **Clicks** — button/link clicks with smart selectors
- **Fills** — text input with values
- **Navigations** — page loads
- **Wallet connections** — wallet-specific flows

### 3. Multi-Page Recording (Daemon)

The daemon uses CDP Target discovery to automatically detect and attach to:
- Main page
- Extension popups (wallet windows)
- New tabs

### 4. Export to Playwright

Recorded actions are exported as runnable Playwright tests:
- Smart selectors (role-based, text-based, CSS)
- Page switching logic for extensions
- Proper waits and timeouts

## Architecture

```
wally/
├── wally.js              # Main CLI (6 commands)
├── lib/
│   ├── recorder.js       # Reusable recording module
│   └── daemon.js         # WallyDaemon class
├── examples/
│   └── ownerz-demo.js    # Example: Ownerz + Ready wallet
├── package.json
└── README.md
```

### Key Components

**wally.js** — Main CLI with 6 commands: snap, record, daemon, wallet, export

**lib/recorder.js** — Reusable recording module:
- `RECSOORDING_SCRIPT` — injected into pages to capture events
- `PRE_NAVIGATE_SCRIPT` — patches wallet detection (generic: EVM/Starknet/Solana)
- `getSnapshot(page)` — takes accessibility snapshot
- `readActions(sessionDir)` — reads recorded actions

**lib/daemon.js** — WallyDaemon class:
- CDP Target discovery (`Target.setDiscoverTargets`)
- Auto-attach to new pages
- Multi-page polling
- Actions recording with page context

## Generic Wallet Detection

Wally works with ANY wallet extension:

```javascript
// Detects and patches:
window.ethereum   // EVM wallets (MetaMask, etc.)
window.starknet   // Starknet wallets (Ready, Argent, Braavos)
window.solana     // Solana wallets (Phantom, etc.)
```

The `PRE_NAVIGATE_SCRIPT` intercepts `enable()` and `connect()` methods to capture wallet addresses.

## Example: Ownerz + Ready

```bash
# 1. Launch Chrome with Ready extension
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/wally-chrome "https://ownerz.pages.dev"

# 2. Start daemon
node wally.js daemon start --url https://ownerz.pages.dev

# 3. Click CONNECT button (via CDP)
# ... daemon records the action ...

# 4. Handle extension popup
# ... daemon auto-attaches to extension page ...

# 5. Stop daemon
node wally.js daemon stop

# 6. Export test
node wally.js export --output ownerz-test.spec.js
```

## Credits

Built on [libretto](https://github.com/saffron-health/libretto) by [Saffron Health](https://saffron.health) — MIT License.

Wally extends libretto with:
- Multi-page daemon recording
- Generic wallet detection
- Chrome CDP integration
- Playwright test export

## License

MIT
