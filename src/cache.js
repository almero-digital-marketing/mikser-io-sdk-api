// Local request cache — dedupe + memoize over an entities client's list(),
// for content read repeatedly that changes rarely (system docs, nav,
// settings, prices). The lightweight tier next to live(): live() is an
// always-fresh SSE subscription; this is load-once with explicit
// invalidation. Pairs with the live href index too — meta()/useHref is
// always-fresh; this is load-once, expand-capable, and readable from
// non-component code (Pinia stores, plain modules), because it's a plain
// factory, not a composable.
//
// Keyed by the WHOLE query — filter/sort/fields/expand/limit/skip/page — so
// a with-expand and a without-expand read of the same filter are distinct
// entries. Same identity rule cacheKeyFor (SDK) and cacheNameForQueryString
// (api) already follow; a href-only key lets a no-expand load shadow an
// expanded one (the gpoint bug that motivated this).
//
// Framework SDKs wrap this with their reactive primitive so a sync peek()
// re-evaluates when an entry lands — see createReactiveCache in -vue/-react/
// -svelte.

// Deterministic JSON: object keys sorted recursively, so two equivalent
// queries (key order aside) produce the same cache key.
function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
    const keys = Object.keys(value).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

export function cacheKey(query = {}) {
    const { filter = null, sort = null, fields = null, expand = null, limit = null, skip = null, page = null } = query
    return stableStringify({ filter, sort, fields, expand, limit, skip, page })
}

/**
 * createCache(docs) — a memoized, deduped view over docs.list().
 *
 *   const cache = createCache(client.entities('public'))
 *   await cache.get({ filter: {...}, expand: [...] })  // fetch + memoize
 *   cache.peek(query)                                   // sync: envelope | undefined
 *   cache.invalidate(query)  // drop one    cache.invalidate()  // drop all
 *   const off = cache.subscribe(() => …)                // notified on any change
 *
 * `get` returns the same envelope shape as list() ({ items, total, … }).
 * Concurrent get()s for the same query share one in-flight request. A
 * failed get() is not memoized (the next call retries).
 *
 * @param {{ list: (query: object, opts?: object) => Promise<object> }} docs
 */
export function createCache(docs) {
    if (!docs || typeof docs.list !== 'function') {
        throw new Error('createCache: pass an entities client (got something without .list)')
    }
    const store = new Map()
    const inflight = new Map()
    const listeners = new Set()
    const notify = () => { for (const cb of listeners) { try { cb() } catch { /* listener errors are not the cache's problem */ } } }

    function get(query = {}, opts = {}) {
        const k = cacheKey(query)
        if (store.has(k)) return Promise.resolve(store.get(k))
        if (inflight.has(k)) return inflight.get(k)
        const p = Promise.resolve(docs.list(query, opts))
            .then(env => {
                store.set(k, env)
                inflight.delete(k)
                notify()
                return env
            })
            .catch(err => { inflight.delete(k); throw err })
        inflight.set(k, p)
        return p
    }

    function peek(query = {}) { return store.get(cacheKey(query)) }
    function has(query = {})  { return store.has(cacheKey(query)) }

    function invalidate(query) {
        if (query === undefined) { store.clear() }
        else { store.delete(cacheKey(query)) }
        notify()
    }

    function subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb) } }

    return { get, peek, has, invalidate, subscribe, key: cacheKey }
}
