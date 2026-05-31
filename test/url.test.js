import { describe, it, expect } from 'vitest'
import { joinUrl, sortToParam, filterToParams } from '../src/url.js'

describe('joinUrl', () => {
    it('joins a base without trailing slash', () => {
        expect(joinUrl('http://x', '/api')).toBe('http://x/api')
    })

    it('strips a single trailing slash from base', () => {
        expect(joinUrl('http://x/', '/api')).toBe('http://x/api')
    })

    it('leaves the path alone (no normalization on it)', () => {
        expect(joinUrl('http://x', '/api/public/entities')).toBe('http://x/api/public/entities')
    })
})

describe('sortToParam', () => {
    it('emits ascending fields verbatim', () => {
        expect(sortToParam({ name: 1 })).toBe('name')
    })

    it('emits descending fields with a leading minus', () => {
        expect(sortToParam({ name: -1 })).toBe('-name')
    })

    it('joins multiple fields with comma in insertion order', () => {
        // JS object key order = insertion order for string keys
        expect(sortToParam({ name: 1, date: -1 })).toBe('name,-date')
    })

    it('treats any negative number as descending', () => {
        expect(sortToParam({ a: -42 })).toBe('-a')
    })
})

describe('filterToParams', () => {
    it('writes primitive equality directly', () => {
        const p = new URLSearchParams()
        filterToParams({ type: 'document' }, p)
        expect(p.get('type')).toBe('document')
    })

    it('coerces numbers and booleans to strings', () => {
        const p = new URLSearchParams()
        filterToParams({ price: 20, published: true }, p)
        expect(p.get('price')).toBe('20')
        expect(p.get('published')).toBe('true')
    })

    it('expands operator objects into .$op-suffixed params', () => {
        const p = new URLSearchParams()
        filterToParams({ 'meta.price': { $gt: 20 } }, p)
        expect(p.get('meta.price.$gt')).toBe('20')
        // No collapsed value should leak under the unsuffixed key
        expect(p.has('meta.price')).toBe(false)
    })

    it('joins $in arrays with commas', () => {
        const p = new URLSearchParams()
        filterToParams({ 'meta.tags': { $in: ['a', 'b', 'c'] } }, p)
        expect(p.get('meta.tags.$in')).toBe('a,b,c')
    })

    it('joins top-level array values with commas (implicit $in shape)', () => {
        const p = new URLSearchParams()
        filterToParams({ ids: ['1', '2'] }, p)
        expect(p.get('ids')).toBe('1,2')
    })

    it('skips nullish values', () => {
        const p = new URLSearchParams()
        filterToParams({ ignored: null, kept: 'x' }, p)
        expect(p.has('ignored')).toBe(false)
        expect(p.get('kept')).toBe('x')
    })

    it('mutates the URLSearchParams in place (returns nothing useful)', () => {
        const p = new URLSearchParams('?already=here')
        filterToParams({ type: 'document' }, p)
        expect(p.get('already')).toBe('here')
        expect(p.get('type')).toBe('document')
    })
})
