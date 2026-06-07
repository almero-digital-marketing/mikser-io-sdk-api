// paginate — pure-function helper that chunks a list of items into
// pages and returns a shape ready to consume from a mikser layout
// sidecar's load() function.
//
// Mikser's layout pagination protocol: a sidecar that returns
// `{ pages: N, ... }` from load() causes the layouts plugin to clone
// the entity once per page (setting entity.page and entity.pages on
// each clone). The same returned data object is shared across all
// page renders — the template uses entity.page to pick its slice.
//
// This helper packages the chunking + URL computation in one call so
// every paginated index in a mikser project doesn't have to re-write
// the same five lines of arithmetic.
//
// Example use, in layouts/index.js:
//
//   import { paginate } from 'mikser-io-sdk-api'
//
//   export async function load({ findEntities }) {
//       const posts = (await findEntities())
//           .filter(e => e.meta?.layout === 'post')
//           .sort((a, b) => new Date(b.meta?.date) - new Date(a.meta?.date))
//
//       return paginate(posts, { key: 'posts', pageSize: 6 })
//   }
//
// And in layouts/index.hbs:
//
//   {{#each (lookup data.posts (subtract entity.page 1))}}
//       <li>{{this.meta.title}}</li>
//   {{/each}}
//
//   {{#each data.pageNumbers}}
//       <a href="{{this.url}}">{{this.num}}</a>
//   {{/each}}

/**
 * Chunk an array into pages for mikser's layout pagination.
 *
 * @template T
 * @param {T[]} items - Items to paginate. Already sorted/filtered.
 * @param {Object} [options]
 * @param {string} [options.key='items'] - Output key under which the
 *     pre-sliced pages array is returned. Use 'posts', 'products',
 *     'photos', etc. so the template's variable name matches the
 *     content domain.
 * @param {number} [options.pageSize=10] - Items per page. Must be > 0.
 * @param {(page: number) => string} [options.urlFor] - Builds the
 *     href for each page number. Defaults to the mikser convention
 *     where page 1 lives at '/' and page N at '/<N>/'.
 * @returns {{
 *     [k: string]: T[][],
 *     pages:        number,
 *     pageSize:     number,
 *     pageNumbers:  { num: number, url: string }[],
 *     totalItems:   number,
 * }} A shape compatible with mikser's layout pagination protocol.
 *    `data[key][entity.page - 1]` gives the current page's items.
 */
export function paginate(items, options = {}) {
    const {
        key      = 'items',
        pageSize = 10,
        urlFor   = (p) => p === 1 ? '/' : `/${p}/`,
    } = options

    if (!Number.isInteger(pageSize) || pageSize < 1) {
        throw new TypeError(`paginate: pageSize must be a positive integer (got ${pageSize})`)
    }
    if (!Array.isArray(items)) {
        throw new TypeError(`paginate: items must be an array (got ${typeof items})`)
    }

    const totalItems = items.length
    // Always at least one page, even when items is empty — the
    // layout still wants to render an "empty list" page rather than
    // disappear from the sitemap entirely.
    const pages = Math.max(1, Math.ceil(totalItems / pageSize))

    const paged = []
    for (let p = 0; p < pages; p++) {
        paged.push(items.slice(p * pageSize, (p + 1) * pageSize))
    }

    const pageNumbers = []
    for (let p = 1; p <= pages; p++) {
        pageNumbers.push({ num: p, url: urlFor(p) })
    }

    return {
        [key]:       paged,
        pages,
        pageSize,
        pageNumbers,
        totalItems,
    }
}
