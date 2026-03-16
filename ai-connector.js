(function () {
    // Each injection replaces the previous listener — no window guard needed,
    // no reconnect loops, no extension-context-invalidated errors.
    if (window.__aiConnectorCleanup) window.__aiConnectorCleanup();

    const SITE = (() => {
        const h = location.hostname;
        if (h.includes('chatgpt.com') || h.includes('chat.openai.com')) return 'chatgpt';
        if (h.includes('gemini.google.com')) return 'gemini';
        if (h.includes('claude.ai')) return 'claude';
        return null;
    })();

    if (!SITE) return;

    // ── Per-site DOM config ──────────────────────────────────────────────────
    const CONFIGS = {
        chatgpt: {
            getInput:        () => document.querySelector('#prompt-textarea'),
            getSendBtn:      () => document.querySelector('button[data-testid="send-button"]'),
            getLastResponse: () => {
                const els = document.querySelectorAll('[data-message-author-role="assistant"]');
                if (!els.length) return null;
                const last = els[els.length - 1];
                // Use textContent (not innerText) so hidden elements (e.g. .gpt-hidden tabs) still return text
                const prose = last.querySelector('.markdown, .prose, [class*="markdown"]');
                return (prose ?? last).textContent.trim() || null;
            },
            inject(el, text) {
                el.focus();
                const range = document.createRange();
                range.selectNodeContents(el);
                window.getSelection().removeAllRanges();
                window.getSelection().addRange(range);
                document.execCommand('insertText', false, text);
            },
        },
        gemini: {
            getInput: () =>
                document.querySelector('div.ql-editor[aria-label="Enter a prompt for Gemini"]') ||
                document.querySelector('div.ql-editor[contenteditable="true"]') ||
                document.querySelector('div[contenteditable="true"][role="textbox"]'),
            getSendBtn: () =>
                document.querySelector('button[aria-label="Send message"]') ||
                document.querySelector('button.send-button'),
            getLastResponse: () => {
                const els = document.querySelectorAll('.model-response-text');
                return els.length ? els[els.length - 1].textContent.trim() : null;
            },
            inject(el, text) {
                el.focus();
                document.execCommand('selectAll');
                document.execCommand('insertText', false, text);
            },
        },
        claude: {
            // Confirmed via live DOM inspection: the real input is the ProseMirror div,
            // not the SSR textarea. Send button aria-label confirmed after typing.
            getInput: () =>
                document.querySelector('div[data-testid="chat-input"]') ||
                document.querySelector('div.tiptap.ProseMirror[contenteditable="true"]'),
            getSendBtn: () =>
                document.querySelector('button[aria-label="Send message"]'),
            // data-is-streaming="true" while generating, "false" when done
            getLastResponse: () => {
                const els = document.querySelectorAll('[data-is-streaming]');
                return els.length ? els[els.length - 1].textContent.trim() : null;
            },
            inject(el, text) {
                el.focus();
                document.execCommand('selectAll');
                document.execCommand('delete');
                document.execCommand('insertText', false, text);
            },
        },
    };

    const cfg = CONFIGS[SITE];

    // ── Utilities ────────────────────────────────────────────────────────────
    const sleep = ms => new Promise(r => setTimeout(r, ms));

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

    // ── Prompt handler ───────────────────────────────────────────────────────
    let cancelled = false;

    function relay(data) {
        if (cancelled) return;
        try { chrome.runtime.sendMessage(data); } catch { /* SW may be restarting */ }
    }

    async function runPrompt({ promptText, roundNumber }) {
        try {
            // 1. Find input
            const input = await waitFor(cfg.getInput, 15000);
            if (!input) throw new Error('Input field not found after 15s');
            if (cancelled) return;

            // 2. Type the prompt
            cfg.inject(input, promptText);
            await sleep(500);
            if (cancelled) return;

            // 3. Find send button and click
            const btn = await waitFor(() => {
                const b = cfg.getSendBtn();
                return b && !b.disabled ? b : null;
            }, 8000);
            if (!btn) throw new Error('Send button not found or disabled');
            if (cancelled) return;
            btn.click();

            // 4. Snapshot response state before generation starts
            const before = cfg.getLastResponse() || '';

            // 5. Wait for new text to appear (up to 10s)
            await waitFor(() => {
                const t = cfg.getLastResponse();
                return t && t !== before;
            }, 10000, 300);

            // 6. Stream partial updates every 2s
            const streamTimer = setInterval(() => {
                if (cancelled) { clearInterval(streamTimer); return; }
                const t = cfg.getLastResponse();
                if (t && t !== before) relay({ type: 'AI_RESPONSE', ai: SITE, roundNumber, text: t, streaming: true });
            }, 2000);

            // 7. Wait for text to stabilise — same content for 2 checks × 1.5s apart.
            //    No dependency on a "stop generating" button selector.
            let stableText = '', stableCount = 0;
            await waitFor(() => {
                if (cancelled) return true;
                const t = cfg.getLastResponse() || '';
                if (t && t !== before && t === stableText) {
                    if (++stableCount >= 2) return true;
                } else {
                    stableText = t;
                    stableCount = 0;
                }
                return false;
            }, 180000, 1500);
            clearInterval(streamTimer);

            if (cancelled) return;
            await sleep(400);

            const text = cfg.getLastResponse();
            if (!text || text === before) throw new Error('Could not read response text');

            relay({ type: 'AI_RESPONSE', ai: SITE, roundNumber, text, streaming: false });

        } catch (err) {
            if (cancelled) return;
            relay({ type: 'CONNECTOR_ERROR', ai: SITE, roundNumber, message: err.message });
        }
    }

    // ── Message listener (replaces itself on each injection) ─────────────────
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

    // Announce that this tab is ready
    try { chrome.runtime.sendMessage({ type: 'CONNECTOR_READY', ai: SITE }); } catch {}
})();
