# Branching Conversation — Design Document

## 1. Problem Statement

ChatGPT's linear chat interface forces a single thread of thought. Once you follow up on an answer one way, the other possible directions are lost. This document specifies a branching conversation feature built as a Chrome extension overlay on top of ChatGPT, extending the existing tab-per-question UI.

---

## 2. Goals & Non-Goals

### Goals
- Let users branch from any AI answer into multiple independent follow-up directions
- Keep the base UX familiar — linear chat remains the default feel
- Store the branch tree locally in the extension (no server required)
- Integrate naturally with the existing tab bar UI in `content.js`

### Non-Goals
- Modifying ChatGPT's server-side conversation state
- Syncing branch trees across devices
- Supporting Gemini or Claude branching (v1 is ChatGPT-only)
- A full graph/canvas view (deferred to v2)

---

## 3. Mental Model

A conversation is a **tree**, not a list.

```
Root Q
├── A1 (ChatGPT answer)
│   ├── [Branch: Deeper explanation]  → new chat, pre-seeded context
│   ├── [Branch: Challenge this]      → new chat, pre-seeded context
│   └── [Branch: Give an example]    → new chat, pre-seeded context
└── (future: re-ask root differently)
```

Each **node** = one Q&A turn (user question + AI answer).  
Each **branch** = a new ChatGPT conversation that begins with reconstructed context from its parent chain.

The extension owns the tree structure. ChatGPT owns the individual conversations.

---

## 4. Data Model

Stored in `chrome.storage.local` under key `branchTree`.

```js
// BranchTree
{
  version: 1,
  trees: {
    [treeId]: {
      id: string,          // uuid
      createdAt: number,   // unix ms
      label: string,       // auto-generated from root question
      rootNodeId: string,
      nodes: {
        [nodeId]: Node
      }
    }
  }
}

// Node
{
  id: string,              // uuid
  parentId: string | null, // null for root
  children: string[],      // child node ids
  convId: string,          // ChatGPT conversation UUID (from URL /c/<convId>)
  turnIndex: number,       // which Q&A turn in that conversation this node represents
  label: string,           // display label (branch type or user-edited)
  branchType: string,      // 'root' | 'deeper' | 'challenge' | 'example' | 'custom'
  createdAt: number,
  messageId: string | null // ChatGPT message-id of the user turn (for timestamp recovery)
}
```

**Key design decision:** each branch is a separate ChatGPT conversation. This sidesteps any attempt to manipulate ChatGPT's conversation history, which is fragile and undocumented. The branch's opening prompt carries reconstructed context from its ancestor chain.

---

## 5. UI Design

### 5.1 Branch Buttons (injected under each AI answer)

After each AI response turn, `content.js` injects a row of branch buttons:

```
┌─────────────────────────────────────────────────────────┐
│  ChatGPT answer text...                                  │
│                                                          │
│  [🔍 Go deeper]  [⚔ Challenge]  [💡 Example]  [+ Custom]│
└─────────────────────────────────────────────────────────┘
```

- Buttons are **hidden by default**, revealed on hover of the answer block
- `+ Custom` opens an inline text input for a free-form follow-up
- Clicking any button triggers **branch creation** (see §6)

Visual style: small, muted pill buttons below the answer. Active branch gets a highlighted pill. CSS lives in `styles.css`, scoped to `#gpt-branch-bar`.

### 5.2 Tab Bar (extended)

The existing tab bar (`#gpt-tabs-container`) gains two new behaviors:

**Branch indicator on tabs:**
```
[ Q1 ]  [ Q2 ⑃ ]  [ Q3 ]
          ↑ has branches
```
A small fork icon (⑃) appears on any tab that has active branches.

**Active branch sub-tabs** (shown when a branched tab is active):
```
[ Q2 ⑃ ] — active tab
  ↳ [main]  [🔍 Deeper]  [⚔ Challenge*]   ← sub-tab bar
                              ↑ currently viewing
```
Sub-tabs sit below the main tab bar, visually indented. Clicking one navigates to that branch's conversation and highlights the relevant turn.

### 5.3 Branch Breadcrumb

When viewing a branch conversation, a breadcrumb is injected at the top of the chat:

```
🌿 Branched from: "What is the halting problem?" → Go deeper
   [← Back to parent]
```

Clicking "Back to parent" navigates to the parent conversation and scrolls to the originating turn.

### 5.4 Focus Mode

When on a branch, sibling branches are not shown in the main view. The sub-tab bar makes them accessible. This prevents cognitive overload — the user is always "on one path."

---

## 6. Interaction Flows

### 6.1 Creating a Branch

1. User hovers over an AI answer → branch button row appears
2. User clicks `[🔍 Go deeper]`
3. Extension:
   a. Records current conversation ID and turn index
   b. Reconstructs context prompt (see §7)
   c. Opens a new ChatGPT tab (`https://chatgpt.com/`) via `chrome.tabs.create`
   d. Waits for `content.js` to signal page ready
   e. Injects the context prompt via the existing `ai-connector.js` injection mechanism
   f. Creates a new `Node` in the branch tree, linking it to the parent node
   g. Updates the tab bar to show the fork indicator on the parent tab

### 6.2 Navigating Back to Parent

1. User clicks "← Back to parent" in the breadcrumb
2. Extension looks up parent node's `convId` and `turnIndex`
3. Navigates to `https://chatgpt.com/c/<convId>`
4. Scrolls to the correct turn (by `data-message-id` or turn index)
5. Highlights the branched turn briefly (CSS flash animation)

### 6.3 Switching Between Sibling Branches

1. User clicks a sub-tab (e.g., `[⚔ Challenge]`)
2. Extension looks up that node's `convId`
3. Opens or focuses that conversation's tab
4. Sub-tab updates active state

### 6.4 Renaming a Branch

1. User double-clicks a sub-tab label
2. Inline text input appears, pre-filled with current label
3. On blur/Enter, label is saved to `branchTree` in storage
4. Sub-tab re-renders

---

## 7. Context Prompt Construction

When branching, the extension synthesizes a prompt that gives the new conversation full context. This is the most important part of making branches feel coherent.

### Template

```
[Context from parent conversation]

Q: <original user question>
A: <AI answer text, trimmed to ~500 chars if long>

[Branch direction: Go deeper]

<branch-specific prefix> <user's custom text if any>
```

### Branch-type prefixes

| Branch Type | Injected prefix |
|---|---|
| `deeper` | "Let's go deeper on this. Elaborate on the key mechanisms and nuances:" |
| `challenge` | "I want to challenge this answer. What are the strongest counterarguments or limitations?" |
| `example` | "Give me a concrete real-world example that illustrates this:" |
| `custom` | (user's own text, no prefix) |

The context block is minimal — just the immediate parent Q&A. For deeper trees (grandparent chains), include a summary prefix: "This conversation is part of a longer exploration. Briefly: [grandparent Q summary] → [parent Q summary]."

---

## 8. Storage Strategy

| What | Where | Why |
|---|---|---|
| Branch tree (nodes, labels, convIds) | `chrome.storage.local` | Persistent, survives browser restart |
| Active branch view state (which sub-tab is shown) | `chrome.storage.session` | Ephemeral, reset on browser close |
| convId → treeId/nodeId lookup | `chrome.storage.local` | Needed on page load to know if current convo is a branch |

**On every ChatGPT page load**, `content.js` checks: "is the current `convId` in my branch tree?" If yes, it restores the breadcrumb and sub-tab bar.

Storage is keyed by `convId` for fast lookup:
```js
convIdIndex: {
  [convId]: { treeId, nodeId }
}
```

---

## 9. File Changes

| File | Changes |
|---|---|
| `content.js` | Inject branch buttons; render sub-tab bar; render breadcrumb; on-load check if current page is a known branch |
| `styles.css` | Styles for branch buttons, sub-tab bar, breadcrumb, fork indicator |
| `background.js` | Handle `CREATE_BRANCH` message: open new tab, inject prompt, store node |
| `branch-store.js` *(new)* | CRUD helpers for the branch tree in `chrome.storage.local` |
| `manifest.json` | Add `branch-store.js` to content script list (or load it as a module) |

No new HTML pages needed for v1.

---

## 10. Message Protocol (content.js ↔ background.js)

New message types added to the existing `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` channels:

```js
// content.js → background.js
{ type: 'CREATE_BRANCH', convId, turnIndex, messageId, branchType, customText }

// background.js → content.js (response)
{ type: 'BRANCH_CREATED', nodeId, newConvId, newTabId }

// content.js → background.js (on page load)
{ type: 'CHECK_BRANCH', convId }

// background.js → content.js (response)
{ type: 'BRANCH_INFO', isBranch: true, node, parentNode } 
  // or { type: 'BRANCH_INFO', isBranch: false }
```

---

## 11. Edge Cases & Risks

| Risk | Mitigation |
|---|---|
| ChatGPT URL format changes | `convId` extracted via regex `/\/c\/([^/?#]+)/` — isolated in one helper |
| User manually deletes a branch conversation | Node stays in tree but marked `orphaned: true`; sub-tab shows strikethrough |
| Branch created before parent answer is complete | Branch button only appears after the stop-generating button disappears (reuse existing polling in `content.js`) |
| Storage quota | `chrome.storage.local` has 10MB; a tree node is ~300 bytes; supports ~33k nodes before issues — add a prune-old-trees utility if needed |
| Service worker death mid-branch-creation | Background stores partial `CREATE_BRANCH` intent in `chrome.storage.session`; retries on next wake-up |
| User navigates away during prompt injection | Tab `onUpdated` fires; background aborts injection and marks node `injectionFailed` |
| Circular branches | Prevented structurally — each node has exactly one parent (tree, not graph) |

---

## 12. Phased Rollout

### Phase 1 — Core branching (MVP)
- Branch buttons (hover-reveal) on AI answers
- Opens new tab with context prompt injected
- Fork indicator on tab bar
- `branch-store.js` with basic CRUD

### Phase 2 — Navigation
- Sub-tab bar for sibling branches
- Breadcrumb with back-navigation
- On-load branch detection and UI restoration

### Phase 3 — Polish
- Branch renaming (double-click sub-tab)
- AI-suggested branch directions (after AI answer, show "You might want to explore: …")
- Orphaned branch detection and cleanup UI
- Branch label auto-generation from first branch message

### Phase 4 — Power features (future)
- Collapsible sidebar tree view of the full conversation graph
- "Merge branches" — prompt that summarizes differences across branches
- Export branch tree as markdown outline

---

## 13. Open Questions

1. **Prompt injection mechanism** — should branch creation reuse `ai-connector.js`'s injection, or does `background.js` drive it directly via `scripting.executeScript`? (Prefer reuse for consistency.)
2. **Tab management** — should each branch open in a new Chrome tab, or navigate the current tab? (New tab preferred — lets user compare branches side-by-side.)
3. **Context length** — for deep trees (5+ levels), the reconstructed context prompt can get long. Should we summarize intermediate nodes, or include them raw?
4. **Sub-tab bar position** — below main tab bar (current plan) vs. sidebar panel. Below is simpler to implement; sidebar gives more space for many branches.
