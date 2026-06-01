// Type declarations for mikser-io-sdk-api.
// Intentionally permissive on the entity / data shape — every project's
// content is different, so callers narrow these with their own types.

export interface ClientOptions {
    /** Origin of the mikser server, e.g. https://cms.example.com */
    baseUrl: string
    /** api plugin mount path (default '/api'). */
    basePath?: string
    /** Override fetch (default: globalThis.fetch). */
    fetch?: typeof fetch
    /** Headers attached to every request. */
    headers?: Record<string, string>
}

export interface EntityOptions {
    /** Bearer token sent on every request to this endpoint. */
    token?: string
    /**
     * Mirrors the mikser-io `data` plugin's config block. The SDK
     * consumes the static JSON files the data plugin writes under
     * `out/data/` so first-paint reads come from disk (CDN-cacheable)
     * instead of hitting the live API.
     *
     * The names are the same as on the server:
     *   - `data.catalog`  pairs with `data.catalog.<name>`  on mikser
     *   - `data.entities` pairs with `data.entities.<name>` on mikser
     *
     * On a fetch failure the SDK silently falls back to the live API
     * for that call — no separate flag.
     */
    data?: DataOptions
}

export interface DataOptions {
    /**
     * Name of a `data.catalog.<name>` block on the server. The SDK
     * loads `/data/<name>.json` (one combined file) on first paint;
     * `live()` and `listAll()` consult it before hitting the API.
     */
    catalog?: string
    /**
     * Name of a `data.entities.<name>` block on the server. When
     * `live({id})` (the shape `useDocument` issues) fires, the SDK
     * loads `/data/<entry.name>.<name>.json` (one file per entity)
     * instead of calling the API. Requires `data.catalog` so the
     * `entry.name` mapping is available.
     */
    entities?: string
}

/**
 * A subset of the Mongo query language as understood by sift on the
 * server. Use dotted-path keys (`'meta.price'`) for nested fields —
 * nested object literals are interpreted as deep-equality matches.
 */
export type Filter = Record<string, FilterValue> & {
    $and?: Filter[]
    $or?: Filter[]
    $not?: Filter
}

export type FilterValue =
    | string | number | boolean | null
    | {
        $eq?: unknown
        $ne?: unknown
        $gt?: unknown
        $gte?: unknown
        $lt?: unknown
        $lte?: unknown
        $in?: unknown[]
        $nin?: unknown[]
        $exists?: boolean
        $regex?: string
        $not?: FilterValue
      }

export interface ListQuery {
    filter?: Filter
    sort?: Record<string, 1 | -1>
    fields?: string[]
    page?: number
    skip?: number
    limit?: number
}

export interface ListEnvelope<T = unknown> {
    items: T[]
    page: number
    limit: number
    total: number
    totalPages: number
    hasNext: boolean
    hasPrev: boolean
}

export interface UpdatePayload {
    collection: string
    relativePath: string
    content?: string
}

export interface DeletePayload {
    collection: string
    relativePath: string
}

export interface RenderOptions {
    save?: boolean
    catalog?: boolean
    [key: string]: unknown
}

export type WatchEvent<T = unknown> =
    | { type: 'init'; subscriptionId: string; endpoint: string }
    | { type: 'create'; id: string; entity: T }
    | { type: 'update'; id: string; entity: T }
    | { type: 'delete'; id: string }
    | { type: 'heartbeat' }

export interface WatchOptions {
    /** Abort the SSE stream. */
    signal?: AbortSignal
}

export interface LiveOptions {
    /** Sort applied to the initial list(); not re-applied to live updates. */
    sort?: Record<string, 1 | -1>
    /** Field projection for the initial list(). */
    fields?: string[]
    /** Page size for the initial list(). */
    limit?: number
    /** Skip for the initial list(). */
    skip?: number
    /** External AbortSignal — calling abort() stops the live view. */
    signal?: AbortSignal
    /** Error sink. Defaults to console.error. */
    onError?: (err: unknown) => void
}

export interface EntitiesClient {
    /** POST /entities/query — body-based, supports any sift filter. */
    list<T = unknown>(query?: ListQuery): Promise<ListEnvelope<T>>
    /** Build the GET-form URL — CDN-cacheable, sharable. */
    urlFor(query?: ListQuery): string
    /** Iterate result pages — yields each envelope until hasNext is false. */
    pages<T = unknown>(query?: ListQuery): AsyncGenerator<ListEnvelope<T>>
    /**
     * One-shot: fetch every matching entity into a flat array.
     * Auto-paginates internally; `limit` controls per-page batch size
     * (default 1000), not total cap. Right for SSG enumeration; wrong
     * for catalogs too large to hold in memory.
     */
    listAll<T = unknown>(query?: ListQuery): Promise<T[]>
    /**
     * Open an SSE stream and yield events as matching entities change.
     * Compose with list() for initial state, then watch() for updates.
     */
    watch<T = unknown>(query?: ListQuery, options?: WatchOptions): AsyncGenerator<WatchEvent<T>>
    /**
     * list-and-watch composed: calls onChange(items) with the initial
     * result, then again on every change. Returns a dispose function.
     * The race-safe building block for framework-side hooks.
     */
    live<T = unknown>(
        filter: Filter,
        onChange: (items: T[]) => void,
        options?: LiveOptions,
    ): () => void
    /** PUT — upsert a file in a collection folder. */
    update(payload: UpdatePayload): Promise<{ ok: true }>
    /** DELETE — remove a file from a collection folder. */
    delete(payload: DeletePayload): Promise<{ ok: true }>
    /** POST /render — render an entity in memory; return shape varies by output content-type. */
    render(entity: Record<string, unknown>, options?: RenderOptions): Promise<unknown>
}

export interface MikserClient {
    entities(name: string, options?: EntityOptions): EntitiesClient
}

export declare function createClient(options: ClientOptions): MikserClient

export declare class MikserError extends Error {
    name: 'MikserError'
    status: number
    body: { error?: string } | undefined
}
