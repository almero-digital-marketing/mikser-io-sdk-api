import { describe, it, expect, vi } from 'vitest'
import { deployedUrl, watchAssetFallbacks } from '../index.js'

describe('deployedUrl', () => {
    it('joins a base-relative served path to the base', () => {
        expect(deployedUrl('/img/products/X.jpg', { baseUrl: 'https://cms.example.com' }))
            .toBe('https://cms.example.com/img/products/X.jpg')
    })

    it('joins a preset derivative path the same way', () => {
        expect(deployedUrl('/assets/poster/media/bg/X.jpg', { baseUrl: 'https://cms.example.com' }))
            .toBe('https://cms.example.com/assets/poster/media/bg/X.jpg')
    })

    it('returns the ref unchanged when no baseUrl (same-origin)', () => {
        expect(deployedUrl('/img/x.jpg')).toBe('/img/x.jpg')
    })

    it('passes an already-absolute ref through untouched (render baked the origin)', () => {
        expect(deployedUrl('https://cdn.example.com/assets/poster/x.jpg', { baseUrl: 'https://cms.example.com' }))
            .toBe('https://cdn.example.com/assets/poster/x.jpg')
    })

    it('returns empty string for an empty/missing ref', () => {
        expect(deployedUrl('')).toBe('')
        expect(deployedUrl(undefined)).toBe('')
    })

    it('tolerates a base with a trailing slash (no double slash)', () => {
        expect(deployedUrl('/img/x.jpg', { baseUrl: 'https://cms.example.com/' }))
            .toBe('https://cms.example.com/img/x.jpg')
    })
})

describe('watchAssetFallbacks', () => {
    // Minimal fake document that records the capture-phase 'error' listener.
    function fakeDoc() {
        let handler = null
        return {
            addEventListener: (type, fn, capture) => { if (type === 'error' && capture) handler = fn },
            removeEventListener: vi.fn(),
            fire: (target) => handler?.({ target }),
            get installed() { return !!handler },
        }
    }

    it('is a no-op (returns a function) when there is no document', () => {
        const teardown = watchAssetFallbacks({ doc: null })
        expect(typeof teardown).toBe('function')
        expect(() => teardown()).not.toThrow()
    })

    it('warns when an <img> fires an error (HTML-as-image / missing base)', () => {
        const doc = fakeDoc()
        const warn = vi.fn()
        watchAssetFallbacks({ doc, warn })
        expect(doc.installed).toBe(true)
        doc.fire({ tagName: 'IMG', currentSrc: '/img/products/X.jpg' })
        expect(warn).toHaveBeenCalledOnce()
        expect(warn.mock.calls[0][0]).toContain('/img/products/X.jpg')
    })

    it('warns for <video> too, using poster when src is absent', () => {
        const doc = fakeDoc()
        const warn = vi.fn()
        watchAssetFallbacks({ doc, warn })
        doc.fire({ tagName: 'VIDEO', poster: '/assets/poster/x.jpg' })
        expect(warn).toHaveBeenCalledOnce()
        expect(warn.mock.calls[0][0]).toContain('/assets/poster/x.jpg')
    })

    it('ignores errors from non-media elements', () => {
        const doc = fakeDoc()
        const warn = vi.fn()
        watchAssetFallbacks({ doc, warn })
        doc.fire({ tagName: 'SCRIPT', src: '/app.js' })
        expect(warn).not.toHaveBeenCalled()
    })

    it('teardown removes the listener', () => {
        const doc = fakeDoc()
        const teardown = watchAssetFallbacks({ doc, warn: vi.fn() })
        teardown()
        expect(doc.removeEventListener).toHaveBeenCalledOnce()
    })
})
