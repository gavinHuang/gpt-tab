(function () {
    // Each injection replaces the previous — no lingering listeners.
    if (window.__aiConnectorCleanup) window.__aiConnectorCleanup();

    const SITE = (() => {
        const h = location.hostname;
        if (h.includes('chatgpt.com') || h.includes('chat.openai.com')) return 'chatgpt';
        if (h.includes('gemini.google.com')) return 'gemini';
        if (h.includes('claude.ai')) return 'claude';
        return null;
    })();

    console.log('[ai-connector] loaded on', SITE, location.href);
    if (!SITE) return;

    // ── Utilities ─────────────────────────────────────────────────────────────
    let cancelled = false;

    function relay(data) {
        if (cancelled) return;
        try { chrome.runtime.sendMessage(data); } catch { /* SW restarting */ }
    }

    const sleep   = ms => new Promise(r => setTimeout(r, ms));
    function waitFor(fn, timeoutMs = 15000, intervalMs = 250) {
        return new Promise(resolve => {
            const deadline = Date.now() + timeoutMs;
            (function tick() {
                const v = fn();
                if (v) return resolve(v);
                if (Date.now() > deadline) return resolve(null);
                setTimeout(tick, intervalMs);
            })();
        });
    }

    // Async-iterate a streaming HTTP response line by line.
    async function* streamLines(response) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep any incomplete trailing line
            for (const line of lines) yield line;
        }
        if (buffer) yield buffer;
    }

    // ── ChatGPT handler ───────────────────────────────────────────────────────
    const ChatGPT = {
        _accessToken:    null,
        _conversationId: null,
        _lastMessageId:  null,

        async getAccessToken() {
            if (this._accessToken) return this._accessToken;
            const data = await fetch('https://chatgpt.com/api/auth/session').then(r => r.json());
            if (!data.accessToken) throw new Error('ChatGPT: not logged in');
            this._accessToken = data.accessToken;
            return this._accessToken;
        },

        getDeviceId() {
            let id = localStorage.getItem('oai-device-id');
            if (!id) { id = crypto.randomUUID(); localStorage.setItem('oai-device-id', id); }
            return id;
        },

        async send(prompt, roundNumber, arkoseToken) {
            console.log('[ai-connector] ChatGPT.send() called, round', roundNumber);
            if (roundNumber === 1) { this._conversationId = null; this._lastMessageId = null; }

            const token    = await this.getAccessToken();
            const deviceId = this.getDeviceId();

            const resp = await fetch('https://chatgpt.com/backend-api/conversation', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type':  'application/json',
                    'Accept':        'text/event-stream',
                    'oai-device-id': deviceId,
                    'oai-language':  navigator.language || 'en-US',
                },
                body: JSON.stringify({
                    action:            'next',
                    model:             'gpt-4o-mini',
                    messages: [{
                        id:      crypto.randomUUID(),
                        author:  { role: 'user' },
                        content: { content_type: 'text', parts: [prompt] },
                    }],
                    parent_message_id: this._lastMessageId || crypto.randomUUID(),
                    conversation_id:   this._conversationId || undefined,
                    conversation_mode: { kind: 'primary_assistant' },
                    arkose_token:      arkoseToken || undefined,
                    history_and_training_disabled: false,
                }),
            });

            if (!resp.ok) {
                const body = await resp.text().catch(() => '');
                throw new Error(`ChatGPT API ${resp.status}: ${body.slice(0, 300)}`);
            }

            let text = '';
            for await (const line of streamLines(resp)) {
                if (cancelled) { resp.body?.cancel(); return; }
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6);
                if (raw === '[DONE]') break;
                try {
                    const json = JSON.parse(raw);
                    // Track conversation state for subsequent rounds in same topic.
                    if (json.conversation_id) this._conversationId = json.conversation_id;
                    const msg = json.message;
                    if (!msg) continue;
                    if (msg.id) this._lastMessageId = msg.id;
                    if (msg.author?.role !== 'assistant') continue;
                    const part = msg.content?.parts?.[0];
                    if (typeof part === 'string' && part !== text) {
                        text = part;
                        relay({ type: 'AI_RESPONSE', ai: 'chatgpt', roundNumber, text, streaming: true });
                    }
                } catch { }
            }

            if (!text) throw new Error('No text in ChatGPT response');
            relay({ type: 'AI_RESPONSE', ai: 'chatgpt', roundNumber, text, streaming: false });
        },
    };

    // ── Claude handler ─────────────────────────────────────────────────────────
    // Uses claude.ai REST API — cookies auto-included from browser session.
    const Claude = {
        _orgId: null,

        async getOrgId() {
            if (this._orgId) return this._orgId;
            const orgs = await fetch('https://claude.ai/api/organizations').then(r => r.json());
            if (!Array.isArray(orgs) || !orgs.length) throw new Error('Claude: not logged in');
            this._orgId = orgs[0].uuid;
            return this._orgId;
        },

        async send(prompt, roundNumber) {
            const orgId  = await this.getOrgId();
            const convId = crypto.randomUUID();

            // Create a fresh conversation for each round.
            const createResp = await fetch(
                `https://claude.ai/api/organizations/${orgId}/chat_conversations`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: '', uuid: convId }),
                },
            );
            if (!createResp.ok) throw new Error(`Claude create-conv ${createResp.status}`);

            const resp = await fetch(
                `https://claude.ai/api/organizations/${orgId}/chat_conversations/${convId}/completion`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream',
                    },
                    body: JSON.stringify({
                        prompt,
                        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                        attachments: [],
                        files: [],
                    }),
                },
            );

            if (!resp.ok) {
                const body = await resp.text().catch(() => '');
                throw new Error(`Claude API ${resp.status}: ${body.slice(0, 120)}`);
            }

            // SSE stream: each event has a "completion" delta to accumulate.
            let text = '';
            for await (const line of streamLines(resp)) {
                if (cancelled) { resp.body?.cancel(); return; }
                if (!line.startsWith('data: ')) continue;
                try {
                    const json = JSON.parse(line.slice(6));
                    if (json.completion) {
                        text += json.completion;
                        relay({ type: 'AI_RESPONSE', ai: 'claude', roundNumber, text, streaming: true });
                    }
                } catch { }
            }

            if (!text) throw new Error('No text in Claude response');
            relay({ type: 'AI_RESPONSE', ai: 'claude', roundNumber, text, streaming: false });
        },
    };

    // ── Gemini handler ─────────────────────────────────────────────────────────
    // Uses the internal BardChatUi RPC (same URL Google kept internally even
    // after renaming the product from Bard to Gemini).
    const Gemini = {
        async fetchTokens() {
            // The three dynamic auth tokens are embedded in the app page HTML.
            const html = await fetch('https://gemini.google.com/app').then(r => r.text());
            const snlm0e = html.match(/"SNlM0e":"([^"]+)"/)?.[1];
            const cfb2h  = html.match(/"cfb2h":"([^"]+)"/)?.[1];
            const fdrfje = html.match(/"FdrFJe":"([^"]+)"/)?.[1];
            if (!snlm0e || !cfb2h) throw new Error('Gemini: could not extract auth tokens (not logged in?)');
            return { snlm0e, cfb2h, fdrfje };
        },

        async send(prompt, roundNumber) {
            // Re-fetch each round — tokens can rotate.
            const { snlm0e, cfb2h, fdrfje } = await this.fetchTokens();

            const reqid  = Math.floor(Math.random() * 900000 + 100000);
            const params = new URLSearchParams({ bl: cfb2h, _reqid: String(reqid), rt: 'c' });
            if (fdrfje) params.set('f.sid', fdrfje);

            const body = new URLSearchParams({
                'f.req': JSON.stringify([null, JSON.stringify([[prompt], null, [null, null, null]])]),
                at: snlm0e,
            });

            const resp = await fetch(
                `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                        'X-Same-Domain': '1',
                        'Origin': 'https://gemini.google.com',
                    },
                    body: body.toString(),
                },
            );

            if (!resp.ok) throw new Error(`Gemini API ${resp.status}`);

            // Gemini streams a proprietary RPC envelope (not SSE). Collect fully,
            // then extract the last candidate text chunk — it's the complete response.
            const raw = await resp.text();
            let text = null;
            for (const line of raw.split('\n')) {
                try {
                    const parsed    = JSON.parse(line);
                    const innerJson = parsed?.[0]?.[2];
                    if (!innerJson) continue;
                    const payload   = JSON.parse(innerJson);
                    const candidate = payload?.[4]?.[0]?.[1]?.[0];
                    if (candidate) text = candidate; // last non-empty wins
                } catch { }
            }

            if (!text) throw new Error('Could not parse Gemini response');
            relay({ type: 'AI_RESPONSE', ai: 'gemini', roundNumber, text, streaming: false });
        },
    };

    // ── Prompt dispatcher ─────────────────────────────────────────────────────
    async function runPrompt({ promptText, roundNumber, arkoseToken }) {
        try {
            if      (SITE === 'chatgpt') await ChatGPT.send(promptText, roundNumber, arkoseToken);
            else if (SITE === 'claude')  await Claude.send(promptText, roundNumber);
            else if (SITE === 'gemini')  await Gemini.send(promptText, roundNumber);
        } catch (err) {
            if (cancelled) return;
            relay({ type: 'CONNECTOR_ERROR', ai: SITE, roundNumber, message: err.message });
        }
    }

    // ── Message listener ──────────────────────────────────────────────────────
    function onMessage(msg, _sender, sendResponse) {
        if (msg.type !== 'INJECT_PROMPT') return false;
        cancelled = false;
        sendResponse({ ok: true }); // immediate ack so background doesn't time out
        runPrompt(msg);
        return false;
    }

    chrome.runtime.onMessage.addListener(onMessage);

    window.__aiConnectorCleanup = () => {
        cancelled = true;
        chrome.runtime.onMessage.removeListener(onMessage);
    };

    // Announce readiness to background.
    try { chrome.runtime.sendMessage({ type: 'CONNECTOR_READY', ai: SITE }); } catch { }
})();
