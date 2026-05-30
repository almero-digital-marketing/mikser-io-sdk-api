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
        const queryUrl  = joinUrl(baseUrl, `${endpointBase}/entities/query`)
        const listUrl   = joinUrl(baseUrl, `${endpointBase}/entities`)
        const renderUrl = joinUrl(baseUrl, `${endpointBase}/render`)

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

        return { list, query: list, urlFor, pages, update, delete: remove, render }
    }

    return { entities }
}

export { MikserError }
