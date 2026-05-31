import { describe, it, expect } from 'vitest'
import { createClient, MikserError } from '../index.js'
import { fakeResponse, scriptedFetch, sseStream } from './helpers.js'

// Standard envelope shape used across list/pages/live tests.
function envelope({ items = [], page = 1, limit = 10, total = items.length, hasNext = false, hasPrev = false } = {}) {
    return {
        items,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext,
        hasPrev,
    }
}

describe('entities().list', () => {
    it('POSTs the query body to /entities/query', async () => {
        const fetch = scriptedFetch([() => fakeResponse({ json: envelope({ items: [{ id: 'a' }] }) })])
        const client = createClient({ baseUrl: 'http://x', fetch })
        const result = await client.entities('public').list({
            filter: { 'meta.published': true },
            sort: { 'meta.date': -1 },
            limit: 5,
        })

        expect(fetch.calls).toHaveLength(1)
        const [url, init] = fetch.calls[0]
        expect(url).toBe('http://x/api/public/entities/query')
        expect(init.method).toBe('POST')
        expect(init.headers['content-type']).toBe('application/json')
        expect(JSON.parse(init.body)).toEqual({
            filter: { 'meta.published': true },
            sort: { 'meta.date': -1 },
            limit: 5,
        })
        expect(result.items).toEqual([{ id: 'a' }])
    })

    it('defaults to an empty body when no query is passed', async () => {
        const fetch = scriptedFetch([() => fakeResponse({ json: envelope() })])
        const client = createClient({ baseUrl: 'http://x', fetch })
        await client.entities('public').list()
        expect(JSON.parse(fetch.calls[0][1].body)).toEqual({})
    })

    it('attaches a Bearer token when the endpoint has one', async () => {
        const fetch = scriptedFetch([() => fakeResponse({ json: envelope() })])
        const client = createClient({ baseUrl: 'http://x', fetch })
        await client.entities('admin', { token: 'secret' }).list({})
        expect(fetch.calls[0][1].headers.authorization).toBe('Bearer secret')
    })

    it('throws MikserError on non-2xx, carrying status and body', async () => {
        const fetch = scriptedFetch([
            () => fakeResponse({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                json: { error: 'token required' },
            }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })
        const err = await client.entities('public').list({}).catch(e => e)
        expect(err).toBeInstanceOf(MikserError)
        expect(err.status).toBe(401)
        expect(err.body).toEqual({ error: 'token required' })
    })
})

describe('entities().urlFor', () => {
    it('returns the bare entities URL when query is empty', () => {
        const client = createClient({ baseUrl: 'http://x', fetch: () => fakeResponse() })
        expect(client.entities('public').urlFor({})).toBe('http://x/api/public/entities')
    })

    it('appends page / limit / skip as plain params', () => {
        const client = createClient({ baseUrl: 'http://x', fetch: () => fakeResponse() })
        const url = new URL(client.entities('public').urlFor({ page: 2, limit: 25, skip: 50 }))
        expect(url.searchParams.get('page')).toBe('2')
        expect(url.searchParams.get('limit')).toBe('25')
        expect(url.searchParams.get('skip')).toBe('50')
    })

    it('serializes sort as comma-separated with leading "-" for descending', () => {
        const client = createClient({ baseUrl: 'http://x', fetch: () => fakeResponse() })
        const url = new URL(client.entities('public').urlFor({ sort: { name: 1, date: -1 } }))
        expect(url.searchParams.get('sort')).toBe('name,-date')
    })

    it('serializes fields projection as comma-separated', () => {
        const client = createClient({ baseUrl: 'http://x', fetch: () => fakeResponse() })
        const url = new URL(client.entities('public').urlFor({ fields: ['id', 'meta.title'] }))
        expect(url.searchParams.get('fields')).toBe('id,meta.title')
    })

    it('expands filter operators to .$op-suffixed params', () => {
        const client = createClient({ baseUrl: 'http://x', fetch: () => fakeResponse() })
        const url = new URL(client.entities('public').urlFor({
            filter: { 'meta.price': { $gt: 20 }, type: 'document' },
        }))
        expect(url.searchParams.get('meta.price.$gt')).toBe('20')
        expect(url.searchParams.get('type')).toBe('document')
    })

    it('omits zero-valued params correctly (treats nullish, not falsy)', () => {
        const client = createClient({ baseUrl: 'http://x', fetch: () => fakeResponse() })
        // page=0 / limit=0 should still appear — they're not null
        const url = new URL(client.entities('public').urlFor({ page: 0, limit: 0 }))
        expect(url.searchParams.get('page')).toBe('0')
        expect(url.searchParams.get('limit')).toBe('0')
    })
})

describe('entities().pages', () => {
    it('iterates until hasNext is false', async () => {
        const fetch = scriptedFetch([
            () => fakeResponse({ json: envelope({ items: [1, 2], page: 1, limit: 2, total: 5, hasNext: true }) }),
            () => fakeResponse({ json: envelope({ items: [3, 4], page: 2, limit: 2, total: 5, hasNext: true }) }),
            () => fakeResponse({ json: envelope({ items: [5],    page: 3, limit: 2, total: 5, hasNext: false }) }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })

        const pages = []
        for await (const env of client.entities('public').pages({ limit: 2 })) {
            pages.push(env.items)
        }
        expect(pages).toEqual([[1, 2], [3, 4], [5]])
        // Verify each subsequent call asked for the next page
        const bodies = fetch.calls.map(([, init]) => JSON.parse(init.body))
        expect(bodies.map(b => b.page)).toEqual([1, 2, 3])
    })

    it('starts from the page in the query if supplied', async () => {
        const fetch = scriptedFetch([
            () => fakeResponse({ json: envelope({ items: [10], page: 5, hasNext: false }) }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })
        const collected = []
        for await (const env of client.entities('public').pages({ page: 5 })) {
            collected.push(env)
        }
        expect(collected).toHaveLength(1)
        expect(JSON.parse(fetch.calls[0][1].body).page).toBe(5)
    })
})

describe('entities().update', () => {
    it('PUTs collection / relativePath / content as JSON', async () => {
        const fetch = scriptedFetch([() => fakeResponse({ json: { ok: true } })])
        const client = createClient({ baseUrl: 'http://x', fetch })
        await client.entities('admin', { token: 'secret' }).update({
            collection: 'documents',
            relativePath: 'en/about.md',
            content: '---\ntitle: About\n---\n\nHi.',
        })

        const [url, init] = fetch.calls[0]
        expect(url).toBe('http://x/api/admin/entities')
        expect(init.method).toBe('PUT')
        expect(init.headers.authorization).toBe('Bearer secret')
        expect(JSON.parse(init.body)).toEqual({
            collection: 'documents',
            relativePath: 'en/about.md',
            content: '---\ntitle: About\n---\n\nHi.',
        })
    })

    it('defaults content to empty string', async () => {
        const fetch = scriptedFetch([() => fakeResponse({ json: { ok: true } })])
        const client = createClient({ baseUrl: 'http://x', fetch })
        await client.entities('admin').update({ collection: 'documents', relativePath: 'x.md' })
        expect(JSON.parse(fetch.calls[0][1].body).content).toBe('')
    })
})

describe('entities().delete', () => {
    it('sends DELETE with the path body', async () => {
        const fetch = scriptedFetch([() => fakeResponse({ json: { ok: true } })])
        const client = createClient({ baseUrl: 'http://x', fetch })
        await client.entities('admin').delete({ collection: 'documents', relativePath: 'old.md' })

        const [url, init] = fetch.calls[0]
        expect(url).toBe('http://x/api/admin/entities')
        expect(init.method).toBe('DELETE')
        expect(JSON.parse(init.body)).toEqual({
            collection: 'documents',
            relativePath: 'old.md',
        })
    })
})

describe('entities().render', () => {
    it('parses JSON responses (application/json)', async () => {
        const fetch = scriptedFetch([
            () => fakeResponse({ contentType: 'application/json', json: { rendered: 'ok' } }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })
        const result = await client.entities('public').render({ id: 'a' })
        expect(result).toEqual({ rendered: 'ok' })
    })

    it('parses text responses (text/html)', async () => {
        const fetch = scriptedFetch([
            () => fakeResponse({ contentType: 'text/html', text: '<h1>hi</h1>' }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })
        const result = await client.entities('public').render({ id: 'a' })
        expect(result).toBe('<h1>hi</h1>')
    })

    it('returns ArrayBuffer for binary responses (application/pdf)', async () => {
        const buf = new ArrayBuffer(8)
        const fetch = scriptedFetch([
            () => fakeResponse({ contentType: 'application/pdf', buffer: buf }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })
        const result = await client.entities('public').render({ id: 'a' })
        expect(result).toBeInstanceOf(ArrayBuffer)
        expect(result.byteLength).toBe(8)
    })

    it('throws MikserError on non-2xx render', async () => {
        const fetch = scriptedFetch([
            () => fakeResponse({
                ok: false,
                status: 500,
                statusText: 'Render failed',
                json: { error: 'timeout' },
            }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })
        await expect(client.entities('public').render({ id: 'a' }))
            .rejects.toMatchObject({ name: 'MikserError', status: 500, body: { error: 'timeout' } })
    })

    it('sends the entity merged with options as the body', async () => {
        const fetch = scriptedFetch([
            () => fakeResponse({ contentType: 'application/json', json: {} }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })
        await client.entities('public').render({ id: 'a', meta: { layout: 'page' } }, { format: 'pdf' })
        const body = JSON.parse(fetch.calls[0][1].body)
        expect(body).toEqual({ id: 'a', meta: { layout: 'page' }, options: { format: 'pdf' } })
    })
})

describe('entities().watch', () => {
    it('yields parsed events from the SSE stream', async () => {
        const stream = sseStream([
            'event: init\ndata: {"subscriptionId":"s1","endpoint":"public"}\n\n',
            'event: create\ndata: {"id":"a","entity":{"id":"a","meta":{}}}\n\n',
            'event: heartbeat\ndata: {}\n\n',
            'event: delete\ndata: {"id":"a"}\n\n',
        ])
        const fetch = scriptedFetch([() => fakeResponse({ body: stream })])
        const client = createClient({ baseUrl: 'http://x', fetch })

        const events = []
        for await (const event of client.entities('public').watch({})) {
            events.push(event)
        }
        expect(events.map(e => e.type)).toEqual(['init', 'create', 'heartbeat', 'delete'])
        expect(events[1]).toMatchObject({ type: 'create', id: 'a', entity: { id: 'a' } })
        expect(events[3]).toEqual({ type: 'delete', id: 'a' })
    })

    it('throws MikserError when the stream open fails (non-2xx)', async () => {
        const fetch = scriptedFetch([() => fakeResponse({
            ok: false, status: 403, statusText: 'Forbidden', json: { error: 'no subscribe op' },
        })])
        const client = createClient({ baseUrl: 'http://x', fetch })
        await expect((async () => {
            for await (const _ of client.entities('public').watch({})) { /* drain */ }
        })()).rejects.toMatchObject({ name: 'MikserError', status: 403 })
    })

    it('attaches the filter to the URL via search params', async () => {
        const fetch = scriptedFetch([() => fakeResponse({
            body: sseStream(['event: heartbeat\ndata: {}\n\n']),
        })])
        const client = createClient({ baseUrl: 'http://x', fetch })
        for await (const _ of client.entities('public').watch({
            filter: { type: 'document', 'meta.published': true },
        })) {
            break
        }
        const url = new URL(fetch.calls[0][0])
        expect(url.pathname).toBe('/api/public/entities/subscribe')
        expect(url.searchParams.get('type')).toBe('document')
        expect(url.searchParams.get('meta.published')).toBe('true')
    })

    it('stops yielding when the abort signal fires', async () => {
        // A slow stream — we'll abort before all events arrive.
        const stream = sseStream([
            'event: init\ndata: {}\n\n',
            'event: create\ndata: {"id":"a","entity":{"id":"a"}}\n\n',
            'event: create\ndata: {"id":"b","entity":{"id":"b"}}\n\n',
        ])
        const fetch = scriptedFetch([() => fakeResponse({ body: stream })])
        const client = createClient({ baseUrl: 'http://x', fetch })

        const ac = new AbortController()
        const events = []
        const iter = client.entities('public').watch({}, { signal: ac.signal })
        for await (const event of iter) {
            events.push(event)
            if (events.length === 2) {
                ac.abort()
                break
            }
        }
        // We may have observed up to the second event before aborting.
        expect(events.length).toBeGreaterThanOrEqual(1)
        expect(events.length).toBeLessThanOrEqual(2)
    })
})

describe('entities().live', () => {
    it('calls onChange with the initial items, then patches on events', async () => {
        const stream = sseStream([
            'event: init\ndata: {}\n\n',
            'event: create\ndata: {"id":"c","entity":{"id":"c","meta":{}}}\n\n',
            'event: update\ndata: {"id":"a","entity":{"id":"a","meta":{"updated":true}}}\n\n',
            'event: delete\ndata: {"id":"b"}\n\n',
        ])
        const fetch = scriptedFetch([
            () => fakeResponse({ json: envelope({ items: [{ id: 'a' }, { id: 'b' }] }) }),
            () => fakeResponse({ body: stream }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })

        const snapshots = []
        const dispose = client.entities('public').live({}, (items) => {
            snapshots.push(items.map(i => i.id))
        })

        // Let the SSE consumer drain. Multiple ticks because the stream
        // helper yields between chunks.
        await new Promise(r => setTimeout(r, 50))
        dispose()
        // Drain any tail callbacks the dispose might be racing with.
        await new Promise(r => setTimeout(r, 10))

        // The first snapshot is the initial list. Subsequent snapshots
        // reflect each create / update / delete in order. We assert the
        // sequence is the expected shape, not strictly the count, since
        // the live loop may observe events at slightly different timings.
        expect(snapshots[0]).toEqual(['a', 'b'])
        expect(snapshots.at(-1)).not.toContain('b')           // 'b' got deleted
        expect(snapshots.flat()).toContain('c')                // 'c' got created at some point
    })

    it('routes a list() error through onError', async () => {
        const fetch = scriptedFetch([
            () => fakeResponse({
                ok: false, status: 500, statusText: 'Server', json: { error: 'boom' },
            }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })

        const errors = []
        const dispose = client.entities('public').live({}, () => {}, {
            onError: (err) => errors.push(err),
        })

        await new Promise(r => setTimeout(r, 20))
        dispose()
        await new Promise(r => setTimeout(r, 10))

        expect(errors).toHaveLength(1)
        expect(errors[0]).toBeInstanceOf(MikserError)
        expect(errors[0].status).toBe(500)
    })

    it('dispose() prevents further onChange calls', async () => {
        const stream = sseStream([
            'event: init\ndata: {}\n\n',
            // After init we'd normally see events; dispose first.
        ])
        const fetch = scriptedFetch([
            () => fakeResponse({ json: envelope({ items: [{ id: 'a' }] }) }),
            () => fakeResponse({ body: stream }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })

        const snapshots = []
        const dispose = client.entities('public').live({}, (items) => {
            snapshots.push(items.map(i => i.id))
        })

        // Wait for the initial onChange, then dispose.
        await new Promise(r => setTimeout(r, 20))
        const countBeforeDispose = snapshots.length
        dispose()
        await new Promise(r => setTimeout(r, 30))
        // No more snapshots should land after dispose.
        expect(snapshots.length).toBe(countBeforeDispose)
    })

    it('dispose is safe to call multiple times', () => {
        const client = createClient({ baseUrl: 'http://x', fetch: () => fakeResponse({ json: envelope() }) })
        const dispose = client.entities('public').live({}, () => {})
        expect(() => { dispose(); dispose(); dispose() }).not.toThrow()
    })

    it('respects an external AbortSignal', async () => {
        const ac = new AbortController()
        ac.abort()         // already aborted before live() runs
        const fetch = scriptedFetch([
            () => fakeResponse({ json: envelope({ items: [{ id: 'a' }] }) }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })

        const snapshots = []
        client.entities('public').live({}, (items) => {
            snapshots.push(items)
        }, { signal: ac.signal })

        await new Promise(r => setTimeout(r, 20))
        // The list call may complete, but the disposed-check before the
        // first onChange should prevent any snapshots from landing.
        expect(snapshots.length).toBe(0)
    })
})
