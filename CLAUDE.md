# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

PhysiQ-Force is a Web Bluetooth force measurement app for physiotherapy. It connects to a Progressor device via the Web Bluetooth API to measure muscle contraction force and saves results to the shared PhysiQ session.

**Deployment:** GitHub Pages — push to `main` deploys automatically. The hub (`physiodevapp.github.io/physiq/`) is the primary entry point; this app is also accessible standalone.

## Development

No build step, no package manager, no dependencies. Static HTML/CSS/JS.

Run locally:
```
npx serve .
```

## Commit format

Always use this format when committing:

```
git commit -m "short imperative title" -m "description when needed"
```

- First `-m` is the title (max ~72 characters)
- Second `-m` is only included when there is relevant context to add
- Never use `git commit` without flags or interactive editors
- **Never add co-authorship** (`Co-authored-by`) under any circumstance

## Pull request format

- PR body: plain description only — no `🤖 Generated with Claude Code` line, no session URLs, no co-authorship footers

## File Architecture

| File | Role |
|------|------|
| `index.html` | DOM structure + all embedded CSS |
| `app.js` | BLE logic, state, measurement flow, UI updates |
| `lib/session.js` | Shared IDB session helpers (`openSessionDB`, `readSession`, `writeSession`, `updateSession`, `clearSession`) |
| `sw.js` | Service Worker (`physiq-force-v1`, network-first) |
| `favicon.svg` | App icon |

## Design System

Identical to other PhysiQ satellites:

- **Fonts:** Outfit (body), DM Mono (labels/data), DM Serif Display (titles/logo)
- **Background:** `--bg: #0a0d12`, `--surface: #111620`, `--surface2: #171e2e`
- **Accent:** `--accent: #4f9cf9` (blue), `--accent2: #38d9a9` (green)

## BLE Architecture

Uses the Web Bluetooth API to connect to a **Progressor** device.

| Constant | UUID |
|----------|------|
| `PROGRESSOR_SERVICE` | `7e4e1701-…` |
| `DATA_CHAR` | `7e4e1702-…` |
| `CTRL_CHAR` | `7e4e1703-…` |

Commands sent via `CTRL_CHAR` (`CMD`): `TARE` (100), `START_WEIGHT` (101), `STOP_WEIGHT` (102), `GET_VERSION` (107), `SLEEP` (110), `GET_BATTERY` (111).

Responses received via `DATA_CHAR` notifications (`RES`): `CMD_RESPONSE` (0), `WEIGHT_MEAS` (1), `LOW_PWR_WARNING` (4).

## Session Persistence

IDB (`lib/session.js`) is the only persistence layer — no localStorage.

**Session helpers** (`lib/session.js` — same contract in every physiq repo):
- `openSessionDB()` — opens DB v3, creates `'session'` store on upgrade
- `readSession()` — reads `'active'`, returns null if expired (TTL 24h)
- `writeSession(patch)` — merge-writes into `'active'`, **creates if absent**
- `updateSession(patch)` — atomic read-modify-write; **returns null if no session exists** (never creates one)
- `clearSession()` — deletes `'active'`

**Write triggers** (explicit user actions only):
- `_saveResults()` — writes `{ force: _savedResults, patient, date }` after saving a measurement set
- `_deleteSavedResult(timestamp)` — removes one result by timestamp, writes `{ force: _savedResults }`, broadcasts `SESSION_FORCE`
- `_persistPatient()` — writes `{ patient, date }` after the patient name input changes

physiq-force is the **source of truth** for the session ghost-write pattern: `writeSession` is only called on explicit user actions, so there is no risk of stale in-flight writes recreating a deleted session. No `_sessionGen`/`_sessionCleared` guards are needed.

**`SESSION_PATIENT` handler** — updates `_patient` in memory and re-renders; does **not** write to IDB.

**`_softReset()`** — clears all local measurement state and broadcasts `SESSION_FORCE: []`; does **not** call `writeSession` or `clearSession`.

**`promptClearSession()`** — `_softReset()` → `clearSession()` → broadcast `SESSION_CLEAR`.

**`SESSION_CLEAR` handler (external)** — `_softReset()` + `clearSession()`. Calling `clearSession()` here mirrors motion's behavior: if another satellite initiates the clear, force removes its own IDB entry rather than leaving stale data that would be restored on next startup.

**On startup:** `readSession()` restores force results and patient name if a session exists.

## BroadcastChannel protocol

All satellites use `const _sessionCh = new BroadcastChannel('physiq-session')`.

Messages emitted by physiq-force:

| Type | When | Payload |
|------|------|---------|
| `SESSION_PATIENT` | after `_persistPatient()` | `{ patient: string }` |
| `SESSION_FORCE` | after `_saveResults()`, `_deleteSavedResult()`, or `_softReset()` | `{ force: array \| [] }` |
| `SESSION_CLEAR` | after `promptClearSession()` | — |

Messages received:

| Type | Action |
|------|--------|
| `SESSION_PATIENT` | Updates `_patient` in memory, re-renders — no IDB write |
| `SESSION_CLEAR` | `_softReset()` + `clearSession()` |

## Dialogs

All confirmations use `showConfirmBanner(title, text, actionLabel, onConfirm)` — never use the native `confirm()` or `alert()`.

## Hub integration

physiq-force runs inside an iframe in the PhysiQ hub. On load:

```js
try { if (window.self !== window.top) document.body.classList.add('in-hub'); }
catch (_) { document.body.classList.add('in-hub'); }
```

Clicking the logo sends `{ type: 'PHYSIQ_GO_HOME' }` to the parent. `showConfirmBanner` in physiq-force does **not** send `PHYSIQ_WIDGET_HIDE/SHOW` (the recorder widget is not relevant to force measurement modals).

## Sibling repos

The hub at `physiodevapp.github.io/physiq/` is the primary entry point for the ecosystem.

| Repo | Hub path | Role |
|------|----------|------|
| physiq-assessment | /physiq/assessment/ | 5-phase clinical assessment |
| physiq-motion | /physiq/motion/ | Joint ROM measurement |
| physiq-report | /physiq/report/ | Audio transcription + Claude report generation |
