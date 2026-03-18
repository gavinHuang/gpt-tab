// Runs in ChatGPT's MAIN world (declared in manifest.json).
// Relays fetch requests from the isolated-world content script through the
// page's native fetch context (with session cookies + Turnstile token).
(function () {
    if (window.__gptProxyInstalled) return;
    window.__gptProxyInstalled = true;

    window.addEventListener('__gpt_proxy_req', async (e) => {
        const { id, url, init } = e.detail;
        const fire = (detail) =>
            window.dispatchEvent(new CustomEvent('__gpt_proxy_res', { detail }));

        try {
            const options = { ...(init || {}) };
            options.headers = { ...(options.headers || {}) };

            // Inject the latest captured Turnstile token for backend-api requests.
            // chatgpt-main-world.js populates window.__aiLatestTurnstileToken by
            // intercepting ChatGPT's own fetch calls.
            if (url.includes('/backend-api/') && window.__aiLatestTurnstileToken) {
                options.headers['openai-sentinel-turnstile-token'] = window.__aiLatestTurnstileToken;
            }

            const resp = await fetch(url, options);
            fire({ id, status: resp.status, ok: resp.ok });

            const reader  = resp.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) { fire({ id, done: true }); break; }
                fire({ id, chunk: decoder.decode(value, { stream: true }) });
            }
        } catch (err) {
            fire({ id, error: err.message });
        }
    });
})();
