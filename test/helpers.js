// Shared test helpers. The SDK accepts a custom `fetch` impl via
// createClient({ fetch }), so we test through that seam with hand-built
// fakes — no msw / nock / vi.mock plumbing required.

/**
 * Build a fake Response with the SDK's expected surface. Pass either
 * `json` (returned by .json() and stringified for .text()) or `body`
 * (a ReadableStream for SSE / streaming) or `text` / `buffer`.
 */
export function fakeResponse({
    ok = true,
    status = 200,
    statusText = 'OK',
    contentType = 'application/json',
    json,
    text,
    buffer,
    body = null,
} = {}) {
    const headers = new Map([['content-type', contentType]])
    return {
        ok,
        status,
        statusText,
        body,
        headers: {
            get: (k) => headers.get(k.toLowerCase()) ?? null,
        },
        json: async () => json,
        text: async () => (text != null ? text : JSON.stringify(json ?? null)),
        arrayBuffer: async () => buffer ?? new ArrayBuffer(0),
    }
}

/**
 * Build a ReadableStream from an array of chunk strings, suitable for
 * use as a Response.body in the watch() / live() SSE tests.
 */
export function sseStream(chunks) {
    const encoder = new TextEncoder()
    let cancelled = false
    return new ReadableStream({
        async start(controller) {
            for (const chunk of chunks) {
                if (cancelled) break
                controller.enqueue(encoder.encode(chunk))
                // Yield to the event loop so the consumer can read between chunks.
                await new Promise(r => setTimeout(r, 0))
            }
            try { controller.close() } catch {}
        },
        cancel() {
            cancelled = true
        },
    })
}

/**
 * Build a "fetch script": an array of fake-response factories invoked
 * in order. Each call records the (url, init) it was given.
 *
 *   const fetch = scriptedFetch([
 *       (url) => fakeResponse({ json: { items: [...] } }),
 *       (url) => fakeResponse({ ok: false, status: 404 }),
 *   ])
 *   await client.list()       // first factory
 *   await client.list()       // second factory
 *   fetch.calls                // [[url, init], [url, init]]
 */
export function scriptedFetch(factories) {
    const calls = []
    let index = 0
    async function fetchFn(url, init) {
        calls.push([url, init])
        if (index >= factories.length) {
            throw new Error(`scriptedFetch: no response queued for call #${index + 1} to ${url}`)
        }
        return factories[index++](url, init)
    }
    fetchFn.calls = calls
    return fetchFn
}
