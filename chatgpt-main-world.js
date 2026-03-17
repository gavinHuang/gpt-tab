// Runs in ChatGPT's MAIN world at document_start.
// Intercepts ChatGPT's own fetch calls to capture the Turnstile token,
// then broadcasts it to the isolated-world content script via a DOM event.
(function () {
    if (window.__aiTurnstileCaptureInstalled) return;
    window.__aiTurnstileCaptureInstalled = true;

    let latestTurnstileToken = null;

    const origFetch = window.fetch;
    window.fetch = function (resource, init = {}) {
        const url = typeof resource === 'string' ? resource
                  : (resource instanceof Request ? resource.url : String(resource));

        if (url.includes('/backend-api/')) {
            // Headers may be a plain object or a Headers instance
            let token = null;
            const h = init?.headers;
            if (h) {
                token = (typeof h.get === 'function')
                    ? h.get('openai-sentinel-turnstile-token')
                    : h['openai-sentinel-turnstile-token'];
            }
            if (token && token !== latestTurnstileToken) {
                latestTurnstileToken = token;
                window.dispatchEvent(new CustomEvent('__ai_turnstile_token', {
                    detail: { token },
                }));
            }
        }

        return origFetch.apply(this, arguments);
    };

    // Also expose it so isolated world can poll synchronously after an event.
    Object.defineProperty(window, '__aiLatestTurnstileToken', {
        get: () => latestTurnstileToken,
        configurable: true,
    });
})();
