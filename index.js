// mikser-io-sdk-api
//
// A tiny client wrapper over the mikser-io `api` plugin — list/query
// the document catalog from the browser or Node 18+. Uses the global
// `fetch`. Zero dependencies.
//
// For semantic search against the `vector` plugin, install
// mikser-io-sdk-vector — it ships as a separate package.
//
// Usage:
//
//   import { createClient } from 'mikser-io-sdk-api'
//
//   const mikser = createClient({ baseUrl: 'http://localhost:3001' })
//   const docs = mikser.entities('public')
//
//   const { items } = await docs.list({
//       filter: { 'meta.published': true, 'meta.price': { $gt: 20 } },
//       sort:   { 'meta.date': -1 },
//       fields: ['id', 'meta.title'],
//       limit:  10,
//   })

class MikserError extends Error {
    constructor(status, statusText, body, url) {
        const detail = body?.error ? ': ' + body.error : ''
        super(`mikser-io-sdk-api ${status} ${statusText}${detail} (${url})`)
        this.name = 'MikserError'
        this.status = status
        this.body = body
    }
}

function bearer(token) {
    return token ? { authorization: `Bearer ${token}` } : {}
}

function joinUrl(base, path) {
    const normalised = base.endsWith('/') ? base.slice(0, -1) : base
    return normalised + path
}

// Cheap JSON-or-error response handler. Throws MikserError on non-2xx so
// callers can use plain `await` without checking res.ok.
async function jsonOrThrow(res, url) {
    if (!res.ok) {
        let body
        try { body = await res.json() } catch { /* leave undefined */ }
        throw new MikserError(res.status, res.statusText, body, url)
    }
    return res.json()
}

// "name,-date" ← { name: 1, date: -1 }
function sortToParam(sort) {
    return Object.entries(sort)
        .map(([k, v]) => (Number(v) < 0 ? `-${k}` : k))
        .join(',')
}

// Parse one SSE event block ("event: foo\ndata: {...}\n"). Returns
// { type, ...payload } when data is JSON; { type, data } otherwise.
// Returns null on completely empty blocks (e.g. comment-only).
function parseSseEvent(raw) {
    let type = 'message'
    let data = ''
    let sawAny = false
    for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue          // SSE comment
        if (line.startsWith('event:')) { type = line.slice(6).trim(); sawAny = true; continue }
        if (line.startsWith('data:'))  { data += line.slice(5).trim(); sawAny = true; continue }
    }
    if (!sawAny) return null
    try { return { type, ...JSON.parse(data || '{}') } }
    catch { return { type, data } }
}

// Walk a filter object and emit URL params using the api plugin's
// operator-suffix convention: { 'meta.price': { $gt: 20 } } → meta.price.$gt=20.
// Plain values become equality params: { type: 'document' } → type=document.
// Arrays for $in / $nin are comma-joined.
function filterToParams(filter, params) {
    for (const [key, value] of Object.entries(filter)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [op, opVal] of Object.entries(value)) {
                const v = Array.isArray(opVal) ? opVal.join(',') : String(opVal)
                params.set(`${key}.${op}`, v)
            }
        } else if (Array.isArray(value)) {
            params.set(key, value.join(','))
        } else if (value != null) {
            params.set(key, String(value))
        }
    }
}

/**
 * @param {Object} options
 * @param {string} options.baseUrl       Origin of the mikser server (e.g. https://cms.example.com)
 * @param {string} [options.basePath]    api plugin mount path; default '/api'
 * @param {typeof fetch} [options.fetch] override the fetch implementation (default: globalThis.fetch)
 * @param {Record<string,string>} [options.headers] headers attached to every request
 */
export function createClient({
    baseUrl,
    basePath = '/api',
    fetch: fetchImpl,
    headers: defaultHeaders = {},
} = {}) {
    if (!baseUrl) throw new Error('createClient: baseUrl is required')
    const doFetch = fetchImpl ?? globalThis.fetch
    if (!doFetch) {
        throw new Error('createClient: no fetch available — pass { fetch } or run on Node 18+ / a modern browser')
    }

    /** Per-endpoint entity client. */
    function entities(name, { token } = {}) {
        const endpointBase = `${basePath}/${name}`
        const queryUrl     = joinUrl(baseUrl, `${endpointBase}/entities/query`)
        const listUrl      = joinUrl(baseUrl, `${endpointBase}/entities`)
        const subscribeUrl = joinUrl(baseUrl, `${endpointBase}/entities/subscribe`)
        const renderUrl    = joinUrl(baseUrl, `${endpointBase}/render`)

        /**
         * Body-based query. Send everything sift accepts —
         * $and / $or / $regex, projections, sorts. Returns the standard
         * envelope: { items, page, limit, total, totalPages, hasNext, hasPrev }.
         */
        async function list(query = {}) {
            const res = await doFetch(queryUrl, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...defaultHeaders,
                    ...bearer(token),
                },
                body: JSON.stringify(query),
            })
            return jsonOrThrow(res, queryUrl)
        }

        /**
         * Build a URL for the GET form of the same query — useful when
         * the response should be CDN-cacheable, or when the caller wants
         * a sharable link. Operators map to `.$op` URL-param suffixes.
         */
        function urlFor(query = {}) {
            const url = new URL(listUrl)
            const { filter, sort, fields, page, limit, skip } = query
            if (page  != null) url.searchParams.set('page',  String(page))
            if (limit != null) url.searchParams.set('limit', String(limit))
            if (skip  != null) url.searchParams.set('skip',  String(skip))
            if (sort)   url.searchParams.set('sort',   sortToParam(sort))
            if (fields) url.searchParams.set('fields', fields.join(','))
            if (filter) filterToParams(filter, url.searchParams)
            return url.toString()
        }

        /**
         * Iterate result pages without manual page bookkeeping. Yields
         * each response envelope until `hasNext` is false.
         */
        async function* pages(query = {}) {
            let page = query.page ?? 1
            while (true) {
                const env = await list({ ...query, page })
                yield env
                if (!env.hasNext) return
                page = env.page + 1
            }
        }

        /**
         * Subscribe to changes — opens an SSE stream and yields events
         * for each matching entity change (CREATE / UPDATE / DELETE).
         * Composable with list(): call list() once for the initial state,
         * then watch() for forward updates.
         *
         * Yielded events:
         *   { type: 'init',      subscriptionId, endpoint }
         *   { type: 'create',    id, entity }
         *   { type: 'update',    id, entity }
         *   { type: 'delete',    id }
         *   { type: 'heartbeat' }
         *
         * Pass { signal } from an AbortController to close the stream.
         */
        async function* watch(query = {}, { signal } = {}) {
            const url = new URL(subscribeUrl)
            if (query.filter) filterToParams(query.filter, url.searchParams)

            const res = await doFetch(url.toString(), {
                method: 'GET',
                headers: {
                    accept: 'text/event-stream',
                    ...defaultHeaders,
                    ...bearer(token),
                },
                signal,
            })
            if (!res.ok) {
                let body
                try { body = await res.json() } catch {}
                throw new MikserError(res.status, res.statusText, body, url.toString())
            }
            if (!res.body) throw new Error('watch: response has no body — server may not support streaming')

            // Fetch internally creates a body-stream cancel promise when
            // the abort signal fires. Nothing in user code awaits it, so
            // it surfaces as an unhandled rejection. Pre-attach a no-op
            // catch via a body.cancel() the moment we see the abort —
            // makes that internal promise handled.
            if (signal) {
                signal.addEventListener('abort', () => {
                    try { res.body.cancel().catch(() => {}) } catch {}
                }, { once: true })
            }

            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) return
                    buffer += decoder.decode(value, { stream: true })
                    let sep
                    while ((sep = buffer.indexOf('\n\n')) >= 0) {
                        const raw = buffer.slice(0, sep)
                        buffer = buffer.slice(sep + 2)
                        const event = parseSseEvent(raw)
                        if (event) yield event
                    }
                }
            } finally {
                try { reader.cancel().catch(() => {}) } catch {}
            }
        }

        /**
         * live() — list-and-watch composed into one callback-driven view.
         * Calls onChange(items) with the initial result, then again with
         * the patched array on every create / update / delete event.
         * Returns a dispose function — call it to stop the subscription.
         *
         * Equivalent to:
         *   1. await list({ filter, sort, fields, limit, skip })
         *   2. onChange(items)
         *   3. for await (event of watch({ filter })) patch + onChange
         *   4. abort on dispose
         *
         * but with race-safe cleanup, no `mounted` flag in caller code,
         * and unified error routing via onError.
         *
         * @param {Object} filter   sift filter (same shape as list/watch)
         * @param {(items: any[]) => void} onChange
         * @param {Object} [options]
         * @param {Object} [options.sort]   passed to the initial list()
         * @param {string[]} [options.fields]   passed to the initial list()
         * @param {number} [options.limit]  passed to the initial list()
         * @param {number} [options.skip]   passed to the initial list()
         * @param {AbortSignal} [options.signal]  external abort (forwarded
         *                                        into our controller)
         * @param {(err: unknown) => void} [options.onError]  error sink;
         *                                        defaults to console.error
         * @returns {() => void} dispose
         */
        function live(filter, onChange, options = {}) {
            const {
                sort, fields, limit, skip,
                signal: externalSignal,
                onError = (err) => console.error('mikser-io-sdk-api live error:', err),
            } = options

            const ac = new AbortController()
            if (externalSignal) {
                if (externalSignal.aborted) ac.abort()
                else externalSignal.addEventListener('abort', () => ac.abort(), { once: true })
            }

            let items = []
            let disposed = false

            const loop = (async () => {
                try {
                    const env = await list({ filter, sort, fields, limit, skip })
                    if (disposed || ac.signal.aborted) return
                    items = env.items
                    onChange(items)

                    for await (const event of watch({ filter }, { signal: ac.signal })) {
                        if (disposed) return
                        switch (event.type) {
                            case 'create':
                                items = [...items, event.entity]
                                onChange(items)
                                break
                            case 'update':
                                items = items.map(i => i.id === event.id ? event.entity : i)
                                onChange(items)
                                break
                            case 'delete':
                                items = items.filter(i => i.id !== event.id)
                                onChange(items)
                                break
                            // 'init' / 'heartbeat' — no-op for the live view
                        }
                    }
                } catch (err) {
                    if (disposed || ac.signal.aborted) return
                    if (err?.name === 'AbortError') return
                    try { onError(err) } catch { /* swallow handler errors */ }
                }
            })()
            // Safety net: any error escaping the IIFE (rare, e.g. a
            // late AbortError from a fetch unwind that beats the
            // disposed check) gets swallowed silently rather than
            // surfacing as an unhandled rejection.
            loop.catch(() => {})

            return function dispose() {
                disposed = true
                try { ac.abort() } catch { /* abort never normally throws, but stay defensive */ }
            }
        }

        /**
         * PUT — upsert content into a collection folder. The watcher
         * picks it up and runs the normal pipeline.
         */
        async function update({ collection, relativePath, content = '' }) {
            const res = await doFetch(listUrl, {
                method: 'PUT',
                headers: {
                    'content-type': 'application/json',
                    ...defaultHeaders,
                    ...bearer(token),
                },
                body: JSON.stringify({ collection, relativePath, content }),
            })
            return jsonOrThrow(res, listUrl)
        }

        /** DELETE — remove a file from a collection folder. */
        async function remove({ collection, relativePath }) {
            const res = await doFetch(listUrl, {
                method: 'DELETE',
                headers: {
                    'content-type': 'application/json',
                    ...defaultHeaders,
                    ...bearer(token),
                },
                body: JSON.stringify({ collection, relativePath }),
            })
            return jsonOrThrow(res, listUrl)
        }

        /**
         * POST /render — render an entity in memory and return the bytes.
         * Decides the return shape from the response's content-type:
         *  application/json → parsed JSON
         *  text/*           → string
         *  anything else    → ArrayBuffer (PDF, image, etc.)
         */
        async function render(entity, options = {}) {
            const res = await doFetch(renderUrl, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...defaultHeaders,
                    ...bearer(token),
                },
                body: JSON.stringify({ ...entity, options }),
            })
            if (!res.ok) {
                let body
                try { body = await res.json() } catch {}
                throw new MikserError(res.status, res.statusText, body, renderUrl)
            }
            const ct = res.headers.get('content-type') ?? ''
            if (ct.includes('application/json')) return res.json()
            if (ct.startsWith('text/')) return res.text()
            return res.arrayBuffer()
        }

        return { list, query: list, urlFor, pages, watch, live, update, delete: remove, render }
    }

    return { entities }
}

export { MikserError }
