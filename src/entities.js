// Per-endpoint entities client. Returns a function `entities(name, opts)`
// closed over the createClient-level config (baseUrl, basePath, fetch,
// default headers) — kept here so index.js stays focused on the
// top-level createClient factory.
import { MikserError } from './error.js'
import { bearer, jsonOrThrow } from './http.js'
import { joinUrl, sortToParam, filterToParams } from './url.js'
import { parseSseEvent } from './sse.js'

export function createEntitiesClient({ baseUrl, basePath, fetch: doFetch, headers: defaultHeaders }) {
    return function entities(name, { token } = {}) {
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
         * One-shot: fetch every entity matching the filter into a flat
         * array. Auto-paginates internally via pages() — `limit` in the
         * query controls the per-page batch size (default 1000), not the
         * total cap.
         *
         * Right when: SSG route enumeration, sitemap generation, build-
         * time indexing — anything that needs the whole filtered set in
         * memory at once.
         *
         * Wrong when: the catalog is large enough that loading all of it
         * is wasteful. Use pages() directly and stream-process there.
         */
        async function listAll(query = {}) {
            const items = []
            for await (const env of pages({ limit: 1000, ...query })) {
                items.push(...env.items)
            }
            return items
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
            // Safety net: any error escaping the IIFE (rare, e.g. a late
            // AbortError from a fetch unwind that beats the disposed
            // check) gets swallowed silently rather than surfacing as an
            // unhandled rejection.
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

        return { list, listAll, urlFor, pages, watch, live, update, delete: remove, render }
    }
}
