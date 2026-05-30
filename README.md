# mikser-io-sdk-api

Client SDK for querying a [mikser-io](https://github.com/almero-digital-marketing/mikser-io) server from the browser or Node — documents (`api` plugin) and semantic search (`vector` plugin) behind one tiny client.

Mikser keeps content as plain files. This SDK lets the frontend ask for exactly the slice it needs over HTTP — Mongo-style filter operators, sort, projection, pagination, semantic search — without shipping the whole catalog and filtering in JS.

Zero dependencies. Runs anywhere `fetch` is available (modern browsers, Node 18+, Deno, Bun, Workers).

## Install

```bash
npm install mikser-io-sdk-api
```

## Quick start

```js
import { createClient } from 'mikser-io-sdk-api'

const mikser = createClient({ baseUrl: 'http://localhost:3001' })

// --- documents (api plugin) ---
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

// --- semantic search (vector plugin) ---
const search = mikser.vector('documents')
const { results } = await search.findSimilar('how to publish a report', { limit: 5 })
// results = [{ id, distance, data: { title, ... } }, ...]
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

## Vector

`mikser.vector(storeName, { token })` returns a per-store client. The store name matches a key in your `vector.stores` config on the server.

```js
const search = mikser.vector('documents', { token: process.env.SEARCH_TOKEN })

const { results } = await search.findSimilar('how to publish a report', { limit: 5 })

for (const { id, distance, data } of results) {
    console.log(distance.toFixed(3), data?.title, '→', id)
}
```

`distance` is cosine distance (range ~0–2; lower = closer). Only the *ordering* is meaningful — don't compare absolute values across queries.

`data` is the original object your `map(entity)` returned on the server (`{ title, lang, summary, ... }` — whatever you chose to embed) — so you can render the hit without a second fetch.

## Configure

```js
const mikser = createClient({
    baseUrl:    'https://cms.example.com',
    basePath:   '/api',        // default — must match api.base on the server
    vectorPath: '/vector',     // default — must match vector.base on the server
    headers:    { 'x-trace-id': '...' },   // attached to every request
    fetch:      myFetchImpl,   // override (default: globalThis.fetch)
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
import type { ListEnvelope, VectorResult } from 'mikser-io-sdk-api'

interface Doc { id: string; meta: { title: string; price?: number } }

const env: ListEnvelope<Doc> = await mikser.entities('public').list<Doc>({ ... })
```

## License

MIT
