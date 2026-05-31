import { describe, it, expect } from 'vitest'
import { createClient, MikserError } from '../index.js'
import { scriptedFetch, fakeResponse } from './helpers.js'

describe('createClient', () => {
    it('throws when baseUrl is missing', () => {
        expect(() => createClient({})).toThrow(/baseUrl is required/)
        expect(() => createClient()).toThrow(/baseUrl is required/)
    })

    it('throws when no fetch is available and globalThis.fetch is undefined', () => {
        const originalFetch = globalThis.fetch
        // Simulate an environment without fetch
        // @ts-ignore — deliberately wiping for the test
        delete globalThis.fetch
        try {
            expect(() => createClient({ baseUrl: 'http://x' }))
                .toThrow(/no fetch available/)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('accepts a custom fetch implementation', () => {
        const client = createClient({
            baseUrl: 'http://x',
            fetch: () => fakeResponse({ json: {} }),
        })
        expect(client).toHaveProperty('entities')
        expect(typeof client.entities).toBe('function')
    })

    it('exposes MikserError as a named export', () => {
        expect(MikserError).toBeDefined()
        expect(MikserError.name).toBe('MikserError')
    })

    it('attaches default headers to every request', async () => {
        const fetch = scriptedFetch([
            () => fakeResponse({ json: { items: [], page: 1, limit: 10, total: 0, hasNext: false } }),
        ])
        const client = createClient({
            baseUrl: 'http://x',
            fetch,
            headers: { 'x-trace-id': 'abc-123' },
        })
        await client.entities('public').list({})
        const [, init] = fetch.calls[0]
        expect(init.headers['x-trace-id']).toBe('abc-123')
    })

    it('uses the default basePath "/api" when not overridden', async () => {
        const fetch = scriptedFetch([
            () => fakeResponse({ json: { items: [] } }),
        ])
        const client = createClient({ baseUrl: 'http://x', fetch })
        await client.entities('public').list({})
        expect(fetch.calls[0][0]).toBe('http://x/api/public/entities/query')
    })

    it('honors a custom basePath', async () => {
        const fetch = scriptedFetch([
            () => fakeResponse({ json: { items: [] } }),
        ])
        const client = createClient({ baseUrl: 'http://x', basePath: '/v1', fetch })
        await client.entities('public').list({})
        expect(fetch.calls[0][0]).toBe('http://x/v1/public/entities/query')
    })
})
