import { describe, it, expect } from 'vitest'
import { paginate } from '../src/paginate.js'

describe('paginate', () => {
    const sample = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: `Item ${i + 1}` }))

    it('chunks items into N evenly-sized pages plus a partial last page', () => {
        const result = paginate(sample, { pageSize: 6 })
        expect(result.pages).toBe(4)
        expect(result.items).toHaveLength(4)
        expect(result.items[0]).toHaveLength(6)
        expect(result.items[1]).toHaveLength(6)
        expect(result.items[2]).toHaveLength(6)
        expect(result.items[3]).toHaveLength(2)
        expect(result.totalItems).toBe(20)
        expect(result.pageSize).toBe(6)
    })

    it('produces exactly N pages when items divides evenly', () => {
        const result = paginate(sample, { pageSize: 5 })
        expect(result.pages).toBe(4)
        expect(result.items.every(p => p.length === 5)).toBe(true)
    })

    it('returns one empty page when there are no items', () => {
        // Layouts still need to render an empty index — better than
        // disappearing from the sitemap.
        const result = paginate([], { pageSize: 10 })
        expect(result.pages).toBe(1)
        expect(result.items).toEqual([[]])
        expect(result.totalItems).toBe(0)
    })

    it('returns one page when items fit in a single page', () => {
        const five = sample.slice(0, 5)
        const result = paginate(five, { pageSize: 10 })
        expect(result.pages).toBe(1)
        expect(result.items).toHaveLength(1)
        expect(result.items[0]).toHaveLength(5)
    })

    it('renames the output key when key is set', () => {
        const result = paginate(sample, { key: 'posts', pageSize: 6 })
        expect(result.posts).toBeDefined()
        expect(result.items).toBeUndefined()
        expect(Array.isArray(result.posts)).toBe(true)
    })

    it('returns pageNumbers with default mikser URL convention', () => {
        const result = paginate(sample, { pageSize: 6 })
        expect(result.pageNumbers).toEqual([
            { num: 1, url: '/'  },
            { num: 2, url: '/2/' },
            { num: 3, url: '/3/' },
            { num: 4, url: '/4/' },
        ])
    })

    it('accepts a custom urlFor for non-root pagination', () => {
        // e.g. paginating /blog/ instead of /
        const result = paginate(sample, {
            pageSize: 6,
            urlFor: (p) => p === 1 ? '/blog/' : `/blog/${p}/`,
        })
        expect(result.pageNumbers[0].url).toBe('/blog/')
        expect(result.pageNumbers[2].url).toBe('/blog/3/')
    })

    it('rejects invalid pageSize', () => {
        expect(() => paginate(sample, { pageSize: 0 })).toThrow(/positive integer/)
        expect(() => paginate(sample, { pageSize: -1 })).toThrow(/positive integer/)
        expect(() => paginate(sample, { pageSize: 1.5 })).toThrow(/positive integer/)
    })

    it('rejects non-array items', () => {
        expect(() => paginate(null, { pageSize: 10 })).toThrow(/must be an array/)
        expect(() => paginate({ items: [] }, { pageSize: 10 })).toThrow(/must be an array/)
    })

    it('preserves item identity — no cloning, items pass through by reference', () => {
        const result = paginate(sample, { pageSize: 5 })
        expect(result.items[0][0]).toBe(sample[0])  // strict equality
    })

    it('defaults: pageSize=10, key=items', () => {
        const result = paginate(sample)
        expect(result.pageSize).toBe(10)
        expect(result.items).toBeDefined()
        expect(result.pages).toBe(2)
    })
})
