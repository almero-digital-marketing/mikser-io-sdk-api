import { describe, it, expect } from 'vitest'
import { createClient } from '../index.js'
import { fakeResponse, scriptedFetch } from './helpers.js'

// Build a fake server that returns N items split into pages of `pageSize`.
// Each list({ page, limit }) call returns just the relevant slice — what
// the real api plugin does. We assert the paginator only fetches the
// pages it asks for, not the full set.
function pagedServer(totalItems, pageSize) {
    const all = Array.from({ length: totalItems }, (_, i) => ({ id: `item-${i + 1}` }))
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    return (url) => {
        const parsed = new URL(url, 'http://x')
        const page = Number(parsed.searchParams.get('page') ?? '1')
        const limit = Number(parsed.searchParams.get('limit') ?? String(pageSize))
        const start = (page - 1) * limit
        const items = all.slice(start, start + limit)
        return fakeResponse({
            json: {
                items, page, limit,
                total:      totalItems,
                totalPages,
                hasNext:    page < totalPages,
                hasPrev:    page > 1,
            },
        })
    }
}

function client(fetch) {
    return createClient({ baseUrl: 'http://x', fetch }).entities('public')
}

describe('paginator', () => {
    it('starts unloaded — page = 1, items = [], loaded = false', () => {
        const p = client(scriptedFetch([])).paginator({ pageSize: 6 })
        expect(p.loaded).toBe(false)
        expect(p.page).toBe(1)
        expect(p.items).toEqual([])
        expect(p.pages).toBe(1)
    })

    it('goTo(1) fetches the first page only — server gets one request', async () => {
        const fetch = scriptedFetch([pagedServer(20, 6)])
        const docs = client(fetch)
        const p = docs.paginator({ pageSize: 6 })
        await p.goTo(1)

        expect(fetch.calls).toHaveLength(1)
        const url = new URL(fetch.calls[0][0])
        expect(url.searchParams.get('page')).toBe('1')
        expect(url.searchParams.get('limit')).toBe('6')

        expect(p.loaded).toBe(true)
        expect(p.page).toBe(1)
        expect(p.pages).toBe(4)
        expect(p.items).toHaveLength(6)
        expect(p.items[0]).toEqual({ id: 'item-1' })
        expect(p.totalItems).toBe(20)
        expect(p.pageSize).toBe(6)
    })

    it('next() fetches the next page from the server (not the full set)', async () => {
        const handler = pagedServer(20, 6)
        const fetch = scriptedFetch([handler, handler, handler])
        const p = client(fetch).paginator({ pageSize: 6 })

        await p.goTo(1)
        await p.next()
        expect(fetch.calls).toHaveLength(2)
        expect(p.page).toBe(2)
        expect(p.items[0]).toEqual({ id: 'item-7' })

        await p.next()
        expect(fetch.calls).toHaveLength(3)
        expect(p.page).toBe(3)
        expect(p.items[0]).toEqual({ id: 'item-13' })
    })

    it('prev() fetches the previous page from the server', async () => {
        const handler = pagedServer(20, 6)
        const fetch = scriptedFetch([handler, handler, handler])
        const p = client(fetch).paginator({ pageSize: 6 })

        await p.goTo(3)
        await p.prev()
        expect(p.page).toBe(2)
        expect(p.items[0]).toEqual({ id: 'item-7' })
    })

    it('hasNext / hasPrev reflect position', async () => {
        const handler = pagedServer(20, 6)
        const fetch = scriptedFetch([handler, handler, handler])
        const p = client(fetch).paginator({ pageSize: 6 })

        await p.goTo(1)
        expect(p.hasNext).toBe(true)
        expect(p.hasPrev).toBe(false)

        await p.goTo(4)  // last page
        expect(p.hasNext).toBe(false)
        expect(p.hasPrev).toBe(true)

        await p.goTo(2)
        expect(p.hasNext).toBe(true)
        expect(p.hasPrev).toBe(true)
    })

    it('next() throws at the last page', async () => {
        const fetch = scriptedFetch([pagedServer(20, 6)])
        const p = client(fetch).paginator({ pageSize: 6 })
        await p.goTo(4)
        await expect(p.next()).rejects.toThrow(/last page/)
    })

    it('prev() throws at the first page', async () => {
        const fetch = scriptedFetch([pagedServer(20, 6)])
        const p = client(fetch).paginator({ pageSize: 6 })
        await p.goTo(1)
        await expect(p.prev()).rejects.toThrow(/first page/)
    })

    it('passes filter / sort / fields through to list()', async () => {
        const fetch = scriptedFetch([pagedServer(20, 6)])
        const p = client(fetch).paginator({
            filter:   { 'meta.layout': 'post' },
            sort:     { 'meta.date': -1 },
            fields:   ['meta.title'],
            pageSize: 6,
        })
        await p.goTo(1)

        const url = new URL(fetch.calls[0][0])
        expect(url.searchParams.get('meta.layout')).toBe('post')
        expect(url.searchParams.get('sort')).toBe('-meta.date')
        expect(url.searchParams.get('fields')).toBe('meta.title')
    })

    it('pageNumbers includes per-page URLs and current marker', async () => {
        const fetch = scriptedFetch([pagedServer(20, 6)])
        const p = client(fetch).paginator({ pageSize: 6 })
        await p.goTo(2)

        expect(p.pageNumbers).toEqual([
            { num: 1, url: '/',  isCurrent: false },
            { num: 2, url: '/2/', isCurrent: true  },
            { num: 3, url: '/3/', isCurrent: false },
            { num: 4, url: '/4/', isCurrent: false },
        ])
    })

    it('accepts a custom urlFor (e.g. SPA hash routing)', async () => {
        const fetch = scriptedFetch([pagedServer(20, 6)])
        const p = client(fetch).paginator({
            pageSize: 6,
            urlFor:   (n) => `#/posts/${n}`,
        })
        await p.goTo(1)
        expect(p.pageNumbers.map(x => x.url)).toEqual([
            '#/posts/1', '#/posts/2', '#/posts/3', '#/posts/4',
        ])
    })

    it('rejects invalid pageSize at construction', () => {
        const docs = client(scriptedFetch([]))
        expect(() => docs.paginator({ pageSize: 0   })).toThrow(/positive integer/)
        expect(() => docs.paginator({ pageSize: -1  })).toThrow(/positive integer/)
        expect(() => docs.paginator({ pageSize: 1.5 })).toThrow(/positive integer/)
    })

    it('goTo() rejects invalid page numbers', async () => {
        const fetch = scriptedFetch([])
        const p = client(fetch).paginator({ pageSize: 6 })
        await expect(p.goTo(0)).rejects.toThrow(/positive integer/)
        await expect(p.goTo(-1)).rejects.toThrow(/positive integer/)
        await expect(p.goTo(1.5)).rejects.toThrow(/positive integer/)
        expect(fetch.calls).toHaveLength(0)  // no network on validation failure
    })

    it('does NOT pre-load — pageSize=6 over 100 items, fetching page 5 makes exactly ONE request', async () => {
        const fetch = scriptedFetch([pagedServer(100, 6)])
        const p = client(fetch).paginator({ pageSize: 6 })
        await p.goTo(5)

        expect(fetch.calls).toHaveLength(1)
        expect(p.items).toHaveLength(6)
        expect(p.items[0]).toEqual({ id: 'item-25' })  // (5-1)*6 + 1 = 25
        expect(p.totalItems).toBe(100)
        expect(p.pages).toBe(17)  // ceil(100/6)
    })
})
