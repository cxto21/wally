# Sidepanel UI Specification (Delta)

## Purpose

Restyle the Wally extension sidepanel to match the Wally GitHub Pages visual identity: dark `#0f1115` background, `#B8F5D8` mint accent, glassmorphism cards, pill buttons, system-ui typography, and green status indicator.

## ADDED Requirements

### Requirement: Pages Design Token System

The sidepanel MUST define CSS custom properties mapping Wally Pages tokens: `--wally-bg` (`#0f1115`), `--wally-mint` (`#B8F5D8`), `--wally-mint-hover` (`#A3EDC9`), `--wally-glass-bg` (`rgba(255,255,255,0.08)`), `--wally-glass-border` (`rgba(255,255,255,0.18)`), `--wally-glass-blur` (`blur(12px)`), `--wally-text-primary` (`#fff`), `--wally-text-secondary` (`rgba(255,255,255,0.85)`), `--wally-text-muted` (`rgba(255,255,255,0.42)`), `--wally-status-green` (`#4ADE80`).

#### Scenario: CSS variables available on body

- GIVEN the sidepanel.html loads
- WHEN the page renders
- THEN all `--wally-*` custom properties are defined on `:root` and accessible to child elements

### Requirement: Glass Card Components

Card-like containers (session list items, log entries, status panels) MUST use `background: var(--wally-glass-bg)`, `border: 1px solid var(--wally-glass-border)`, `backdrop-filter: var(--wally-glass-blur)`, and `border-radius: 16px`.

#### Scenario: Session card renders with glass effect

- GIVEN the sidepanel shows a recorded session
- WHEN the session card is rendered
- THEN it has a translucent background with backdrop blur and rounded corners

### Requirement: Pill Button Style

Primary action buttons (Record, Stop, Export) MUST use `border-radius: 999px`, `background: var(--wally-mint)`, `color: #0f1115`, and `font-weight: 600`.

#### Scenario: Record button renders as pill

- GIVEN the sidepanel is in idle state
- WHEN the Record button is visible
- THEN it is a pill-shaped button with mint background and dark text

### Requirement: System-UI Typography

The sidepanel body font MUST be `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`. Code/monospace elements MUST use `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.

#### Scenario: Body text uses system font

- GIVEN the sidepanel renders any text
- WHEN the font is inspected
- THEN it resolves to the system UI font stack

## MODIFIED Requirements

### Requirement: Background Color

The sidepanel body background MUST be `#0f1115`.

(Previously: `#1a1a2e`)

#### Scenario: Sidepanel opens with correct background

- GIVEN the user opens the Wally sidepanel
- WHEN the panel renders
- THEN the background color is `#0f1115`

### Requirement: Accent Color

All accent-colored elements (active states, highlights, links) MUST use `#B8F5D8` (mint).

(Previously: `#ff6b35` (orange))

#### Scenario: Active tab shows mint accent

- GIVEN the sidepanel has tab navigation
- WHEN a tab is active
- THEN its indicator or highlight color is `#B8F5D8`

### Requirement: Status Dot Colors

The recording status dot MUST use `#ef4444` when recording and `#4ADE80` when idle.

(Previously: `#ff6b6b` when recording, `currentColor` when idle)

#### Scenario: Idle status shows green dot

- GIVEN the sidepanel is not recording
- WHEN the status indicator renders
- THEN the dot color is `#4ADE80`

#### Scenario: Recording status shows red dot

- GIVEN a recording is active
- WHEN the status indicator renders
- THEN the dot color is `#ef4444`

### Requirement: Input Field Styling

Text inputs and textareas MUST use `background: #0f1115`, `border: 1px solid rgba(255,255,255,0.18)`, `border-radius: 8px`, `color: rgba(255,255,255,0.85)`.

(Previously: `background: #2d2d44`, `border: 1px solid #3d3d5c`, `border-radius: 6px`)

#### Scenario: URL input renders with new tokens

- GIVEN the sidepanel shows the URL input field
- WHEN the field renders
- THEN it has a dark `#0f1115` background with a subtle glass border and rounded corners
