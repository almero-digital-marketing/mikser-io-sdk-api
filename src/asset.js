// Asset URLs + metadata — format-neutral. mikser's assets() plugin is a
// preset transcoder (video, image, pdf, audio, …), not an image pipeline,
// so neither is this: it models a (source, preset) → derivative-URL
// convention plus an opaque metadata lookup. Image-specific concerns
// (srcset, dimensions, <img> props) are a consumer concern — build them
// on top of `meta` where you actually know an asset is an image.
import { joinUrl } from './url.js'

/**
 * Join a deployed, base-relative served path to the client base (ADR-0011).
 *
 * The catalog already carries the path — `meta.url` for a file, or
 * `meta.presets.<name>` for a transcoded derivative (the assets() plugin
 * stamps them). The SDK no longer *constructs* `/assets/<preset>/<source>`
 * client-side; it only prefixes the base. One rule for every served
 * reference, files and derivatives alike:
 *
 *   url(product.image.meta.url)             // <base>/img/products/X.jpg
 *   url(product.video.meta.presets.poster)  // <base>/assets/poster/…X.jpg
 *
 * `baseUrl` empty → same-origin, root-relative. An already-absolute ref
 * (a render baked the origin in) passes through untouched.
 *
 * @param {string} ref  A base-relative served path, e.g. `/img/x.jpg`.
 * @param {{ baseUrl?: string }} [options]
 * @returns {string}
 */
export function deployedUrl(ref, { baseUrl = '' } = {}) {
    if (!ref) return ''
    if (/^https?:\/\//i.test(ref)) return ref
    return baseUrl ? joinUrl(baseUrl, ref) : ref
}

/**
 * Dev-mode safety net (ADR-0011 Part E). Warns when an `<img>` / `<video>`
 * failed to load — the signature of a served-file URL that hit the app
 * origin and got the SPA's HTML fallback (`text/html` can't decode as an
 * image → an `error` event), i.e. a missing base prefix or an unexpanded
 * served-entity reference. Capture phase, because media `error` events
 * don't bubble. Returns a teardown function; no-op outside a browser.
 *
 *   if (import.meta.env.DEV) watchAssetFallbacks()
 */
export function watchAssetFallbacks({ doc = globalThis.document, warn = console.warn } = {}) {
    if (!doc || typeof doc.addEventListener !== 'function') return () => {}
    function onError(event) {
        const el = event.target
        if (!el || (el.tagName !== 'IMG' && el.tagName !== 'VIDEO')) return
        const src = el.currentSrc || el.src || el.poster
        if (!src) return
        warn(
            `[mikser] asset failed to load: ${src}\n` +
            `  Did it resolve to the SPA fallback (text/html)? Likely a missing ` +
            `base prefix (use url(ref)) or an unexpanded served-entity reference (ADR-0011).`,
        )
    }
    doc.addEventListener('error', onError, true)
    return () => doc.removeEventListener('error', onError, true)
}

/**
 * Format-neutral lookup for managed asset entities that carry their own
 * URL/metadata. `asset(ref)` → `{ url, meta }` | null, keyed by entity
 * `id`. `meta` is the entity's raw meta block, opaque — mime, dimensions,
 * duration, whatever the preset emitted. No image semantics: a consumer
 * that knows an asset is an image reads `meta.width`/`meta.srcset` itself.
 *
 * @param {Array<{id: string, meta?: object}>} assets
 * @returns {{ asset: (ref: string) => ({url: string, meta?: object}|null), map: Record<string, {url: string, meta?: object}> }}
 */
export function createAssetIndex(assets) {
    const map = {}
    if (Array.isArray(assets)) {
        for (const a of assets) {
            if (!a?.id) continue
            map[a.id] = { url: a.meta?.destination ?? a.meta?.url ?? a.id, meta: a.meta }
        }
    }
    return {
        asset: (ref) => map[ref] ?? null,
        map,
    }
}
