import { describe, it, expect } from 'vitest'
import { bearer, jsonOrThrow } from '../src/http.js'
import { MikserError } from '../src/error.js'
import { fakeResponse } from './helpers.js'

describe('bearer', () => {
    it('returns an authorization header when a token is given', () => {
        expect(bearer('abc')).toEqual({ authorization: 'Bearer abc' })
    })

    it('returns an empty object when no token', () => {
        expect(bearer()).toEqual({})
        expect(bearer(null)).toEqual({})
        expect(bearer('')).toEqual({})
        expect(bearer(undefined)).toEqual({})
    })
})

describe('jsonOrThrow', () => {
    it('returns parsed JSON on 2xx', async () => {
        const res = fakeResponse({ json: { items: [1, 2] } })
        await expect(jsonOrThrow(res, 'http://x/y')).resolves.toEqual({ items: [1, 2] })
    })

    it('throws MikserError on non-2xx, carrying status and body', async () => {
        const res = fakeResponse({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            json: { error: 'no such endpoint' },
        })
        await expect(jsonOrThrow(res, 'http://x/y')).rejects.toMatchObject({
            name: 'MikserError',
            status: 404,
            body: { error: 'no such endpoint' },
        })
    })

    it('still throws when the error body is unparseable', async () => {
        const res = {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            // .json() rejects to simulate an HTML/plain-text error page
            json: () => Promise.reject(new Error('not json')),
        }
        await expect(jsonOrThrow(res, 'http://x/y')).rejects.toBeInstanceOf(MikserError)
        await expect(jsonOrThrow(res, 'http://x/y')).rejects.toMatchObject({
            status: 500,
            body: undefined,
        })
    })
})
