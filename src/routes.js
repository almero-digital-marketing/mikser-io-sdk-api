// Build-time route enumeration. Given a mikser entities client and a
// mapRoute function, return the array of route descriptors produced by
// applying `mapRoute` to every catalog entity that matches the filter.
//
// Auto-paginates via the client's listAll() under the hood — no manual
// limit, no silent truncation on large catalogs.
//
// Framework-agnostic: the `mapRoute` return shape is whatever your build
// pipeline expects (vite-ssg routes, Next pages, SvelteKit entries, etc.).
// Framework SDKs re-export this with their own typed mapRoute signatures.

const DEFAULT_FILTER = { 'meta.published': true, 'meta.route': { $exists: true } }

/**
 * @param {Object} options
 * @param {Object} options.client    A mikser entities client (the result of
 *                                   createClient(...).entities(name)).
 * @param {Object} [options.filter]  Sift filter — defaults to "published
 *                                   documents that declare meta.route".
 * @param {Function} options.mapRoute  (document) => routeDescriptor | null.
 *                                   Null returns are dropped.
 * @returns {Promise<Array>} The mapped route descriptors.
 */
export async function generateMikserRoutes({
    client,
    filter = DEFAULT_FILTER,
    mapRoute,
} = {}) {
    if (!client)   throw new Error('generateMikserRoutes: { client } is required')
    if (!mapRoute) throw new Error('generateMikserRoutes: { mapRoute } is required')

    const items = await client.listAll({ filter, fields: ['id', 'meta'] })
    return items.map(mapRoute).filter(r => r != null)
}
