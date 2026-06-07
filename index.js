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
//
// Source layout (kept thin so the entry point stays a quick read):
//   src/error.js     — MikserError class
//   src/http.js      — fetch helpers (bearer, jsonOrThrow)
//   src/url.js       — URL building (joinUrl, sortToParam, filterToParams)
//   src/sse.js       — SSE event parser
//   src/entities.js  — per-endpoint entities client (list / watch / live / ...)
//   src/routes.js    — generateMikserRoutes (build-time route enumeration)
//   src/href.js      — createHrefIndex (multilingual reference → URL lookup)
//   src/asset.js     — createAssetIndex (asset metadata lookup)
import { MikserError } from './src/error.js'
import { createEntitiesClient } from './src/entities.js'

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

    const entities = createEntitiesClient({
        baseUrl,
        basePath,
        fetch: doFetch,
        headers: defaultHeaders,
    })

    return { entities }
}

export { MikserError }
export { generateMikserRoutes } from './src/routes.js'
export { createHrefIndex }      from './src/href.js'
export { createAssetIndex }     from './src/asset.js'
export { paginate }             from './src/paginate.js'
