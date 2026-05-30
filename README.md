# mikser-io-sdk-api

Client SDK for querying a [mikser-io](https://github.com/almero-digital-marketing/mikser-io) server's `api` plugin from the browser or Node — list / query / paginate / project the document catalog, subscribe to live changes, and trigger renders.

Mikser keeps content as plain files. This SDK lets the frontend ask for exactly the slice it needs over HTTP — Mongo-style filter operators, sort, projection, pagination — without shipping the whole catalog and filtering in JS.

For semantic search against the `vector` plugin, install [mikser-io-sdk-vector](https://github.com/almero-digital-marketing/mikser-io-sdk-vector) — it ships as a separate package.

Zero dependencies. Runs anywhere `fetch` is available (modern browsers, Node 18+, Deno, Bun, Workers).

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

## Entities

`mikser.entities(endpointName, { token })` returns a per-endpoint client. The endpoint name matches a key in your `api.endpoints` config on the server.

### `list(query)` / `query(query)` — body-based

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

Open a Server-Sent Events stream and yield events as matching entities change. Composes with `list()` — call once for the initial snapshot, then `watch()` for forward updates.

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
