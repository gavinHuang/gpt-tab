// Runs in ChatGPT's MAIN world (declared in manifest.json and injected dynamically).
// Relays fetch requests from the extension's isolated-world content script
// through the page's native fetch context, bypassing Cloudflare bot detection.
(function () {
    // Guard against being injected more than once (manifest + dynamic injection).
    if (window.__gptProxyInstalled) return;
    window.__gptProxyInstalled = true;

    window.addEventListener('__gpt_proxy_req', async (e) => {
        const { id, url, init } = e.detail;
        const fire = (detail) =>
            window.dispatchEvent(new CustomEvent('__gpt_proxy_res', { detail }));

        try {
            const resp = await fetch(url, init);
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
