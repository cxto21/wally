# Wally Extension

Browser interaction recorder — fork of OpenSidekick (MIT).

## Install (Developer)
1. Open `chrome://extensions`
2. Enable Developer mode
3. Load unpacked → select this directory
4. Pin the Wally icon

## Usage
- Click the Wally icon or press `Ctrl+E` to open the side panel
- Click **Start Recording** to begin capturing interactions
- Click **Stop Recording** when done
- Sessions are saved locally and can be exported via Wally CLI

## Bridge Mode
For auto-sync with Wally CLI:
1. Run `wally bridge start` in your terminal
2. The extension will automatically send sessions to the bridge
3. Use `wally create-skill` to generate agent skills from recordings

## Architecture
- `src/content/content-script.js` — DOM event capture + selector resolution
- `src/background/service-worker.js` — session lifecycle + keep-alive
- `src/background/cdp.js` — debugger-based popup recording
- `src/common/constants.js` — message types + RECORDING_SCRIPT
- `src/sidepanel/` — recording UI

## License
MIT — Based on [OpenSidekick](https://github.com/esterhuizen/opensidekick) (MIT).
