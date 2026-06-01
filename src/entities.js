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
        `    entities('${endpoint}', { data: { catalog: '<name>' } })\n` +
        `  Suppress: pass { quiet: true } on the call, or set MIKSER_QUIET=1.`,
    )
}

// Snapshot-bypass warning — fires when `data.catalog` is configured
// but the call is non-trivial (has filter / sort / skip), so the
// snapshot can't be used and the SDK falls back to the live API. The
// bypass is correct behavior, but it's silent: developers often set
// data.catalog once and then add a sort to one of their useDocuments
// calls without noticing the snapshot is no longer involved. Deduped
// per (endpoint, kind, what-was-set) so a page with 3 filtered calls
// produces 3 warnings, not 30.
const _bypassedShapes = new Set()
function maybeWarnSnapshotBypass({ endpoint, kind, filter, sort, skip, quiet }) {
    if (quiet || isProductionEnv() || isQuiet()) return
    const reasons = []
    if (filter) reasons.push('filter')
    if (sort)   reasons.push('sort')
    if (skip != null) reasons.push('skip')
    if (reasons.length === 0) return
    const reasonLabel = reasons.join('+')
    const shape = `${endpoint}|${kind}|${reasonLabel}`
    if (_bypassedShapes.has(shape)) return
    _bypassedShapes.add(shape)
    const fallback = kind === 'live' ? 'live list()' : 'paginated fetch'
    console.warn(
        `[mikser-sdk] data.catalog is set on "${endpoint}" but this ${kind}() call uses ${reasonLabel} — snapshot bypassed, falling back to ${fallback}.\n` +
        `  Snapshots only apply when the call is trivial (no filter/sort/skip).\n` +
        `  Either remove the ${reasonLabel} from this call, or accept the API roundtrip if filtering is intentional.\n` +
        `  Suppress: pass { quiet: true } on the call, or set MIKSER_QUIET=1.`,
    )
}

export function createEntitiesClient({ baseUrl, basePath, fetch: doFetch, headers: defaultHeaders }) {
    return function entities(name, opts = {}) {
        const {
            token,
            // `data` mirrors the mikser-io `data` plugin's config block:
            //
            //   data: {
            //       catalog:  'sitemap',   // pairs with data.catalog.sitemap
            //       entities: 'page',      // pairs with data.entities.page
            //   }
            //
            // On the server the data plugin writes:
            //   - catalog.<name>  → out/data/<name>.json                   (one combined file)
            //   - entities.<name> → out/data/<entity.name>.<name>.json     (one file per entity)
            //
            // On the client:
            //   - `data.catalog` makes live() / listAll() consult
            //     /data/<this>.json on first paint, falling back to a
            //     fresh list() if the file is missing.
            //   - `data.entities` makes live({id}) consult the per-entity
            //     file /data/<entry.name>.<this>.json, falling back to a
            //     fresh list({filter:{id}}) call. Requires `data.catalog`
            //     to be loaded so the entity's `name` is known (the
            //     mapping comes from the catalog wrapper, not the id).
            //
            // Default URL prefix is /data/ to match the data plugin's
            // default `dataFolder`. If a project customizes `data.dataFolder`
            // server-side, add a matching prefix here — but for now this
            // is hardcoded.
            data: dataConfig = {},
        } = opts
        const { catalog: catalogName, entities: entitiesName } = dataConfig
        const endpointBase = `${basePath}/${name}`
        const queryUrl     = joinUrl(baseUrl, `${endpointBase}/entities/query`)
        const listUrl      = joinUrl(baseUrl, `${endpointBase}/entities`)
        const subscribeUrl = joinUrl(baseUrl, `${endpointBase}/entities/subscribe`)
        const renderUrl    = joinUrl(baseUrl, `${endpointBase}/render`)

        // Default URL prefix matches the data plugin's default folder.
        const DATA_PREFIX = '/data'

        const catalogUrl = catalogName
            ? joinUrl(baseUrl, `${DATA_PREFIX}/${catalogName}.json`)
            : null

        // id → entity.name index, populated when the catalog snapshot
        // loads. Lets `live({id})` derive the per-entity file URL
        // without re-fetching the catalog or guessing.
        const nameById = new Map()

        // Cached snapshot promise — concurrent live() / listAll() calls
        // share one fetch. Cleared on error so a flaky connection can
        // recover on the next call.
        let snapshotPromise = null
        async function loadSnapshot() {
            if (!catalogUrl) return null
            if (snapshotPromise) return snapshotPromise
            snapshotPromise = (async () => {
                try {
                    const res = await doFetch(catalogUrl, {
                        method: 'GET',
                        headers: { accept: 'application/json', ...defaultHeaders },
                    })
                    if (!res.ok) return null
                    const payload = await res.json()
                    return unwrapSnapshot(payload, nameById)
                } catch (err) {
                    // Clear the cached promise so the next call can retry.
                    snapshotPromise = null
                    return null
                }
            })()
            return snapshotPromise
        }

        // Per-entity file fetch — for live({id}) when data.entities is
        // configured. Always returns either the entity or null (null
        // means "fall back to the API"). Never throws.
        async function loadEntityFile(id) {
            if (!entitiesName) return null
            const entityName = nameById.get(id)
            if (!entityName) {
                // The catalog isn't loaded yet, or this id wasn't in it.
                // Trigger a catalog load lazily; the next call will hit
                // the populated map.
                await loadSnapshot()
                if (!nameById.has(id)) return null
            }
            const url = joinUrl(baseUrl, `${DATA_PREFIX}/${nameById.get(id)}.${entitiesName}.json`)
            try {
                const res = await doFetch(url, {
                    method: 'GET',
                    headers: { accept: 'application/json', ...defaultHeaders },
                })
                if (!res.ok) return null
                const payload = await res.json()
                // Per-entity files are single-object wrappers:
                //   { refId, name, date, data: {...} }
                // unwrapEntityFile pulls out `data`.
                return unwrapEntityFile(payload)
            } catch {
                return null
            }
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
            if (trivial && catalogUrl) {
                const snapshot = await loadSnapshot()
                if (snapshot) {
                    return query.fields
                        ? snapshot.map(item => pickFields(item, query.fields))
                        : snapshot
                }
                // Snapshot unavailable — fall through to paginated fetch.
            }
            if (!trivial && catalogUrl) {
                maybeWarnSnapshotBypass({
                    endpoint: name, kind: 'listAll',
                    filter: query.filter, sort: query.sort, skip: query.skip,
                })
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
                    let usedFastPath = false
                    const trivial = !filter && !sort && !skip

                    // Per-entity file fast path. When the call is a
                    // single-id lookup (the shape useDocument issues)
                    // and `data.entities` is configured, fetch the
                    // pre-built file the data plugin wrote instead of
                    // calling the API. Falls back to list() if the
                    // file isn't there.
                    const isSingleIdLookup = (
                        entitiesName &&
                        filter && typeof filter === 'object' &&
                        Object.keys(filter).length === 1 &&
                        'id' in filter && filter.id != null
                    )
                    if (isSingleIdLookup) {
                        const entity = await loadEntityFile(filter.id)
                        if (entity) {
                            if (disposed || ac.signal.aborted) return
                            items = fields ? [pickFields(entity, fields)] : [entity]
                            onChange(items)
                            usedFastPath = true
                        }
                    }

                    // Catalog snapshot fast path. Used only when the
                    // call is trivial enough that the pre-built array
                    // reflects what list() would return — anything
                    // more specific (filter, sort, skip) goes through
                    // list() so the caller's intent is honored.
                    if (!usedFastPath && trivial && catalogUrl) {
                        const snapshot = await loadSnapshot()
                        if (snapshot) {
                            if (disposed || ac.signal.aborted) return
                            items = fields ? snapshot.map(i => pickFields(i, fields)) : snapshot
                            onChange(items)
                            usedFastPath = true
                        }
                    }

                    // Bypass warning for cases where the user opted into
                    // a snapshot but their call doesn't fit either fast
                    // path. The single-id lookup is its own valid shape,
                    // so don't warn for it.
                    if (!usedFastPath && !isSingleIdLookup && !trivial && catalogUrl) {
                        maybeWarnSnapshotBypass({
                            endpoint: name, kind: 'live',
                            filter, sort, skip, quiet,
                        })
                    }

                    if (!usedFastPath) {
                        // Pass { quiet } so list()'s wide-warning honors
                        // the live() caller's quiet opt.
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
// back to a fresh list() call.
function unwrapSnapshot(payload, nameById) {
    if (Array.isArray(payload)) {
        if (payload.length === 0) return []
        // Heuristic: data-plugin entries have `refId` + `data`; treat any
        // object with `data` as a wrapped entry and unwrap. Anything else
        // is a plain array.
        if (payload[0] && typeof payload[0] === 'object' && 'data' in payload[0]) {
            return payload
                .map(entry => {
                    if (!entry || !entry.data) return null
                    // Side-table: stash entity.name keyed by entity.id so
                    // live({id}) can compute per-entity file URLs later.
                    if (nameById && entry.data.id != null && entry.name != null) {
                        nameById.set(entry.data.id, entry.name)
                    }
                    return entry.data
                })
                .filter(Boolean)
        }
        return payload
    }
    if (payload && typeof payload === 'object' && Array.isArray(payload.items)) {
        return payload.items
    }
    return null
}

// Per-entity files are single-object wrappers — `{ refId, name, date,
// data: {...} }` — written by `data.entities.<name>` on the server.
// Returns the unwrapped data, or null if the shape isn't recognised.
function unwrapEntityFile(payload) {
    if (!payload || typeof payload !== 'object') return null
    if ('data' in payload && payload.data && typeof payload.data === 'object') {
        return payload.data
    }
    // Plain entity (someone hand-wrote a JSON file, no wrapper) — accept it.
    if ('id' in payload) return payload
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
