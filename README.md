# Wally — Browser & Extension Interaction Recorder

Records browser actions and extension popups (any `chrome-extension://`) via Chrome CDP. Captures clicks, fills, navigations, and extension interactions and exports standalone Playwright test scripts. Works with any website and any Chrome extension.

## Quick Start

```bash
npm install playwright
node wally.js daemon start --url https://avnu.fi
```

Wally will ask to launch Chrome if CDP is not running. Use `--profile` to pick a Chrome profile:

```bash
node wally.js daemon start --profile "Profile 9" --url https://avnu.fi
```

## Commands

| Command | Description |
|---|---|
| `daemon start [--url] [--profile] [--har] [--har-output]` | Start background recording (with optional network capture) |
| `daemon stop` | Stop + show summary |
| `daemon status` | Show active pages + actions |
| `snap [--url]` | Snapshot current page |
| `record start/stop` | Manual recording |
| `export` | Export → Playwright test |
| `exec "<code>" [--file] [--page] [--snapshot]` | Execute Playwright JS live against Chrome |
| `exec --help` | Show exec usage |

## How it works

1. Chrome runs with `--remote-debugging-port=9222`
2. Wally attaches via CDP and records clicks, fills, navigations
3. Extension popups and extension pages are recorded automatically
4. `daemon stop` + `export` generates a Playwright test

## Debug live with `wally exec`

Execute arbitrary Playwright JS against the live Chrome without restarting the browser. Useful for debugging selectors and quick experiments.

```bash
node wally.js exec "return await page.title()"
node wally.js exec "await page.getByRole('button', {name: /Approve/}).click()"
node wally.js exec --file ./snippet.js --snapshot
echo "return await page.url()" | node wally.js exec
```

Context available: `page` (main or `--page ext`), `context`, `browser`. Supports `await`.

Options: `--page <ext|main>` (default `main`), `--timeout 30000`, `--snapshot` (print compact accessibility tree after exec).

## Network capture (`--har`)

Enable network capture to collect HTTP requests via CDP `Network` domain. Generates `network.jsonl` (raw events) and `network.har` (HAR 1.2) alongside `actions.jsonl`.

```bash
node wally.js daemon start --har
node wally.js daemon start --har --har-output /tmp/out.har
node wally.js daemon status   # shows network events count
# After stop, find files in .records/<sessionId>/network.har
```

## Requirements

- Node.js ≥18
- `playwright` npm package
- Google Chrome
