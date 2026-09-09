# Wally Extension — Privacy Policy

## Data Collection

Wally records browser interactions (clicks, typing, navigation) to generate automated test scripts. All data stays on your device.

## What We Record

- DOM events: clicks, text input, navigation, form submissions
- Element selectors: CSS selectors, aria labels, text content
- Page URLs and titles
- Network requests (optional, for HAR generation)

## What We Don't Record

- Passwords (password fields are masked)
- Credit card numbers
- Personal data beyond what's visible on the page

## Data Storage

- Sessions are stored locally in `chrome.storage.local`
- No data is sent to external servers
- Bridge server runs on localhost only (127.0.0.1)

## Permissions

- `debugger`: Used to record interactions in browser extension popups
- `<all_urls>`: Required to record interactions on any website
- These permissions are only active during recording sessions

## Open Source

Wally is open source (MIT license). Based on OpenSidekick (MIT).
