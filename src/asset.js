// Asset metadata index — pure data version. Framework SDKs wrap this
// in their own reactivity primitives and expose useAsset on top.
//
// When assets carry metadata the template needs (dimensions, srcset,
// alt text), looking them up by reference is cleaner than re-fetching
// per render. The convention is that asset entities have an `id`
// (used as the reference key) plus a `meta` block with the metadata.

/**
 * @param {Array<{id: string, meta?: object}>} assets  Asset entities.
 * @returns {{
 *   asset: (ref: string) => AssetRecord|null,
 *   image: (ref: string) => ImageProps|null,
 *   map: Record<string, AssetRecord>,
 * }}
 *
 * @typedef {Object} AssetRecord
 * @property {string} url
 * @property {number|undefined} width
 * @property {number|undefined} height
 * @property {string|undefined} srcset
 * @property {string|undefined} alt
 * @property {object|undefined} meta   The raw meta block, for downstream use.
 *
 * @typedef {Object} ImageProps
 * @property {string} src
 * @property {number|undefined} width
 * @property {number|undefined} height
 * @property {string|undefined} srcset
 * @property {string|undefined} alt
 */
export function createAssetIndex(assets) {
    const map = {}
    if (Array.isArray(assets)) {
        for (const a of assets) {
            if (!a?.id) continue
            map[a.id] = {
                url:    a.meta?.destination ?? a.meta?.url ?? a.id,
                width:  a.meta?.width,
                height: a.meta?.height,
                srcset: a.meta?.srcset,
                alt:    a.meta?.alt,
                meta:   a.meta,
            }
        }
    }

    function asset(ref) {
        return map[ref] ?? null
    }

    function image(ref) {
        const a = map[ref]
        if (!a) return null
        return {
            src:    a.url,
            width:  a.width,
            height: a.height,
            srcset: a.srcset,
            alt:    a.alt,
        }
    }

    return { asset, image, map }
}
