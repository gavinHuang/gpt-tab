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

// ── Messages from AI content scripts ─────────────────────────────────────────
// Content scripts send CONNECTOR_READY, AI_RESPONSE, CONNECTOR_ERROR via
// chrome.runtime.sendMessage — no persistent port needed.
chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === 'CONNECTOR_READY') {
        const ai = aiFromUrl(sender.tab?.url || '');
        if (ai && sender.tab?.id) {
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
});

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
    if (!ai) return;
    aiTabIds[ai] = null;
    persist();
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
