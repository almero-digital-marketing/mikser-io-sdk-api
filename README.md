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

`mikser.entities(endpointName, { token })` returns a per-endpoint client. The endpoint name matches a key in your `api.endpoints` config on the server.

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

### `urlFor(query)` — GET-form URL

Build a URL for the GET form of the same query. Useful when the response should be CDN-cacheable, or you want a sharable link.

```js
const url = docs.urlFor({
    filter: { 'meta.published': true, 'meta.price': { $gt: 20 } },
    sort:   { 'meta.date': -1 },
    limit:  10,
})
// http://localhost:3001/api/public/entities?meta.published=true&meta.price.$gt=20&sort=-meta.date&limit=10
```

### `pages(query)` — async iterator

```js
for await (const env of docs.pages({ filter: { type: 'document' }, limit: 50 })) {
    for (const item of env.items) {
        process(item)
    }
}
```

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
        limit:   20,
        signal:  abortController?.signal,    // optional external abort
        onError: err => console.error(err),  // optional error sink
    },
)

// Later:
dispose()
```

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
