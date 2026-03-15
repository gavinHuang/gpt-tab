// ── State ─────────────────────────────────────────────────────────────────────
const AI_NAMES = ['chatgpt', 'gemini', 'claude'];
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
const tabChannelPorts = new Map();

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
        groupChatPort?.postMessage(msg);
        return;
    }
    if (msg.type === 'AI_RESPONSE' || msg.type === 'CONNECTOR_ERROR') {
        groupChatPort?.postMessage(msg);
        return;
    }
});

// ── Group-chat message handler ────────────────────────────────────────────────
async function handleGroupChatMessage(msg) {
    if (msg.type === 'OPEN_AI_TABS') {
        try { await openAITabs(); } catch (e) { console.log('[BG] openAITabs error:', e.message); }
    }
    if (msg.type === 'INJECT_PROMPT') {
        await sendPromptToAI(msg.ai, msg.promptText, msg.roundNumber);
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
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['ai-connector.js'] });
    } catch (e) {
        console.log(`[BG] ${ai}: injection failed (tab may still be loading): ${e.message}`);
    }
}

// Re-inject when AI tabs finish loading (handles navigation / page refresh)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    const ai = Object.keys(aiTabIds).find(a => aiTabIds[a] === tabId);
    if (!ai) return;
    injectConnector(ai, tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    const ai = Object.keys(aiTabIds).find(a => aiTabIds[a] === tabId);
    if (!ai) return;
    aiTabIds[ai] = null;
    persist();
});

// ── Send prompt to AI tab ─────────────────────────────────────────────────────
async function sendPromptToAI(ai, promptText, roundNumber) {
    const tabId = aiTabIds[ai];
    if (!tabId) {
        groupChatPort?.postMessage({ type: 'CONNECTOR_ERROR', ai, roundNumber, message: `No tab open for ${ai}` });
        return;
    }

    // Try sending directly first; if listener is gone, re-inject and retry once
    try {
        await chrome.tabs.sendMessage(tabId, { type: 'INJECT_PROMPT', promptText, roundNumber });
    } catch {
        // Listener not registered — re-inject then retry
        await injectConnector(ai, tabId);
        try {
            await chrome.tabs.sendMessage(tabId, { type: 'INJECT_PROMPT', promptText, roundNumber });
        } catch (e2) {
            groupChatPort?.postMessage({ type: 'CONNECTOR_ERROR', ai, roundNumber, message: e2.message });
        }
    }
}
