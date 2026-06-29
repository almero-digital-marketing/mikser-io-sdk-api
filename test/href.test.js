import { describe, it, expect } from 'vitest'
import { createHrefIndex } from '../src/href.js'

const docs = [
    { id: '/en/about.md', meta: { href: '/about', lang: 'en', route: '/en/about', title: 'About us' } },
    { id: '/fr/about.md', meta: { href: '/about', lang: 'fr', route: '/fr/a-propos', title: 'À propos' } },
    { id: '/menu.yml',    meta: { href: '/menu', route: '/menu', products: [{ name: 'Coffee' }, { name: 'Tea' }] } },
]

describe('createHrefIndex — href / refFor (URL resolution)', () => {
    const ix = createHrefIndex(docs)

    it('resolves a ref to the URL for a language', () => {
        expect(ix.href('/about', 'en')).toBe('/en/about')
        expect(ix.href('/about', 'fr')).toBe('/fr/a-propos')
    })

    it('falls back to the ref string for an unknown ref', () => {
        expect(ix.href('/missing')).toBe('/missing')
    })

    it('reverse-resolves a URL to its ref', () => {
        expect(ix.refFor('/fr/a-propos')).toBe('/about')
        expect(ix.refFor('/nope')).toBe(null)
    })
})

describe('createHrefIndex — docFor / metaFor (content lookup)', () => {
    const ix = createHrefIndex(docs)

    it('resolves a ref to its document, lang-aware', () => {
        expect(ix.docFor('/about', 'en').meta.title).toBe('About us')
        expect(ix.docFor('/about', 'fr').meta.title).toBe('À propos')
    })

    it('metaFor reads content fields off a ref', () => {
        expect(ix.metaFor('/menu').products.map(p => p.name)).toEqual(['Coffee', 'Tea'])
    })

    it('falls back across languages like href() does', () => {
        // no lang passed → defaultLang → any available
        expect(ix.docFor('/about')).not.toBe(null)
        expect(ix.metaFor('/about').href).toBe('/about')
    })

    it('returns null (not a faked doc) for an unknown ref', () => {
        expect(ix.docFor('/missing')).toBe(null)
        expect(ix.metaFor('/missing')).toBe(null)
    })

    it('a doc with no meta.href is excluded from both indexes', () => {
        const ix2 = createHrefIndex([{ id: '/x', meta: { title: 'no href' } }])
        expect(ix2.metaFor('/x')).toBe(null)
        expect(ix2.href('/x')).toBe('/x')
    })
})
