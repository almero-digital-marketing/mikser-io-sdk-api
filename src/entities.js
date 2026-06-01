// Per-endpoint entities client. Returns a function `entities(name, opts)`
// closed over the createClient-level config (baseUrl, basePath, fetch,
// default headers) — kept here so index.js stays focused on the
// top-level createClient factory.
import { MikserError } from './error.js'
import { bearer, jsonOrThrow } from './http.js'
import { joinUrl, sortToParam, filterToParams } from './url.js'
import { parseSseEvent } from './sse.js'

// Conservative URL-length ceiling for the GET form of list(). Real
// browsers and proxies vary (Chrome ~32k, IIS ~16k, nginx default
// 8k, some CDNs 4k), but the safest interop floor for list-with-
// many-filter-params is well under 2k. Queries past this fall back
// to POST automatically.
const GET_MAX_URL = 1800

// Wide-list warning — surfaces in dev mode when a list/live call
// returns more than this without a `fields` projection. Catches the
// common "I just wanted a nav menu but pulled every full document"
// failure mode at the first place it manifests (developer's DevTools
// console). Server-side has a matching warning that fires for all
// clients regardless of SDK use.
const WIDE_RESPONSE_ITEMS = 50
const _warnedShapes = new Set()

function isProductionEnv() {
    try {
        return typeof process !== 'undefined'
            && process.env?.NODE_ENV === 'production'
    } catch { return false }
}
function isQuiet() {
    try {
        return typeof process !== 'undefined' && process.env?.MIKSER_QUIET
    } catch { return false }
}

function maybeWarnWide({ endpoint, query, envelopeOrItems, quiet }) {
    if (quiet || isProductionEnv() || isQuiet()) return
    const items = Array.isArray(envelopeOrItems)
        ? envelopeOrItems
        : envelopeOrItems?.items
    if (!Array.isArray(items) || items.length <= WIDE_RESPONSE_ITEMS) return
    const hasFields = Array.isArray(query?.fields) && query.fields.length > 0
    if (hasFields) return
    const shape = `${endpoint}|${JSON.stringify(query?.filter ?? null)}|${JSON.stringify(query?.sort ?? null)}`
    if (_warnedShapes.has(shape)) return
    _warnedShapes.add(shape)
    let sizeNote = ''
    try {
        const bytes = JSON.stringify(items).length
        sizeNote = bytes >= 1024 * 1024
            ? ` (~${(bytes / 1024 / 1024).toFixed(1)} MB)`
            : ` (~${Math.round(bytes / 1024)} KB)`
    } catch { /* size note is best-effort */ }
    console.warn(
        `[mikser-sdk] list() returned ${items.length} items${sizeNote} from "${endpoint}" with no \`fields\` projection.\n` +
        `  Add { fields: [...] } to narrow it, or — if this query runs on every page load —\n` +
        `  move it to a \`data.catalog.<name>\` snapshot on the mikser side and load via:\n` +
        `    entities('${endpoint}', { initialUrl: '/data/<name>.json' })\n` +
        `  Suppress: pass { quiet: true } on the call, or set MIKSER_QUIET=1.`,
    )
}

export function createEntitiesClient({ baseUrl, basePath, fetch: doFetch, headers: defaultHeaders }) {
    return function entities(name, opts = {}) {
        const {
            token,
            // initialUrl: optional URL (relative to baseUrl or absolute) for a
            // pre-built static JSON snapshot — typically produced by the
            // `data` plugin's catalog.<name> output. When set, live() fires
            // onChange with the snapshot immediately, then opens the SSE
            // subscribe stream as usual. listAll() also consults the
            // snapshot before falling back to paginated list calls.
            //
            // The fetched JSON is unwrapped automatically — the data
            // plugin emits `[{ refId, name, date, data }, ...]`; we
            // return the `.data` payloads. Plain arrays and { items }
            // envelopes are passed through unchanged.
            //
            // Pre-built snapshots are the fast first-paint path:
            // CDN-cached, no API roundtrip, no SSE latency tax on boot.
            // Pair the snapshot's data-plugin filter with your live()
            // filter so the initial state matches what SSE will send.
            initialUrl,
            // When initialUrl fetch fails (404 in dev, network error,
            // wrong shape), default behavior is to log and fall back to
            // a fresh list() call — keeps dev mode trivial. Set false
            // for environments where you require the snapshot.
            fallbackToList = true,
        } = opts
        const endpointBase = `${basePath}/${name}`
        const queryUrl     = joinUrl(baseUrl, `${endpointBase}/entities/query`)
        const listUrl      = joinUrl(baseUrl, `${endpointBase}/entities`)
        const subscribeUrl = joinUrl(baseUrl, `${endpointBase}/entities/subscribe`)
        const renderUrl    = joinUrl(baseUrl, `${endpointBase}/render`)

        const resolvedInitialUrl = initialUrl
            ? (/^https?:\/\//.test(initialUrl) ? initialUrl : joinUrl(baseUrl, initialUrl))
            : null

        // Cached snapshot promise — concurrent live() / listAll() calls
        // share one fetch. Cleared on error so a flaky connection can
        // recover on the next call.
        let snapshotPromise = null
        async function loadSnapshot() {
            if (!resolvedInitialUrl) return null
            if (snapshotPromise) return snapshotPromise
            snapshotPromise = (async () => {
                try {
                    const res = await doFetch(resolvedInitialUrl, {
                        method: 'GET',
                        headers: { accept: 'application/json', ...defaultHeaders },
                    })
                    if (!res.ok) {
                        if (!fallbackToList) {
                            throw new MikserError(res.status, res.statusText, null, resolvedInitialUrl)
                        }
                        return null
                    }
                    const payload = await res.json()
                    return unwrapSnapshot(payload)
                } catch (err) {
                    // Clear the cached promise so the next call can retry.
                    snapshotPromise = null
                    if (!fallbackToList) throw err
                    return null
                }
            })()
            return snapshotPromise
        }

        /**
         * Run a list query. Returns the standard envelope:
         * { items, page, limit, total, totalPages, hasNext, hasPrev }.
         *
         * Transport selection: tries GET first because GET responses
         * are what the api plugin's per-query disk cache writes (and
         * what a reverse proxy can serve as failover when mikser is
         * down). Falls back to POST when:
         *   - the encoded URL exceeds GET_MAX_URL (browsers and most
         *     proxies start refusing past ~2KB; we use a conservative
         *     limit of 1800)
         *   - GET is explicitly disabled via opts.method = 'POST'
         *
         * GET can express anything sift accepts via the `.$op` URL-param
         * suffix scheme (see urlFor). Use POST when you want to be
         * explicit about not engaging the cache path, e.g. for queries
         * with secrets in the body that shouldn't sit in proxy logs.
         */
        async function list(query = {}, opts = {}) {
            const forcePost = opts.method === 'POST'

            if (!forcePost) {
                const url = urlFor(query)
                if (url.length <= GET_MAX_URL) {
                    const res = await doFetch(url, {
                        method: 'GET',
                        headers: {
                            accept: 'application/json',
                            ...defaultHeaders,
                            ...bearer(token),
                        },
                    })
                    const envelope = await jsonOrThrow(res, url)
                    maybeWarnWide({ endpoint: name, query, envelopeOrItems: envelope, quiet: opts.quiet })
                    return envelope
                }
            }

            // POST fallback — long URLs and forced POST land here.
            const res = await doFetch(queryUrl, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...defaultHeaders,
                    ...bearer(token),
                },
                body: JSON.stringify(query),
            })
            const envelope = await jsonOrThrow(res, queryUrl)
            maybeWarnWide({ endpoint: name, query, envelopeOrItems: envelope, quiet: opts.quiet })
            return envelope
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
            // Snapshot fast path: if no filter/sort/skip is requested
            // beyond what the snapshot was built with, return the
            // pre-built array directly. The caller's filter/sort would
            // require re-querying the live endpoint anyway, so any
            // non-trivial query falls through to the paginated fetch.
            const trivial = !query.filter && !query.sort && !query.skip
            if (trivial && resolvedInitialUrl) {
                const snapshot = await loadSnapshot()
                if (snapshot) {
                    return query.fields
                        ? snapshot.map(item => pickFields(item, query.fields))
                        : snapshot
                }
                // Snapshot unavailable — fall through to paginated fetch.
            }
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
                quiet,
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
                    // Snapshot fast path. Use it only when the caller's
                    // query is trivial enough that the pre-built array
                    // reflects what list() would return — anything more
                    // specific (filter, sort, skip) goes through list()
                    // so the caller's intent is honored.
                    let usedSnapshot = false
                    const trivial = !filter && !sort && !skip
                    if (trivial && resolvedInitialUrl) {
                        const snapshot = await loadSnapshot()
                        if (snapshot) {
                            if (disposed || ac.signal.aborted) return
                            items = fields ? snapshot.map(i => pickFields(i, fields)) : snapshot
                            onChange(items)
                            usedSnapshot = true
                        }
                    }
                    if (!usedSnapshot) {
                        // Pass { quiet } so list()'s wide-warning honors
                        // the live() caller's quiet opt. live() also
                        // does its own snapshot-path warning below for
                        // the case where the initial fill came from
                        // /data/<name>.json — those callers already
                        // opted into the narrow shape, so no warning.
                        const env = await list({ filter, sort, fields, limit, skip }, { quiet })
                        if (disposed || ac.signal.aborted) return
                        items = env.items
                        onChange(items)
                    }

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

// Unwrap a snapshot payload into a plain array of entity-like objects.
// Recognises three shapes:
//   - data-plugin catalog output:  [{ refId, name, date, data }, ...]
//   - plain array of entities:     [{ id, meta, ... }, ...]
//   - list() envelope:             { items: [...], page, ... }
// Returns null on unrecognised shapes so the caller can decide to fall
// back to a fresh list() call (when fallbackToList is true).
function unwrapSnapshot(payload) {
    if (Array.isArray(payload)) {
        if (payload.length === 0) return []
        // Heuristic: data-plugin entries have `refId` + `data`; treat any
        // object with `data` as a wrapped entry and unwrap. Anything else
        // is a plain array.
        if (payload[0] && typeof payload[0] === 'object' && 'data' in payload[0]) {
            return payload.map(entry => entry.data).filter(Boolean)
        }
        return payload
    }
    if (payload && typeof payload === 'object' && Array.isArray(payload.items)) {
        return payload.items
    }
    return null
}

// Project an entity object to only the fields requested. Dotted paths
// supported ("meta.title" → object with `meta.title` set, other meta
// keys dropped). Used by the snapshot fast paths in list/live so a
// caller asking for narrow fields still gets narrow data from the
// snapshot — saves a re-fetch and keeps memory/bundles smaller.
function pickFields(entity, fields) {
    const out = {}
    for (const field of fields) {
        const parts = field.split('.')
        let src = entity, dst = out
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i]
            if (src == null || typeof src !== 'object') { src = undefined; break }
            src = src[part]
            if (dst[part] == null || typeof dst[part] !== 'object') dst[part] = {}
            dst = dst[part]
        }
        if (src !== undefined) {
            const last = parts[parts.length - 1]
            if (src != null && typeof src === 'object' && last in src) {
                dst[last] = src[last]
            } else if (parts.length === 1 && entity[last] !== undefined) {
                out[last] = entity[last]
            }
        }
    }
    return out
}
