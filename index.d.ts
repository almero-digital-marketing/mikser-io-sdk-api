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

export interface EntitiesClient {
    /** POST /entities/query — body-based, supports any sift filter. */
    list<T = unknown>(query?: ListQuery): Promise<ListEnvelope<T>>
    /** Alias of list — for callers who prefer `query()` semantically. */
    query<T = unknown>(query?: ListQuery): Promise<ListEnvelope<T>>
    /** Build the GET-form URL — CDN-cacheable, sharable. */
    urlFor(query?: ListQuery): string
    /** Iterate result pages — yields each envelope until hasNext is false. */
    pages<T = unknown>(query?: ListQuery): AsyncGenerator<ListEnvelope<T>>
    /**
     * Open an SSE stream and yield events as matching entities change.
     * Compose with list() for initial state, then watch() for updates.
     */
    watch<T = unknown>(query?: ListQuery, options?: WatchOptions): AsyncGenerator<WatchEvent<T>>
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
