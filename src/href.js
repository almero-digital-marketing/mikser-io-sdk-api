// Multilingual href resolution — pure data version. Framework SDKs
// (Vue/React/Svelte) wrap this in their own reactivity primitives and
// expose useHref / useAlternates composables on top.
//
// The "logical reference → deployed URL" mapping lets the consumer
// link to a content-shaped identifier (`/about`) and have it resolve
// to whatever URL the current locale serves it at (`/en/about`,
// `/fr/a-propos`, etc.). Convention is three meta fields:
//
//   meta.href:  '/about'              (logical reference)
//   meta.lang:  'en'                  (language this doc represents)
//   meta.route: '/en/about'           (deployed URL)
//
// Anything missing `meta.href` is excluded from the index.

/**
 * @param {Array<{meta?: object}>} documents  Catalog documents with meta.
 * @param {Object} [options]
 * @param {string} [options.defaultLang='default']  Fallback language tag
 *        for documents that don't declare meta.lang. The literal string
 *        `'default'` is treated as a fallback bucket in lookups.
 * @returns {{
 *   href: (ref: string, lang?: string) => string,
 *   refFor: (url: string|null) => string|null,
 *   alternates: (opts: { route: string|null, languages?: string[] }) => { current: {lang, url, ref}|null, alternates: Array<{lang, url}> },
 *   map: Record<string, Record<string, string>>,
 * }}
 */
export function createHrefIndex(documents, { defaultLang = 'default' } = {}) {
    const map = {}
    if (Array.isArray(documents)) {
        for (const document of documents) {
            const ref = document?.meta?.href
            if (!ref) continue
            const lang = document.meta?.lang ?? defaultLang
            const url  = document.meta?.route ?? document.meta?.destination ?? ref
            if (!map[ref]) map[ref] = {}
            map[ref][lang] = url
        }
    }

    /**
     * Resolve a logical reference to a deployed URL.
     *
     * Fallback chain: requested lang → `'default'` bucket → any
     * available language → the input reference unchanged (so broken
     * references stay visible rather than silently becoming undefined).
     */
    function href(ref, lang) {
        const target = lang ?? defaultLang
        const entry = map[ref]
        if (!entry) return ref
        return entry[target]
            ?? entry['default']
            ?? Object.values(entry)[0]
            ?? ref
    }

    /**
     * Reverse lookup — given a deployed URL, return the logical
     * reference it belongs to (or null if it's not in the index).
     */
    function refFor(url) {
        if (url == null) return null
        for (const [ref, byLang] of Object.entries(map)) {
            if (Object.values(byLang).includes(url)) return ref
        }
        return null
    }

    /**
     * Alternates for a deployed URL — useful for hreflang tags and
     * language switchers.
     *
     * `languages` controls the alternate set:
     *   - omitted: only return languages that actually exist in the
     *     catalog for this ref. Right shape for hreflang (don't
     *     advertise translations that don't exist).
     *   - provided as an array: return one entry per requested
     *     language, using href()'s fallback chain when a translation
     *     doesn't exist. Right shape for language switchers (show
     *     every locale the app supports).
     *
     * The current page's own language is excluded from `alternates` —
     * it's what `current` is for. Callers that want it included can
     * prepend `current` themselves.
     */
    function alternates({ route, languages } = {}) {
        if (route == null) return { current: null, alternates: [] }
        const ref = refFor(route)
        if (ref == null) return { current: null, alternates: [] }
        const entry = map[ref] ?? {}
        const currentLang = Object.entries(entry).find(([, url]) => url === route)?.[0] ?? null
        const current = { lang: currentLang, url: route, ref }

        let list
        if (Array.isArray(languages)) {
            list = languages
                .filter(lang => lang !== currentLang)
                .map(lang => ({ lang, url: href(ref, lang) }))
        } else {
            list = Object.entries(entry)
                .filter(([lang]) => lang !== currentLang && lang !== 'default')
                .map(([lang, url]) => ({ lang, url }))
        }
        return { current, alternates: list }
    }

    return { href, refFor, alternates, map }
}
