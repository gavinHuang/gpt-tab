importScripts('branch-store.js');

// ── State ─────────────────────────────────────────────────────────────────────
const AI_NAMES = ['gemini', 'claude'];
const AI_URL_PATTERNS = {
    chatgpt: 'https://chatgpt.com/*',
    gemini:  'https://gemini.google.com/*',
    claude:  'https://claude.ai/*',
};
const AI_OPEN_URLS = {
    chatgpt: 'https://chatgpt.com/',
    gemini:  'https://gemini.google.com/app',
    claude:  'https://claude.ai/new',
};

// Tab IDs only — no ports, no ready-state for AI tabs
const aiTabIds = { chatgpt: null, gemini: null, claude: null };
let groupChatTabId = null;
let groupChatPort = null;
let groupChatBuffer = []; // messages queued while port is disconnected
const tabChannelPorts = new Map();

// ── Branch tab tracking ───────────────────────────────────────────────────────
// Tracks tabs opened for branch creation so we can:
//  a) inject the prompt when they finish loading
//  b) capture the new convId when ChatGPT navigates to /c/<uuid>
//  c) avoid updating aiTabIds for group-chat with branch tabs

const branchTabIds          = new Set();   // tab IDs opened for branches
const pendingBranchInject   = new Map();   // tabId → { promptText, nodeId, treeId }
const pendingConvCapture    = new Map();   // tabId → { nodeId, treeId }

function postToGroupChat(msg) {
    if (groupChatPort) {
        try { groupChatPort.postMessage(msg); return; } catch { groupChatPort = null; }
    }
    groupChatBuffer.push(msg);
}

// ── Restore state on SW wake-up ───────────────────────────────────────────────
chrome.storage.session.get(['groupChatTabId', 'aiTabIds'], (data) => {
    if (data.groupChatTabId) groupChatTabId = data.groupChatTabId;
    if (data.aiTabIds) Object.assign(aiTabIds, data.aiTabIds);
});

function persist() {
    chrome.storage.session.set({ groupChatTabId, aiTabIds: { ...aiTabIds } });
}

function aiFromUrl(url = '') {
    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) return 'chatgpt';
    if (url.includes('gemini.google.com')) return 'gemini';
    if (url.includes('claude.ai')) return 'claude';
    return null;
}

// ── Extension icon ────────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(() => {
    const url = chrome.runtime.getURL('group-chat.html');
    if (groupChatTabId) {
        chrome.tabs.get(groupChatTabId, (tab) => {
            if (chrome.runtime.lastError || !tab) { createGroupChatTab(url); }
            else {
                chrome.tabs.update(groupChatTabId, { active: true });
                chrome.windows.update(tab.windowId, { focused: true });
            }
        });
    } else {
        createGroupChatTab(url);
    }
});

function createGroupChatTab(url) {
    chrome.tabs.create({ url }, (tab) => { groupChatTabId = tab.id; persist(); });
}

// ── Ports: group-chat and tab-channel only ────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'group-chat') {
        groupChatPort = port;
        groupChatTabId = port.sender?.tab?.id ?? groupChatTabId;
        persist();
        port.onMessage.addListener(handleGroupChatMessage);
        port.onDisconnect.addListener(() => { groupChatPort = null; });
        // Flush any messages buffered while the port was disconnected (e.g. SW death)
        const toFlush = groupChatBuffer.splice(0);
        for (const m of toFlush) { try { port.postMessage(m); } catch {} }
        return;
    }

    if (port.name === 'tab-channel') {
        const tabId = port.sender?.tab?.id;
        if (!tabId) return;
        tabChannelPorts.set(tabId, port);
        port.onMessage.addListener((msg) => {
            for (const [id, p] of tabChannelPorts) {
                if (id !== tabId) { try { p.postMessage({ ...msg, fromTabId: tabId }); } catch { tabChannelPorts.delete(id); } }
            }
        });
        port.onDisconnect.addListener(() => tabChannelPorts.delete(tabId));
        return;
    }
});

// ── Messages from content scripts and AI connectors ──────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Group-chat connector messages
    if (msg.type === 'CONNECTOR_READY') {
        const ai = aiFromUrl(sender.tab?.url || '');
        // Don't let branch tabs overwrite group-chat AI tab IDs
        if (ai && sender.tab?.id && !branchTabIds.has(sender.tab.id)) {
            aiTabIds[ai] = sender.tab.id;
            persist();
        }
        postToGroupChat(msg);
        return;
    }
    if (msg.type === 'AI_RESPONSE' || msg.type === 'CONNECTOR_ERROR') {
        postToGroupChat(msg);
        return;
    }

    // Branch: content.js reports its convId on SPA navigation
    if (msg.type === 'REPORT_CONV_ID') {
        const tabId  = sender.tab?.id;
        const pending = tabId && pendingConvCapture.get(tabId);
        if (pending && msg.convId) {
            pendingConvCapture.delete(tabId);
            bgUpdateNodeConvId(pending.treeId, pending.nodeId, msg.convId);
        }
        return;
    }

    // Branch: create a new branch conversation
    if (msg.type === 'CREATE_BRANCH') {
        handleCreateBranch(msg, sender).then(result => sendResponse(result)).catch(() => sendResponse(null));
        return true; // async
    }

    // Branch: check if a convId is a known branch
    if (msg.type === 'CHECK_BRANCH') {
        bgCheckBranch(msg.convId).then(sendResponse).catch(() => sendResponse({ isBranch: false }));
        return true;
    }

    // Branch: get all child branches of a conversation, grouped by turn index
    if (msg.type === 'GET_BRANCH_CHILDREN') {
        bgGetBranchChildren(msg.convId).then(sendResponse).catch(() => sendResponse({}));
        return true;
    }
});

// ── Branch creation ───────────────────────────────────────────────────────────

async function handleCreateBranch(msg, sender) {
    const { convId, turnIndex, messageId, branchType, customText, questionText, answerText } = msg;

    const promptText = buildBranchPrompt({ questionText, answerText, branchType, customText });
    const label      = branchType === 'custom'
        ? (customText || 'Custom').slice(0, 40)
        : BRANCH_LABELS[branchType];

    const { nodeId, treeId } = await bgCreateNode({
        parentConvId: convId,
        turnIndex,
        messageId,
        branchType,
        label,
        questionText,
    });

    // Open a new ChatGPT tab — content.js will inject the prompt via DOM
    const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
    branchTabIds.add(tab.id);
    pendingBranchInject.set(tab.id, { promptText, nodeId, treeId });
    // NOTE: pendingConvCapture is NOT set here — we set it after injection so that
    // ChatGPT's initial router navigation (which pushes the last-visited /c/<id>)
    // doesn't consume the capture slot with the wrong convId.

    return { nodeId };
}

// When the branch tab finishes loading, inject the prompt text into the input box
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (!pendingBranchInject.has(tabId)) return;
    if (changeInfo.status !== 'complete') return;

    const { promptText, nodeId, treeId } = pendingBranchInject.get(tabId);
    pendingBranchInject.delete(tabId);

    // Wait for React to mount the editor (ChatGPT is a Next.js SPA)
    await new Promise(r => setTimeout(r, 1500));

    await injectBranchPrompt(tabId, promptText);

    // Only start capturing convId AFTER injection — ChatGPT's initial router may
    // have already fired history.pushState (to the last-visited conversation) before
    // our prompt was submitted, so we must not capture that earlier navigation.
    pendingConvCapture.set(tabId, { nodeId, treeId });
});

async function injectBranchPrompt(tabId, promptText) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (text) => {
                // ChatGPT uses a ProseMirror contenteditable div
                const editor =
                    document.querySelector('#prompt-textarea') ||
                    document.querySelector('div[contenteditable="true"][data-id]') ||
                    document.querySelector('div[contenteditable="true"]');
                if (!editor) { console.log('[Branch] editor not found'); return; }

                editor.focus();
                // Select all existing content via Range (more reliable than execCommand selectAll
                // inside executeScript where document focus may not be on the editor)
                const range = document.createRange();
                range.selectNodeContents(editor);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                document.execCommand('insertText', false, text);

                // Poll for the Send button to become enabled (React needs a tick to
                // update state after the insertText input event)
                let attempts = 0;
                const tryClick = () => {
                    const btn =
                        document.querySelector('[data-testid="send-button"]') ||
                        document.querySelector('button[aria-label*="Send"]') ||
                        document.querySelector('button[aria-label*="send"]');
                    if (btn && !btn.disabled) {
                        btn.click();
                    } else if (attempts++ < 15) {
                        setTimeout(tryClick, 200);
                    }
                };
                setTimeout(tryClick, 200);
            },
            args: [promptText],
        });
    } catch (e) {
        console.log('[BG] Branch prompt injection failed:', e.message);
    }
}

// ── Group-chat message handler ────────────────────────────────────────────────
async function handleGroupChatMessage(msg) {
    if (msg.type === 'OPEN_AI_TABS') {
        try { await openAITabs(); } catch (e) { console.log('[BG] openAITabs error:', e.message); }
    }
    if (msg.type === 'INJECT_PROMPT') {
        await sendPromptToAI(msg.ai, msg.promptText, msg.roundNumber, msg.arkoseToken);
    }
}

// ── Tab management ────────────────────────────────────────────────────────────
async function openAITabs() {
    for (const ai of AI_NAMES) {
        // Validate existing tab
        if (aiTabIds[ai]) {
            try { await chrome.tabs.get(aiTabIds[ai]); }
            catch { aiTabIds[ai] = null; }
        }

        // Find or create
        if (!aiTabIds[ai]) {
            const existing = await chrome.tabs.query({ url: AI_URL_PATTERNS[ai] });
            if (existing.length > 0) {
                aiTabIds[ai] = existing[0].id;
                // Claude: non-chat pages (/projects, /settings, etc.) have no input field.
                // Navigate to /new if the existing tab isn't already on a chat page.
                if (ai === 'claude') {
                    const url = existing[0].url || '';
                    if (!url.includes('/new') && !url.includes('/chat')) {
                        await chrome.tabs.update(aiTabIds[ai], { url: AI_OPEN_URLS[ai] });
                    }
                }
            } else {
                const tab = await chrome.tabs.create({ url: AI_OPEN_URLS[ai], active: false });
                aiTabIds[ai] = tab.id;
            }
        }

        // Inject connector (sends CONNECTOR_READY when done)
        await injectConnector(ai, aiTabIds[ai]);
    }
    persist();
}

async function injectConnector(ai, tabId) {
    console.log(`[BG] injecting connector into ${ai} tab ${tabId}`);
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['ai-connector.js'] });
        console.log(`[BG] injection succeeded for ${ai} tab ${tabId}`);
    } catch (e) {
        console.log(`[BG] ${ai}: injection FAILED: ${e.message}`);
    }
}

chrome.tabs.onRemoved.addListener((tabId) => {
    const ai = Object.keys(aiTabIds).find(a => aiTabIds[a] === tabId);
    if (ai) { aiTabIds[ai] = null; persist(); }
    branchTabIds.delete(tabId);
    pendingBranchInject.delete(tabId);
    pendingConvCapture.delete(tabId);
});

// ── Send prompt to AI tab ─────────────────────────────────────────────────────
async function sendPromptToAI(ai, promptText, roundNumber, arkoseToken) {
    const tabId = aiTabIds[ai];
    console.log(`[BG] sendPromptToAI ai=${ai} tabId=${tabId} round=${roundNumber}`);
    if (!tabId) {
        postToGroupChat({ type: 'CONNECTOR_ERROR', ai, roundNumber, message: `No tab open for ${ai}` });
        return;
    }

    const msg = { type: 'INJECT_PROMPT', promptText, roundNumber, arkoseToken };
    // Try sending directly first; if listener is gone, re-inject and retry once
    try {
        await chrome.tabs.sendMessage(tabId, msg);
        console.log(`[BG] sendMessage to ${ai} succeeded`);
    } catch {
        // Listener not registered — re-inject then retry
        await injectConnector(ai, tabId);
        try {
            await chrome.tabs.sendMessage(tabId, msg);
        } catch (e2) {
            postToGroupChat({ type: 'CONNECTOR_ERROR', ai, roundNumber, message: e2.message });
        }
    }
}
