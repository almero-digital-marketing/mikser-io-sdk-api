# mikser-io-sdk-api

Client SDK for querying a [mikser-io](https://github.com/almero-digital-marketing/mikser-io) server's `api` plugin from the browser or Node — list / query / paginate / project the document catalog, subscribe to live changes, and trigger renders.

Mikser keeps content as plain files. This SDK lets the frontend ask for exactly the slice it needs over HTTP — Mongo-style filter operators, sort, projection, pagination — without shipping the whole catalog and filtering in JS.

For semantic search against the `vector` plugin, install [mikser-io-sdk-vector](https://github.com/almero-digital-marketing/mikser-io-sdk-vector) — it ships as a separate package.

Zero dependencies. Runs anywhere `fetch` is available (modern browsers, Node 18+, Deno, Bun, Workers).

> **Using Vue, React, or Svelte?** You probably want one of the framework SDKs — they wrap this package in framework-idiomatic primitives (`useDocument` / `useDocuments`, multilingual `useHref`, live SSE-driven updates) so you don't write a watch loop or lifecycle plumbing yourself:
>
> - [`mikser-io-sdk-vue`](https://github.com/almero-digital-marketing/mikser-io-sdk-vue) — Vue 3 composables + vue-router integration
> - [`mikser-io-sdk-react`](https://github.com/almero-digital-marketing/mikser-io-sdk-react) — React 18+ / 19+ hooks + React Router v6+
> - [`mikser-io-sdk-svelte`](https://github.com/almero-digital-marketing/mikser-io-sdk-svelte) — Svelte 5 (runes) + SvelteKit
>
> Use **this** package directly when you're writing a custom adapter for another framework (Solid, Qwik, vanilla JS, server-side Node) or when you need the lower-level surface (`list`, `urlFor`, `watch`, `render`).

## Install

```bash
npm install mikser-io-sdk-api
```

## Quick start

```js
import { createClient } from 'mikser-io-sdk-api'

const mikser = createClient({ baseUrl: 'http://localhost:3001' })
const docs = mikser.entities('public')

const { items, total, hasNext } = await docs.list({
    filter: {
        'meta.published': true,
        'meta.price': { $gt: 20, $lt: 80 },
    },
    sort:   { 'meta.date': -1 },
    fields: ['id', 'meta.title', 'meta.price'],
    limit:  10,
})
```

## Wiring it together

The contract has three pieces: server config, an endpoint URL, an SDK call. Each maps 1:1 — if you can read the server's `api.endpoints` block, you know exactly what the SDK can do.

**On the server** — `mikser.config.js` declares named endpoints. Each endpoint becomes a URL path; its options control what's visible, what operations are allowed, and whether a token is required.

```js
// mikser.config.js — on the server
export default {
    plugins: ['documents', 'layouts', 'render-hbs', 'api'],

    api: {
        endpoints: {
            // Public reader — anyone can list published docs, no token.
            // `subscribe` is opt-in for public endpoints (each connection
            // holds resources), so list it explicitly here.
            public: {
                query: e => e.type === 'document' && e.meta?.published,
                operations: ['list', 'subscribe'],
            },

            // Editor — token-gated, full surface. Defaults already
            // include list/update/delete/render/subscribe when token
            // is set, so the operations array can be omitted.
            editor: {
                token: process.env.EDITOR_TOKEN,
            },
        },
    },
}
```

**On the client** — one `createClient` per app, then one `entities(name)` per endpoint:

```js
import { createClient } from 'mikser-io-sdk-api'

const mikser = createClient({ baseUrl: 'https://cms.example.com' })

// Reads public docs only (server's `query` scope hides drafts)
const docs = mikser.entities('public')

// Token-gated — can write + render, in addition to read + subscribe
const editor = mikser.entities('editor', { token: process.env.EDITOR_TOKEN })
```

The mapping is direct:

| Server (`mikser.config.js`)         | Client (SDK)                              |
|---|---|
| `api.endpoints.public`              | `mikser.entities('public')`               |
| `api.endpoints.editor.token`        | `mikser.entities('editor', { token })`    |
| `query: e => …`                     | invisible — applied server-side as outer scope |
| `operations: ['list']`              | only `.list()` / `.query()` / `.urlFor()` / `.pages()` succeed |
| `operations: [..., 'subscribe']`    | `.watch()` works                          |
| `operations: [..., 'update', 'delete']` | `.update()` / `.delete()` work        |
| `operations: [..., 'render']`       | `.render()` works                         |

Operations outside the endpoint's allowlist return `403`; missing or wrong tokens return `401` (both thrown as `MikserError`). The server is always the boundary — the SDK is just the typed shape of what the boundary lets through.

## Entities

`mikser.entities(endpointName, options)` returns a per-endpoint client. The endpoint name matches a key in your `api.endpoints` config on the server. Supported options:

| Option   | Default | What it does                                                              |
|---|---|---|
| `token`  | `null`  | Bearer token for endpoints declared with a token. Sent on every request.  |
| `data`   | `{}`    | Pairs the client with the mikser-io `data` plugin's static-file outputs. See below. |

### `data` — pair with the `data` plugin for fast first paint

If you have a known, predictable query that runs on every page load — a route table for an SPA, a navigation menu, a per-document body — paying an API round-trip for it on first paint is wasted work. The mikser-io `data` plugin lets you publish that data as static files at build/finalize time, and the SDK consumes them on the client side. The option names on both sides are the same — `catalog` and `entities` — so it reads as one config split across the network.

Mikser's `data` plugin has two relevant blocks:

```js
// mikser.config.js
data: {
    catalog: {
        // out/data/sitemap.json — one combined file for the whole catalog,
        // projected to just the fields your router/nav needs.
        sitemap: {
            query: e => e.type === 'document' && e.meta?.published && e.meta?.component,
            pick: ['id', 'destination', 'meta.component', 'meta.route', 'meta.title'],
        },
    },
    entities: {
        // out/data/<entity.name>.page.json — one file per published document,
        // with full content. Consumed by useDocument(id) for first-paint
        // single-doc reads.
        page: {
            query: e => e.type === 'document' && e.meta?.published,
            pick: ['id', 'meta', 'content'],
        },
    },
},

api: {
    endpoints: {
        public: {
            query: e => e.type === 'document' && e.meta?.published,
            operations: ['list', 'subscribe'],
            cache: true,
        },
    },
},
```

On the client, name the same blocks. The names you pass match the keys you used on the server side:

```js
const documents = createClient({ baseUrl: 'https://cms.example.com' })
    .entities('public', {
        data: {
            catalog:  'sitemap',   // /data/sitemap.json
            entities: 'page',      // /data/<entry.name>.page.json
        },
    })
```

What gets used when:

- **`live({id})` / `useDocument(id)`** — if `data.entities` is set, the SDK fetches the matching per-entity file instead of calling the API. Needs `data.catalog` to be loaded too, so the entry's `name` is known. The SSE subscribe still opens for live updates.
- **`live(filter, onChange, options)` with no filter** / **`listAll()`** — if `data.catalog` is set, the SDK consults `/data/<catalog>.json` for first paint, then opens SSE.
- **`list()`**, **`urlFor()`**, **`query()`**, **`update()`**, **`delete()`**, **`render()`**, **`subscribe()`** — unchanged, always hit the API.
- **Any file fetch failure** — falls back to the live API for that call. No separate flag.

The data plugin emits each entry as `{ refId, name, date, data: {...picked} }`. The SDK strips that wrapper automatically — `onChange` and `listAll` always see plain payloads regardless of source.

This is **not** a cache. The data plugin's files are only consulted for the initial fill; ongoing changes come over SSE on the actual API endpoint. For runtime fail-safety on the live API, that's what the api plugin's `cache: true` is for — see [mikser-io's caching docs](https://github.com/almero-digital-marketing/mikser-io/blob/main/documentation/caching.md).

**Edge case: first-paint flash for fast-changing snapshots.** First paint renders whatever the data plugin last wrote — which may be N seconds old — and the SSE stream then arrives and reconciles any changes since. For a route table that's invisible; routes don't move every second. For snapshots of fast-changing data (recent activity, in-stock badges, live counters) the user may briefly see stale content before SSE catches up. If that flash is visible UX, either design for it (subtle "syncing" indicator until the first SSE event arrives, or render a loading state when the snapshot age exceeds your tolerance) or skip `data.catalog` / `data.entities` for that particular client — paying the API roundtrip is the right tradeoff when the response can't be allowed to be stale.

**Snapshot-bypass warning.** Snapshots only apply when the `live()` / `listAll()` call is trivial — no filter, no sort, no skip. Add any of those and the SDK silently falls back to the live API. Since that's the kind of thing a developer can change without noticing, the SDK emits a one-time `console.warn` per `(endpoint, call kind, what-was-set)` shape:

```
[mikser-sdk] data.catalog is set on "public" but this live() call uses filter+sort
  — snapshot bypassed, falling back to live list().
  Snapshots only apply when the call is trivial (no filter/sort/skip).
  Either remove the filter+sort from this call, or accept the API roundtrip if
  filtering is intentional.
  Suppress: pass { quiet: true } on the call, or set MIKSER_QUIET=1.
```

Same suppression channels as the wide-list warning above.

### Dev-mode warning: accidentally wide queries

The common failure mode for a CMS-backed app is "I just wanted a nav menu but pulled every full document over the wire." To catch it at write time, `list()` and `live()` emit a one-time dev-mode `console.warn` when a response has more than 50 items and the query has no `fields:` projection:

```
[mikser-sdk] list() returned 247 items (~4.2 MB) from "public" with no `fields` projection.
  Add { fields: [...] } to narrow it, or — if this query runs on every page load —
  move it to a `data.catalog.<name>` snapshot on the mikser side and load via:
    entities('public', { data: { catalog: '<name>' } })
  Suppress: pass { quiet: true } on the call, or set MIKSER_QUIET=1.
```

The warning is deduped per `(endpoint, filter, sort)` shape, so an SSE-driven list that updates 30 times only fires once. It's silenced when `process.env.NODE_ENV === 'production'`, when `MIKSER_QUIET` is set, or per-call via `{ quiet: true }` on `list(query, opts)` / `live(filter, onChange, opts)`.

The mikser-io server emits a matching warning in its logs for the same shape — useful when the wide query came from curl, another SDK, or an environment where `console` isn't visible.

### `list(query)` — body-based

POSTs `/api/<endpoint>/entities/query` so any sift filter works (incl. `$and`, `$or`, regex).

```js
const { items } = await docs.list({
    filter: {
        $or: [
            { 'meta.tags': { $in: ['product'] } },
            { type: 'category' },
        ],
        'meta.date': { $gte: '2025-01-01' },
    },
    sort:   { 'meta.date': -1, 'meta.title': 1 },
    fields: ['id', 'meta.title', 'meta.summary'],
    page:   1,
    limit:  20,
})
```

Response envelope: `{ items, page, limit, total, totalPages, hasNext, hasPrev }`.

Use dotted-path keys for nested fields (`'meta.price': { $gt: 20 }`). Nested object literals (`{ meta: { price: { $gt: 20 } } }`) are interpreted as deep-equality — same gotcha as Mongo.

### `expand` — inline-resolve referenced entities in one trip

Mikser entities can carry references to other entities via `$`-prefixed front-matter keys ([ADR-0007](https://github.com/almero-digital-marketing/mikser-io/blob/main/documentation/decisions/0007-references-declaration-and-expansion.md)). On the wire, the SDK projects them back to plain names — so a document with `$author: /authors/dick` in YAML shows up as `meta.author = '/authors/dick'` in the response. **Always**: every response has `$`-keys stripped, regardless of whether you asked for expansion. The convention is engine-side; the wire shape is clean.

Pass `expand: [...]` to inline the resolved entity in place of the ref string — multi-hop graph fetches collapse to one round-trip.

```js
// Source on the server:
//   ---
//   layout: article
//   title: Launch
//   $author:  /authors/dick
//   $hero:    /images/launch-hero
//   $related: ['/blog/follow-up', '/blog/changelog']
//   ---

// Without expand — refs come back as strings (normalized form: no $).
const { items } = await docs.list({ filter: { id: '/blog/launch.md' } })
items[0].meta.author    // '/authors/dick'          — string
items[0].meta.hero      // '/images/launch-hero'    — string
items[0].meta.related   // ['/blog/follow-up', '/blog/changelog']

// With expand — refs come back as full entity objects.
const { items: hydrated } = await docs.list({
    filter: { id: '/blog/launch.md' },
    expand: ['author', 'hero'],
})
hydrated[0].meta.author.meta.name   // 'Dick Marinov'
hydrated[0].meta.hero.meta.alt      // 'Launch screen hero'
```

**Multi-hop chains** — dot-notation walks through expanded entities:

```js
const { items } = await docs.list({
    filter: { id: '/blog/launch.md' },
    expand: ['author.organization'],
})
items[0].meta.author.meta.organization.meta.name   // 'Almero Digital'
```

Each segment in the path that lands on a `$`-keyed field gets expanded. The path also expands every intermediate hop — `expand: ['author.organization']` expands `$author` AND walks into the resolved author's `$organization`.

**Array iteration with `*`** — for sections, related lists, or any `$`-keyed array:

```js
// $related: ['/blog/follow-up', '/blog/changelog']
expand: ['related']
// → meta.related[0] and meta.related[1] are full entity objects

// Mixed nesting + iteration — landing page with section blocks:
//   sections:
//     - { type: hero,     $image: /images/hero }
//     - { type: features, $image: /images/feat-a }
expand: ['sections.*.image']
// → each section's $image becomes the resolved image entity
```

**Multiple paths in one call**:

```js
const { items } = await docs.list({
    filter: { id: '/landing.md' },
    expand: [
        'hero',
        'sections.*.image',
        'sections.*.cta.target',
        'author.organization',
    ],
})
```

**Path forms** — the SDK accepts both `'author'` (normalized) and `'$author'` (canonical) and forwards either to the api, which accepts both. Use whichever feels natural at the call site; they're equivalent.

**Server-side caps** — exceeding any cap returns a `MikserError` with `status === 422`:

| Cap | Default | Configured at | What triggers it |
|---|---|---|---|
| `maxDepth` | 5 | `api.expand.maxDepth` | One path is longer than this (`a.b.c.d.e.f` at default) |
| `maxPaths` | 20 | `api.expand.maxPaths` | The `expand` array has more entries than this |
| `maxResolved` | 100 | `api.expand.maxResolved` | Total entity lookups for the request (across all paths) exceeded |

```js
try {
    await docs.list({ filter: {...}, expand: tooManyPaths })
} catch (err) {
    if (err.status === 422) { /* tighten the expand spec */ }
}
```

**Missing targets and cycles are silently left as strings.** If `$author: /authors/missing` doesn't resolve, the response carries `meta.author === '/authors/missing'` — a string at the position you asked to expand. Same shape for cycle breaks. Per ADR-0007 B6 this is by design: the response shape stays consistent, and "string where we asked for an object" is the unambiguous signal that resolution stopped there.

**Transport**: same GET-first strategy as the rest of `list()` — `expand` is serialized as a comma-separated URL param when the request fits in the URL, falls back to POST body otherwise. CDN caching works the same way on either form; the `expand` value is part of the cache key.

### `urlFor(query)` — GET-form URL

Build a URL for the GET form of the same query. Useful when the response should be CDN-cacheable, or you want a sharable link.

```js
const url = docs.urlFor({
    filter: { 'meta.published': true, 'meta.price': { $gt: 20 } },
    sort:   { 'meta.date': -1 },
    expand: ['author', 'hero'],
    limit:  10,
})
// http://localhost:3001/api/public/entities?
//   meta.published=true&meta.price.$gt=20&sort=-meta.date&expand=author,hero&limit=10
```

`expand` is serialized as a comma-separated value so the URL is a stable cache key — same response for the same URL across requests and CDN nodes.

### `cacheKeyFor(query)` — the nginx fast-path hint

The api plugin caches GET responses to disk under a filename derived from the query. Both server and SDK hash the same query the same way, so `list()` appends `&cache=<hash>` to its GET URL automatically — nginx can then serve cached files via `try_files` without computing the hash itself (no Lua, no rewrite module). See the [api plugin's caching docs](https://github.com/almero-digital-marketing/mikser-io/blob/main/documentation/caching.md) for the full nginx config.

```js
const query = {
    filter: { 'meta.published': true },
    expand: ['author'],
    limit:  10,
}
const key = await docs.cacheKeyFor(query)
// '4f3a2c1d8e9b6f7a'  (16 hex chars; same value the server uses on disk)

// Compose a cacheable URL by hand (rare — list() does this automatically).
// urlFor() guarantees a `?` because the query has params; for the empty-
// query case `cacheKeyFor()` returns `'index'` and you'd skip appending
// `cache` (the server stores empty-query responses as `index.json`).
const url = docs.urlFor(query) + '&cache=' + key
```

Returns `'index'` for empty queries — the server stores that case under `index.json`, the conventional default-snapshot name a `try_files` directive falls through to. The server strips the `cache` param before computing its own hash, so a wrong/stale client value just causes a cache miss in nginx (graceful fallback to mikser); no poisoning is possible because the server is always the source of truth for filename choice.

### `pages(query)` — async iterator

```js
for await (const env of docs.pages({ filter: { type: 'document' }, limit: 50 })) {
    for (const item of env.items) {
        process(item)
    }
}
```

`pages()` and `listAll()` both accept `expand` in the query — the parameter applies to every page in the iteration. For sitemap-style enumeration with one-hop hydration (`expand: ['author']`), this keeps the build to one round-trip per page rather than N per entity.

### `paginator(options)` — stateful client-side paginator

Wraps `list()` with page-at-a-time state. Each navigation call (`goTo` / `next` / `prev`) fetches exactly **one page** from the server — no upfront load of the full collection. Right for UI navigation; use `pages()` or `listAll()` for SSG sitemap enumeration that needs every page.

```js
const docs = client.entities('public')

const paginator = docs.paginator({
    filter:   { 'meta.layout': 'post' },
    sort:     { 'meta.date': -1 },
    pageSize: 10,
})

await paginator.goTo(1)         // one HTTP request → first 10 items
paginator.items                  // those 10 items
paginator.page                   // 1
paginator.pages                  // total page count (server-computed)
paginator.totalItems             // total item count
paginator.hasNext, hasPrev
paginator.pageNumbers            // [{ num, url, isCurrent }, ...]

await paginator.next()           // one HTTP request → items 11..20
await paginator.goTo(5)          // one HTTP request → items 41..50
```

State accessors are getters — the value you read is always the result of the last completed fetch. Wrap in your framework's reactive primitive (React's `useState`, Vue's `ref`, Svelte stores) to re-render when navigation completes.

Options:
- `filter`, `sort`, `fields`, `expand` — same shape as `list()`. Applied on every page fetch.
- `pageSize` (default `10`) — items per page. Positive integer.
- `urlFor` (default `(p) => p === 1 ? '/' : '/<p>/'`) — build per-page hrefs for the `pageNumbers` array. Override for SPA hash routing (`(p) => '#/page/' + p`) or query-param style (`(p) => '?page=' + p`).

Errors thrown by `next()` at the last page, `prev()` at the first page, and `goTo()` on an invalid page number — so a UI layer can disable nav controls based on `hasNext` / `hasPrev` rather than catch.

#### vs. `list()` directly

| Use | Pattern |
|---|---|
| One-shot fetch of a specific page | `await docs.list({ filter, page: 3, limit: 10 })` |
| Stateful UI navigation | `const p = docs.paginator({ ... }); await p.next()` |
| Server enumeration (SSG, indexing) | `for await (const env of docs.pages({ filter }))` |
| Live-updating feed | `docs.live(filter, onChange)` |

`paginator` is sugar over `list` for the most common UI pattern — keeps the "current page" out of your component state.

### `watch(query, { signal })` — live subscription via SSE

Open a Server-Sent Events stream and yield events as matching entities change. The lowest-level real-time primitive — useful when you want raw events.

```js
const ac = new AbortController()

// Initial state
const { items } = await docs.list({ filter: { 'meta.published': true } })
items.forEach(addToView)

// Forward updates
for await (const event of docs.watch(
    { filter: { 'meta.published': true } },
    { signal: ac.signal },
)) {
    switch (event.type) {
        case 'create':    addToView(event.entity); break
        case 'update': updateInView(event.entity); break
        case 'delete': removeFromView(event.id); break
    }
}

// Call ac.abort() to close the stream.
```

Events fire on **every** server process cycle — both file-watcher–driven changes (the editor saving a file, decap committing) and programmatic writes (`update()` / `delete()` via this SDK). No second mechanism to wire up.

Requires the endpoint to include `subscribe` in its `operations`. Public endpoints don't get it by default (each connection holds resources); token-gated endpoints do.

For framework integration, prefer `live()` below — it handles the list+watch composition with race-safe cleanup.

### `live(filter, onChange, options)` — list + watch in one callback

The higher-level real-time primitive. Calls `onChange(items)` with the initial snapshot, then again with the patched array on every create/update/delete event. Returns a dispose function.

```js
const dispose = docs.live(
    { 'meta.published': true, type: 'document' },
    items => setItems(items),
    {
        sort:    { 'meta.date': -1 },
        fields:  ['id', 'meta.title', 'meta.date', 'meta.summary'],
        expand:  ['author', 'hero'],         // hydrate refs on the initial snapshot
        limit:   20,
        signal:  abortController?.signal,    // optional external abort
        onError: err => console.error(err),  // optional error sink
    },
)

// Later:
dispose()
```

**`expand` and SSE deltas.** When passed in `options`, `expand` is applied to the *initial* snapshot. The SSE delta stream that follows emits raw entities — a `create` or `update` event replaces the previously-expanded item with the unexpanded shape until the next refetch. If you need always-expanded items through live updates, call `list({ ..., expand })` on the cadence you care about instead, or wait for server-side expand-on-subscribe (not shipped yet — track ADR-0007 follow-ups).

Equivalent to:

```js
// 1. await list({ filter, sort, fields, limit, skip })
// 2. onChange(items)
// 3. for await (event of watch({ filter })) patch + onChange
// 4. abort on dispose
```

…but with race-safe cleanup (no `mounted` flag needed in caller code), unified error routing via `onError`, and a single dispose path. This is the building block the [framework SDKs](#framework-integration) (Vue / React / Svelte) consume internally — and the surface to use directly if you're writing a custom adapter.

`live()` keeps an internal `items` array, patches it on each event, and hands the whole array to `onChange` every time. That's the simplest contract for frameworks with state-replace semantics (the callback just overwrites state). If you need per-event deltas — animated reveals, audit logs, derived counters — use `watch()` directly.

### `update(payload)` / `delete(payload)` — writes

Requires a token-gated endpoint with `operations: ['update', 'delete', ...]`.

```js
const admin = mikser.entities('admin', { token: process.env.ADMIN_TOKEN })

await admin.update({
    collection:   'documents',
    relativePath: 'blog/new-post.md',
    content:      '---\ntitle: Hello\n---\n\nHello world.',
})

await admin.delete({
    collection:   'documents',
    relativePath: 'blog/old-post.md',
})
```

### `render(entity, options)` — render in memory

```js
const html = await admin.render(
    { id: '/documents/blog/preview.md', collection: 'documents', type: 'document',
      format: 'md', meta: { title: 'Preview', layout: 'post' }, content: '# Preview' },
    { save: false, catalog: false },
)
```

Return shape follows the response `content-type`:
- `application/json` → parsed JSON
- `text/*` → `string`
- anything else (`application/pdf`, images, …) → `ArrayBuffer`

## Recipes — composing real-time and search

The methods above are the building blocks. The interesting work is gluing them together — `list()` for an initial snapshot, `watch()` to keep it fresh, and `findSimilar()` (from [`mikser-io-sdk-vector`](https://github.com/almero-digital-marketing/mikser-io-sdk-vector)) when the user is searching by meaning rather than fields.

### Live article index for a marketing site

The home page shows the latest published articles. When an editor publishes a new one through Decap (or anything that writes to the documents folder), it should appear without a refresh; edits update in place; deletions disappear. The same `filter` drives both the initial fetch and the live subscription, so the two stay in sync.

```js
import { createClient } from 'mikser-io-sdk-api'

const docs = createClient({ baseUrl: 'https://cms.example.com' })
    .entities('public')

// One filter expression, used for both list() and watch() — keeps the
// "what counts as visible" decision in one place.
const filter = {
    type: 'document',
    'meta.collection': 'articles',
    'meta.published':  true,
}

const list = document.getElementById('article-list')
const byId = new Map() // id → DOM element

function render(entity) {
    const el = document.createElement('article')
    el.dataset.id   = entity.id
    el.dataset.date = entity.meta.date
    el.innerHTML = `
        <h2>${entity.meta.title}</h2>
        <time>${entity.meta.date}</time>
        <p>${entity.meta.summary ?? ''}</p>
    `
    return el
}

function insertSortedByDate(el) {
    // New items go to the top of the list, preserving date-desc order.
    const next = [...list.children].find(c => c.dataset.date < el.dataset.date)
    if (next) list.insertBefore(el, next); else list.appendChild(el)
}

// 1. Initial snapshot — render what's already published.
const { items } = await docs.list({
    filter,
    sort:   { 'meta.date': -1 },
    fields: ['id', 'meta.title', 'meta.date', 'meta.summary'],
    limit:  20,
})
for (const item of items) {
    const el = render(item)
    byId.set(item.id, el)
    insertSortedByDate(el)
}

// 2. Forward subscription — patch the DOM as content changes.
const ac = new AbortController()
addEventListener('beforeunload', () => ac.abort())

for await (const event of docs.watch({ filter }, { signal: ac.signal })) {
    switch (event.type) {
        case 'create': {
            const el = render(event.entity)
            byId.set(event.id, el)
            insertSortedByDate(el)
            break
        }
        case 'update': {
            const old = byId.get(event.id)
            const el  = render(event.entity)
            byId.set(event.id, el)
            if (old) old.replaceWith(el); else insertSortedByDate(el)
            break
        }
        case 'delete': {
            byId.get(event.id)?.remove()
            byId.delete(event.id)
            break
        }
        // 'init' fires once when the subscription opens — no-op here.
        // 'heartbeat' fires periodically to keep the connection alive.
    }
}
```

Notice the same filter scope on both calls. The server's endpoint scope (`type === 'document' && meta?.published`) ANDs with it on both sides, so unpublishing a doc in Decap fires a `delete` event from this filter's perspective even though the file still exists — the entity dropped out of the visible set.

### Single-document live preview

An editor previews a `.md` they're writing; the preview pane should re-render whenever the file is saved.

```js
const docs = createClient({ baseUrl: 'https://cms.example.com' })
    .entities('public')

const previewedId = '/documents/en/draft.md'
const pane = document.getElementById('preview')

async function refresh() {
    const { items: [entity] } = await docs.list({
        filter: { id: previewedId },
        limit:  1,
    })
    pane.innerHTML = entity?.content ?? '<em>not found</em>'
}

await refresh()

// Subscribe only to events touching this one entity — the filter is
// just an equality match on `id`.
const ac = new AbortController()
for await (const event of docs.watch(
    { filter: { id: previewedId } },
    { signal: ac.signal },
)) {
    if (event.type === 'update') await refresh()
    if (event.type === 'delete') pane.innerHTML = '<em>document deleted</em>'
}
```

The narrow filter (`{ id: previewedId }`) means the subscription fires only for this exact entity. Mikser's server still walks the full journal per cycle, but for this client only one match dispatches.

### Search + enrich + live (mixing both SDKs)

A search-as-you-type UI. The user types a query; the **vector** SDK does semantic search and returns ranked hits; the **api** SDK keeps the list of currently displayed docs in sync if any of them changes underneath.

```js
import { createClient as createApiClient    } from 'mikser-io-sdk-api'
import { createClient as createVectorClient } from 'mikser-io-sdk-vector'

const baseUrl = 'https://cms.example.com'
const docs   = createApiClient(   { baseUrl }).entities('public')
const search = createVectorClient({ baseUrl }).vector('documents')

const results  = new Map() // id → result row { id, distance, title, summary }
const resultsEl = document.getElementById('search-results')

function rerender() {
    resultsEl.innerHTML = ''
    for (const r of results.values()) {
        const el = document.createElement('li')
        el.innerHTML = `<strong>${r.title}</strong><br><small>${r.distance.toFixed(3)}</small><p>${r.summary ?? ''}</p>`
        el.dataset.id = r.id
        resultsEl.appendChild(el)
    }
}

async function runSearch(text) {
    results.clear()
    // `data` is whatever your server's vector.stores[name].map() returned —
    // typically { title, summary, ... } — so render directly without a
    // second fetch.
    const hits = await search.findSimilar(text, { limit: 10 })
    for (const { id, distance, data } of hits.results) {
        results.set(id, {
            id, distance,
            title:   data?.title ?? id,
            summary: data?.summary,
        })
    }
    rerender()
}

// Background subscription — refresh result rows whose entities change.
// Vector results don't re-rank on the fly, but we DO want the displayed
// metadata (title, summary) to stay fresh, and we want deleted docs to
// drop out.
const ac = new AbortController()
;(async () => {
    for await (const event of docs.watch(
        { filter: { type: 'document' } },
        { signal: ac.signal },
    )) {
        if (event.type === 'delete' && results.has(event.id)) {
            results.delete(event.id)
            rerender()
        }
        if (event.type === 'update' && results.has(event.id)) {
            const r = results.get(event.id)
            results.set(event.id, {
                ...r,
                title:   event.entity.meta?.title   ?? r.title,
                summary: event.entity.meta?.summary ?? r.summary,
            })
            rerender()
        }
    }
})()

document.getElementById('search-input').addEventListener('input', e => {
    if (e.target.value.length >= 3) runSearch(e.target.value)
})
```

Two SDKs, one mental model, one server. The vector store gives you ranked semantic hits; the api watch keeps them honest about their current content.

### Framework integration

All the boilerplate (initial fetch, watch loop, race-safe cleanup) lives inside `live()`. A framework adapter is ~5 lines — it gives the SDK a callback and calls dispose on unmount. For the three major frameworks, those adapters are already published:

| Framework | Package | Primitive |
|---|---|---|
| Vue 3 | [`mikser-io-sdk-vue`](https://github.com/almero-digital-marketing/mikser-io-sdk-vue) | `useDocument(id)` / `useDocuments(query)` returning Vue refs; vue-router integration via `createMikserRouter` |
| React 18+ / 19+ | [`mikser-io-sdk-react`](https://github.com/almero-digital-marketing/mikser-io-sdk-react) | `useDocument(id)` / `useDocuments(query)` hooks; React Router integration via `useMikserRoutes` → `useRoutes` |
| Svelte 5 | [`mikser-io-sdk-svelte`](https://github.com/almero-digital-marketing/mikser-io-sdk-svelte) | `useDocument(() => id)` / `useDocuments(() => query)` runes-backed reactives; SvelteKit `entries()` integration via `generateMikserRoutes` |

All three share the same conceptual surface — single-document subscription, list subscription, multilingual `useHref` / `useAlternates`, asset resolution via `useAsset` — wrapped in each framework's idiomatic shape. They all peer-depend on this package and consume `live()` internally; nothing about their behaviour is duplicated logic. If you have one of those three frameworks, prefer the matching SDK over hand-rolling against `live()`.

The shape adapts to **any** framework with a setup-and-cleanup lifecycle — Solid (`createSignal` + `onCleanup`), Qwik (`useTask$`), Lit, or vanilla JS. For those, the adapter pattern is the same five lines: instantiate state, call `live(filter, setState)`, store the returned `dispose`, call it on teardown.

```js
// vanilla adapter shape — works in any environment
const documents = createClient({ baseUrl }).entities('public')

const dispose = documents.live(
    { 'meta.published': true },
    (items) => render(items),               // your update callback
    { sort: { 'meta.date': -1 }, limit: 20 },
)

// later, on teardown
dispose()
```

## Configure

```js
const mikser = createClient({
    baseUrl:  'https://cms.example.com',
    basePath: '/api',        // default — must match api.base on the server
    headers:  { 'x-trace-id': '...' },   // attached to every request
    fetch:    myFetchImpl,   // override (default: globalThis.fetch)
})
```

## Errors

Non-2xx responses throw `MikserError`:

```js
import { MikserError } from 'mikser-io-sdk-api'

try {
    await docs.list({ filter: { ... } })
} catch (err) {
    if (err instanceof MikserError) {
        console.error(err.status, err.body?.error)
    }
}
```

## TypeScript

Full type declarations ship with the package — including a `Filter` type that covers the sift operator subset.

```ts
import type { ListEnvelope } from 'mikser-io-sdk-api'

interface Doc { id: string; meta: { title: string; price?: number } }

const env: ListEnvelope<Doc> = await mikser.entities('public').list<Doc>({ ... })
```

## Using both SDKs together

If a project needs both document queries and semantic search, install both packages and alias the factories:

```js
import { createClient as createApiClient }    from 'mikser-io-sdk-api'
import { createClient as createVectorClient } from 'mikser-io-sdk-vector'

const baseUrl = 'http://localhost:3001'
const docs   = createApiClient({ baseUrl }).entities('public')
const search = createVectorClient({ baseUrl }).vector('documents')
```

## License

MIT
