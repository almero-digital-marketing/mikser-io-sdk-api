// Asset URLs + metadata — format-neutral. mikser's assets() plugin is a
// preset transcoder (video, image, pdf, audio, …), not an image pipeline,
// so neither is this: it models a (source, preset) → derivative-URL
// convention plus an opaque metadata lookup. Image-specific concerns
// (srcset, dimensions, <img> props) are a consumer concern — build them
// on top of `meta` where you actually know an asset is an image.
import { joinUrl } from './url.js'

/**
 * URL of a transcoded derivative, by the assets() plugin convention:
 *
 *   <baseUrl>/assets/<preset>/<source>
 *
 * `source` is the source ref, e.g. `/media/bg/clip.mp4`. `ext`, when
 * given, is the preset's output format and REPLACES the source extension
 * (a poster preset turns .mp4 → .jpg); omit it to keep the source ext.
 * `baseUrl` is optional — omit for a same-origin, root-relative URL.
 *
 * @param {string} source
 * @param {string} preset
 * @param {{ baseUrl?: string, ext?: string }} [options]
 * @returns {string}
 */
export function assetUrl(source, preset, { baseUrl = '', ext } = {}) {
    if (!source || !preset) return ''
    const file = ext ? source.replace(/\.[^./]+$/, `.${ext}`) : source
    const path = `/assets/${preset}/${file.replace(/^\/+/, '')}`
    return baseUrl ? joinUrl(baseUrl, path) : path
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
