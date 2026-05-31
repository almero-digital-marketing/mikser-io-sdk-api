import { describe, it, expect } from 'vitest'
import { MikserError } from '../src/error.js'

describe('MikserError', () => {
    it('is an Error subclass with the right name', () => {
        const e = new MikserError(404, 'Not Found', null, 'http://x/y')
        expect(e).toBeInstanceOf(Error)
        expect(e).toBeInstanceOf(MikserError)
        expect(e.name).toBe('MikserError')
    })

    it('carries status, body, and url-bearing message', () => {
        const body = { error: 'no such endpoint' }
        const e = new MikserError(404, 'Not Found', body, 'http://x/api/foo')
        expect(e.status).toBe(404)
        expect(e.body).toEqual(body)
        expect(e.message).toContain('404')
        expect(e.message).toContain('Not Found')
        expect(e.message).toContain('no such endpoint')
        expect(e.message).toContain('http://x/api/foo')
    })

    it('handles missing body gracefully', () => {
        const e = new MikserError(500, 'Internal Server Error', null, 'http://x/y')
        expect(e.body).toBeNull()
        expect(e.message).not.toContain('null')
        expect(e.message).toContain('500')
    })

    it('handles body without .error gracefully', () => {
        const e = new MikserError(400, 'Bad Request', { other: 'shape' }, 'http://x/y')
        // No ': ...' suffix when body.error is absent
        expect(e.message).not.toContain(': other')
        expect(e.body).toEqual({ other: 'shape' })
    })

    it('supports instanceof for catch-site dispatch', () => {
        try {
            throw new MikserError(401, 'Unauthorized', null, 'http://x/y')
        } catch (err) {
            expect(err instanceof MikserError).toBe(true)
            expect(err.status).toBe(401)
        }
    })
})
