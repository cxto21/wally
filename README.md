# Wally — Workflow Recorder

Records browser actions via Chrome CDP and exports Playwright tests. Works with any website and any wallet extension popup.

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
| `daemon start [--url] [--profile]` | Start background recording |
| `daemon stop` | Stop + show summary |
| `daemon status` | Show active pages + actions |
| `snap [--url]` | Snapshot current page |
| `record start/stop` | Manual recording |
| `export` | Export → Playwright test |

## How it works

1. Chrome runs with `--remote-debugging-port=9222`
2. Wally attaches via CDP and records clicks, fills, navigations
3. Extension popups are recorded automatically (localStorage bridge)
4. `daemon stop` + `export` generates a Playwright test

## Requirements

- Node.js ≥18
- `playwright` npm package
- Google Chrome
