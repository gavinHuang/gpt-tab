# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Chrome extension (Manifest V3) with two features:
1. **Tab UI** — injects a tabbed navigation into ChatGPT conversations (one tab per user question)
2. **AI Group Chat** — a persistent UI where ChatGPT, Gemini, and Claude all receive the same prompt and respond as if in a group discussion (brainstorm / debate / commentary modes)

## Loading the Extension

No build step. Load unpacked directly:
1. `chrome://extensions/` → Enable Developer mode → Load unpacked → select this directory
2. After editing any file, click the reload icon on the extension card, then refresh any open AI tabs

## Architecture

### Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest — two content script entries, `tabs`+`storage` permissions, no popup (action opens a tab) |
| `background.js` | Service worker — tab management, port registry, message queue/buffering, group-chat orchestration |
| `content.js` | Tab UI content script — injected only into chatgpt.com |
| `styles.css` | Tab UI styles — scoped to chatgpt.com |
| `ai-connector.js` | Group chat content script — injected into all three AI sites |
| `group-chat.html` + `group-chat.js` | Group chat UI page — opened as a tab when the extension icon is clicked |

### Port names

| Port name | Opened by | Purpose |
|---|---|---|
| `'tab-channel'` | `content.js` | Legacy cross-tab relay for the ChatGPT tab UI |
| `'ai-connector'` | `ai-connector.js` | Each AI tab ↔ background (identified by `port.sender.tab.id`) |
| `'group-chat'` | `group-chat.js` | Group chat page ↔ background |

### Group chat message flow

```
group-chat.js  →  OPEN_AI_TABS          →  background opens chatgpt/gemini/claude tabs
background     →  CONNECTOR_READY (×3)  →  as each ai-connector.js loads and connects
group-chat.js  →  INJECT_PROMPT (×3)    →  background routes to each tab's connector port
ai-connector   →  AI_RESPONSE streaming →  background forwards to group-chat port
ai-connector   →  AI_RESPONSE final     →  group-chat renders bubble, checks round complete
```

Background buffers `INJECT_PROMPT` messages in `aiRegistry[ai].queue` if the connector isn't ready yet (tab still loading), and flushes on `CONNECTOR_READY`.

### Key implementation details

**`ai-connector.js`** — self-identifies the site via `location.hostname`, then uses a per-site config object (`CONFIGS`) with selector chains and an `inject()` method. Injection uses `document.execCommand('insertText')` (triggers React/Vue synthetic events) or paste simulation via `ClipboardEvent`+`DataTransfer` for Quill. Response completion is detected by polling for the stop/generating button to disappear.

**DOM selectors** — the most fragile part; all three AI sites update their DOM regularly. Selectors are in the `CONFIGS` object at the top of `ai-connector.js` with fallback chains. Update here first when a site changes.

**`background.js`** — persists tab IDs in `chrome.storage.session` so the MV3 service worker can re-hydrate after going idle. Marks connectors as not-ready on `chrome.tabs.onUpdated` (status: loading) and re-accepts them on next `CONNECTOR_READY`.

**`group-chat.js`** — owns prompt building (`buildPrompt`) and round state. Prompts include the full history of previous rounds for context, with each AI seeing only the *other* AIs' prior responses. `pendingStart` flag handles the race where user clicks Start before all connectors are ready.

**Service worker death** — both `group-chat.js` and `ai-connector.js` reconnect their ports with `setTimeout(connect, 500)` on `onDisconnect`. Background re-hydrates state from `chrome.storage.session` on wake-up.
