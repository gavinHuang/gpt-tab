// ── Arkose token generator ────────────────────────────────────────────────────
// Client-side Arkose (api.js) requires the extension to be whitelisted in
// ChatGPT's CSP frame-ancestors directive — only ChatHub's published extension
// ID is whitelisted. We skip straight to ChatHub's public server fallback
// (server.ts: fetchArkoseToken → https://chathub.gg/api/arkose).
async function getArkoseToken() {
    try {
        const resp = await fetch('https://chathub.gg/api/arkose');
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.token || null;
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
const AI_NAMES = ['gemini', 'claude'];
const AI_DISPLAY = { gemini: 'Gemini', claude: 'Claude' };
const AI_INITIAL = { gemini: '✦', claude: 'C' };

// ── State ─────────────────────────────────────────────────────────────────────
let port = null;
let currentMode = 'brainstorm';
let currentRound = 0;
let roundResponses = {};
let history = [];
let readyAIs = new Set();
let roundInProgress = false;
let currentTopic = '';
let pendingStart = false;
let responseOrder = ['gemini', 'claude'];
let activeOrder = [];
let currentRespondingIndex = 0;

// ── Port ──────────────────────────────────────────────────────────────────────
let hasInitialized = false;

function connectPort() {
    try {
        port = chrome.runtime.connect({ name: 'group-chat' });
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(() => {
            port = null;
            setTimeout(connectPort, 500);
        });
        // Only open AI tabs on first connection — reconnects after SW death must NOT
        // re-inject connectors, which would cancel any ongoing runPrompt.
        if (!hasInitialized) {
            hasInitialized = true;
            port.postMessage({ type: 'OPEN_AI_TABS' });
        }
    } catch {
        setTimeout(connectPort, 1000);
    }
}

function onMessage(msg) {
    if (msg.type === 'CONNECTOR_READY') {
        readyAIs.add(msg.ai);
        setDot(msg.ai, 'ready');
        const count = readyAIs.size;
        setStatus(`${AI_DISPLAY[msg.ai]} connected (${count}/2 ready)`);
        if (count === AI_NAMES.length) {
            setStatus('All AIs ready');
            if (!roundInProgress) enableSend(true);
            if (pendingStart) { pendingStart = false; startRound(); }
        }
        return;
    }

    if (msg.type === 'AI_RESPONSE') {
        const { ai, text, streaming, roundNumber } = msg;
        if (roundNumber !== currentRound) return;
        if (streaming) {
            renderStreaming(ai, text);
        } else {
            finalizeResponse(ai, text);
        }
        return;
    }

    if (msg.type === 'CONNECTOR_ERROR') {
        const { ai, message, roundNumber } = msg;
        if (roundNumber !== currentRound) return;
        removeTypingIndicator(ai);
        removeStreamingBubble(ai);
        appendAIMessage(ai, `⚠ ${message}`, true);
        roundResponses[ai] = null;
        setDot(ai, 'error');
        currentRespondingIndex++;
        sendNextInSequence();
    }
}

// ── Sequential dispatch ───────────────────────────────────────────────────────
async function sendNextInSequence() {
    if (currentRespondingIndex >= activeOrder.length) {
        finishRound();
        return;
    }
    const ai = activeOrder[currentRespondingIndex];
    setDot(ai, 'thinking');
    showTypingIndicator(ai);
    setStatus(`${AI_DISPLAY[ai]} is responding…`);

    const promptText = buildPrompt(ai, currentTopic, currentMode, history, currentRound, roundResponses);
    port?.postMessage({ type: 'INJECT_PROMPT', ai, promptText, roundNumber: currentRound });
}

// ── @mention parsing ──────────────────────────────────────────────────────────
function parseMentions(text) {
    const lower = text.toLowerCase();
    const tagMap = [
        ['@gemini', 'gemini'],
        ['@claude', 'claude'],
    ];
    const found = [];
    for (const [tag, ai] of tagMap) {
        if (lower.includes(tag) && !found.includes(ai)) found.push(ai);
    }
    return found.length ? responseOrder.filter(a => found.includes(a)) : null;
}

// ── Prompt builder ────────────────────────────────────────────────────────────
const MODE_INSTRUCTIONS = {
    brainstorm: (ai, others) =>
        `You are ${AI_DISPLAY[ai]} in a group brainstorming session with ${others}. ` +
        `Build on the conversation, explore new angles, be creative. 2–3 paragraphs max.`,
    debate: (ai, others) =>
        `You are ${AI_DISPLAY[ai]} in a group debate with ${others}. ` +
        `Take a clear position, defend it with logic, challenge other arguments. 2–3 paragraphs max.`,
    commentary: (ai, others) =>
        `You are ${AI_DISPLAY[ai]} providing commentary alongside ${others}. ` +
        `Analyze objectively, add unique insight, engage with others' points. 2–3 paragraphs max.`,
};

function buildPrompt(ai, topic, mode, history, roundNumber, priorInRound) {
    const others = activeOrder.filter(a => a !== ai).map(a => AI_DISPLAY[a]).join(' and ') || 'other AIs';
    const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);

    let prompt = `[${modeLabel} Group Chat — Round ${roundNumber}]\n\n`;
    prompt += MODE_INSTRUCTIONS[mode](ai, others) + '\n\n';

    if (history.length > 0) {
        prompt += `Conversation so far:\n`;
        for (const entry of history) {
            prompt += `\n[Round ${entry.round}]\nUser: ${entry.userMessage}\n`;
            for (const a of (entry.order || AI_NAMES)) {
                if (entry.responses[a]) prompt += `${AI_DISPLAY[a]}: ${entry.responses[a]}\n`;
            }
        }
        prompt += '\n';
    }

    prompt += `User: ${topic}\n`;

    const prior = Object.entries(priorInRound).filter(([, v]) => v);
    if (prior.length) {
        prompt += `\n`;
        for (const [a, text] of prior) prompt += `${AI_DISPLAY[a]}: ${text}\n`;
    }

    prompt += `\n${AI_DISPLAY[ai]}:`;
    return prompt;
}

// ── Round management ──────────────────────────────────────────────────────────
function startRound() {
    currentRound++;
    roundResponses = {};
    roundInProgress = true;
    currentRespondingIndex = 0;
    activeOrder = parseMentions(currentTopic) || [...responseOrder];

    document.getElementById('round-badge').textContent = `Round ${currentRound}`;
    document.getElementById('round-badge').style.display = 'inline-block';
    document.getElementById('continue-row').style.display = 'none';
    enableSend(false);

    // Mark non-active AIs
    for (const ai of AI_NAMES) {
        if (!activeOrder.includes(ai)) setDot(ai, 'skip');
    }

    appendRoundSeparator(currentRound);
    appendUserMessage(currentTopic);
    sendNextInSequence();
}

function finishRound() {
    history.push({
        round: currentRound,
        userMessage: currentTopic,
        order: [...activeOrder],
        responses: { ...roundResponses },
    });
    roundInProgress = false;

    for (const ai of activeOrder) setDot(ai, 'done');

    document.getElementById('next-round-num').textContent = currentRound + 1;
    document.getElementById('continue-row').style.display = 'flex';
    enableSend(true);
    setStatus('Round complete — reply or click Continue');
}

// ── Order controls ────────────────────────────────────────────────────────────
function moveAI(ai, dir) {
    if (roundInProgress) return;
    const i = responseOrder.indexOf(ai);
    const j = dir === 'left' ? i - 1 : i + 1;
    if (j < 0 || j >= responseOrder.length) return;
    [responseOrder[i], responseOrder[j]] = [responseOrder[j], responseOrder[i]];
    updateOrderBadges();
}

function updateOrderBadges() {
    for (let i = 0; i < responseOrder.length; i++) {
        const el = document.getElementById(`order-${responseOrder[i]}`);
        if (el) el.textContent = i + 1;
    }
    // Update disabled state of buttons
    for (const ai of AI_NAMES) {
        const i = responseOrder.indexOf(ai);
        const btns = document.querySelectorAll(`.order-btn[data-ai="${ai}"]`);
        btns.forEach(btn => {
            btn.disabled = (btn.dataset.dir === 'left' && i === 0) ||
                           (btn.dataset.dir === 'right' && i === responseOrder.length - 1);
        });
    }
}

// ── DOM: thread rendering ─────────────────────────────────────────────────────
function appendRoundSeparator(round) {
    const thread = document.getElementById('chat-thread');
    const sep = document.createElement('div');
    sep.className = 'round-sep';
    sep.innerHTML = `<span class="round-sep-label">Round ${round}</span>`;
    thread.appendChild(sep);
}

function appendUserMessage(text) {
    const thread = document.getElementById('chat-thread');
    const row = document.createElement('div');
    row.className = 'msg-row user';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar user-avatar';
    avatar.textContent = 'Y';

    const content = document.createElement('div');
    content.className = 'msg-content';

    const sender = document.createElement('div');
    sender.className = 'msg-sender user';
    sender.textContent = 'You';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;

    content.appendChild(sender);
    content.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(content);
    thread.appendChild(row);
    scrollBottom();
}

function showTypingIndicator(ai) {
    if (document.getElementById(`typing-${ai}`)) return;
    const thread = document.getElementById('chat-thread');
    const row = makeAIRow(ai);
    row.id = `typing-${ai}`;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble typing-bubble';
    for (let i = 0; i < 3; i++) {
        const d = document.createElement('span');
        d.className = 'typing-dot';
        bubble.appendChild(d);
    }
    row.querySelector('.msg-content').appendChild(bubble);
    thread.appendChild(row);
    scrollBottom();
}

function removeTypingIndicator(ai) {
    document.getElementById(`typing-${ai}`)?.remove();
}

function renderStreaming(ai, text) {
    removeTypingIndicator(ai);
    const thread = document.getElementById('chat-thread');
    let row = document.getElementById(`streaming-${ai}`);
    if (!row) {
        row = makeAIRow(ai);
        row.id = `streaming-${ai}`;
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble streaming';
        bubble.id = `streaming-bubble-${ai}`;
        row.querySelector('.msg-content').appendChild(bubble);
        thread.appendChild(row);
    }
    document.getElementById(`streaming-bubble-${ai}`).textContent = text;
    scrollBottom();
}

function finalizeResponse(ai, text) {
    removeTypingIndicator(ai);
    const existing = document.getElementById(`streaming-${ai}`);
    if (existing) {
        const bubble = document.getElementById(`streaming-bubble-${ai}`);
        bubble.textContent = text;
        bubble.className = 'msg-bubble';
        existing.removeAttribute('id');
        document.getElementById(`streaming-bubble-${ai}`)?.removeAttribute('id');
    } else {
        appendAIMessage(ai, text, false);
    }
    roundResponses[ai] = text;
    setDot(ai, 'done');
    currentRespondingIndex++;
    sendNextInSequence();
    scrollBottom();
}

function appendAIMessage(ai, text, isError) {
    const thread = document.getElementById('chat-thread');
    const row = makeAIRow(ai);
    const bubble = document.createElement('div');
    bubble.className = isError ? 'msg-bubble error' : 'msg-bubble';
    bubble.textContent = text;
    row.querySelector('.msg-content').appendChild(bubble);
    thread.appendChild(row);
    scrollBottom();
}

function makeAIRow(ai) {
    const row = document.createElement('div');
    row.className = 'msg-row ai';

    const avatar = document.createElement('div');
    avatar.className = `msg-avatar ai-avatar ai-${ai}`;
    avatar.textContent = AI_INITIAL[ai];

    const content = document.createElement('div');
    content.className = 'msg-content';

    const sender = document.createElement('div');
    sender.className = `msg-sender ${ai}`;
    sender.textContent = AI_DISPLAY[ai];

    content.appendChild(sender);
    row.appendChild(avatar);
    row.appendChild(content);
    return row;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(text) { document.getElementById('status-bar').textContent = text; }
function enableSend(on)  { document.getElementById('send-btn').disabled = !on; }
function scrollBottom()  {
    const t = document.getElementById('chat-thread');
    t.scrollTop = t.scrollHeight;
}
function setDot(ai, state) {
    const el = document.getElementById(`dot-${ai}`);
    if (el) el.className = `dot dot-${state}`;
}
function removeStreamingBubble(ai) {
    document.getElementById(`streaming-${ai}`)?.remove();
}

function resetForNewTopic() {
    history = []; currentRound = 0; roundResponses = {};
    pendingStart = false; activeOrder = []; currentRespondingIndex = 0;
    document.getElementById('chat-thread').innerHTML = '';
    document.getElementById('round-badge').style.display = 'none';
    document.getElementById('continue-row').style.display = 'none';
    enableSend(readyAIs.size === AI_NAMES.length);
    for (const ai of AI_NAMES) setDot(ai, readyAIs.has(ai) ? 'ready' : 'idle');
    setStatus('New topic — enter a message and click Send');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    connectPort();
    updateOrderBadges();

    document.querySelectorAll('.mode-btn').forEach(btn =>
        btn.addEventListener('click', () => {
            document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentMode = btn.dataset.mode;
        })
    );

    document.querySelectorAll('.order-btn').forEach(btn =>
        btn.addEventListener('click', () => moveAI(btn.dataset.ai, btn.dataset.dir))
    );

    const input = document.getElementById('topic-input');
    const sendBtn = document.getElementById('send-btn');

    function handleSend() {
        const text = input.value.trim();
        if (!text || roundInProgress) return;
        currentTopic = text;
        input.value = '';
        document.getElementById('continue-row').style.display = 'none';

        if (readyAIs.size < AI_NAMES.length) {
            enableSend(false);
            setStatus('Waiting for AI tabs to connect…');
            pendingStart = true;
        } else {
            startRound();
        }
    }

    sendBtn.addEventListener('click', handleSend);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSend();
    });

    document.getElementById('continue-btn').addEventListener('click', () => {
        if (roundInProgress) return;
        const override = input.value.trim();
        if (override) { currentTopic = override; input.value = ''; }
        document.getElementById('continue-row').style.display = 'none';
        startRound();
    });

    document.getElementById('new-topic-btn').addEventListener('click', resetForNewTopic);

    setStatus('Connecting to AI tabs…');
});
