import { describe, it, expect, vi } from 'vitest'
import { createCache, cacheKey } from '../index.js'

// Minimal fake entities client: records every list() call and returns a
// per-call envelope so we can assert memoization / dedupe.
function fakeDocs(envelopeFor = (q) => ({ items: [{ id: 'x', q }], total: 1 })) {
    const calls = []
    return {
        calls,
        list: vi.fn(async (query, opts) => { calls.push({ query, opts }); return envelopeFor(query) }),
    }
}

describe('cacheKey', () => {
    it('is stable across object key order', () => {
        expect(cacheKey({ filter: { a: 1, b: 2 }, expand: ['x'] }))
            .toBe(cacheKey({ expand: ['x'], filter: { b: 2, a: 1 } }))
    })
    it('differs when expand differs (the identity rule)', () => {
        expect(cacheKey({ filter: { id: '/p' } }))
            .not.toBe(cacheKey({ filter: { id: '/p' }, expand: ['products.*.video'] }))
    })
})

describe('createCache', () => {
    it('memoizes — a second get() for the same query does not refetch', async () => {
        const docs = fakeDocs()
        const cache = createCache(docs)
        const q = { filter: { 'meta.href': '/system/products' } }
        await cache.get(q)
        await cache.get(q)
        expect(docs.list).toHaveBeenCalledOnce()
    })

    it('dedupes concurrent get()s into one in-flight request', async () => {
        const docs = fakeDocs()
        const cache = createCache(docs)
        const q = { filter: { x: 1 } }
        const [a, b] = await Promise.all([cache.get(q), cache.get(q)])
        expect(docs.list).toHaveBeenCalledOnce()
        expect(a).toBe(b)
    })

    it('keys on expand — with vs without expand are distinct entries', async () => {
        const docs = fakeDocs(q => ({ items: [{ expanded: !!q.expand }] }))
        const cache = createCache(docs)
        const plain = await cache.get({ filter: { id: '/p' } })
        const expanded = await cache.get({ filter: { id: '/p' }, expand: ['a'] })
        expect(docs.list).toHaveBeenCalledTimes(2)
        expect(plain.items[0].expanded).toBe(false)
        expect(expanded.items[0].expanded).toBe(true)
    })

    it('peek() is sync — undefined before load, the envelope after', async () => {
        const docs = fakeDocs()
        const cache = createCache(docs)
        const q = { filter: { y: 1 } }
        expect(cache.peek(q)).toBeUndefined()
        await cache.get(q)
        expect(cache.peek(q)).toBeDefined()
    })

    it('invalidate(query) drops one entry; invalidate() drops all', async () => {
        const docs = fakeDocs()
        const cache = createCache(docs)
        await cache.get({ filter: { a: 1 } })
        await cache.get({ filter: { b: 1 } })
        cache.invalidate({ filter: { a: 1 } })
        expect(cache.has({ filter: { a: 1 } })).toBe(false)
        expect(cache.has({ filter: { b: 1 } })).toBe(true)
        cache.invalidate()
        expect(cache.has({ filter: { b: 1 } })).toBe(false)
    })

    it('notifies subscribers on set and on invalidate', async () => {
        const docs = fakeDocs()
        const cache = createCache(docs)
        const cb = vi.fn()
        const off = cache.subscribe(cb)
        await cache.get({ filter: { a: 1 } })  // set → notify
        cache.invalidate({ filter: { a: 1 } }) // drop → notify
        expect(cb).toHaveBeenCalledTimes(2)
        off()
        cache.invalidate()
        expect(cb).toHaveBeenCalledTimes(2)    // unsubscribed
    })

    it('does not memoize a failed get() — the next call retries', async () => {
        let n = 0
        const docs = { list: vi.fn(async () => { if (n++ === 0) throw new Error('boom'); return { items: [{ ok: true }] } }) }
        const cache = createCache(docs)
        await expect(cache.get({ filter: { a: 1 } })).rejects.toThrow('boom')
        const env = await cache.get({ filter: { a: 1 } })
        expect(env.items[0].ok).toBe(true)
        expect(docs.list).toHaveBeenCalledTimes(2)
    })

    it('throws if given something without .list', () => {
        expect(() => createCache({})).toThrow(/entities client/)
    })
})
