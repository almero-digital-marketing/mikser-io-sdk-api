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

/**
 * Options for {@link EntitiesClient.paginator}.
 */
export interface PaginatorOptions extends Omit<ListQuery, 'page' | 'limit' | 'skip'> {
    /** Items per page. Default: 10. Must be a positive integer. */
    pageSize?: number
    /**
     * Builds the href for each pageNumbers entry. Defaults to mikser's
     * SSG URL convention — page 1 at `/`, page N at `/<N>/`.
     */
    urlFor?: (page: number) => string
}

/**
 * One entry in the paginator's pageNumbers array — usable directly
 * by pagination nav components.
 */
export interface PageNumber {
    num: number
    url: string
    isCurrent: boolean
}

/**
 * Stateful paginator returned from {@link EntitiesClient.paginator}.
 * Each navigation method (goTo / next / prev) fetches ONE page from
 * the server. State accessors are getters — the value you read is
 * always the result of the last completed fetch.
 */
export interface Paginator<T = unknown> {
    /** Items in the current page. Empty until goTo() / next() has resolved. */
    readonly items: T[]
    /** Current page number (1-indexed). 1 before the first fetch. */
    readonly page: number
    /** Total page count (server-computed). 1 before the first fetch. */
    readonly pages: number
    /** Total item count across all pages (server-computed). */
    readonly totalItems: number
    /** Page size used for all fetches. */
    readonly pageSize: number
    readonly hasNext: boolean
    readonly hasPrev: boolean
    /** True after the first successful fetch. */
    readonly loaded: boolean
    /** Per-page nav entries — `[{ num, url, isCurrent }, ...]`. */
    readonly pageNumbers: PageNumber[]
    /** Fetch a specific page. Throws on invalid page number. */
    goTo(page: number): Promise<Paginator<T>>
    /** Fetch the next page. Throws if already at the last page. */
    next(): Promise<Paginator<T>>
    /** Fetch the previous page. Throws if already at the first page. */
    prev(): Promise<Paginator<T>>
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
     * Stateful paginator over list(). Each goTo / next / prev fetches
     * ONE page from the server — no upfront load of the full
     * collection. Right for UI navigation; wrong for SSG sitemap
     * enumeration (use pages() or listAll() for that).
     */
    paginator<T = unknown>(options?: PaginatorOptions): Paginator<T>
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

// ────────────────────────────────────────────────────────────────────
// Pure utilities — framework SDKs wrap these in their own reactivity.
// ────────────────────────────────────────────────────────────────────

export interface GenerateRoutesOptions<TRoute = unknown> {
    /** A mikser entities client (the result of createClient(...).entities(name)). */
    client: { listAll(query: ListQuery): Promise<Array<{ id: string; meta?: Record<string, unknown> }>> }
    /** Sift filter — defaults to "published documents that declare meta.route". */
    filter?: Filter
    /** Maps a catalog document to a route descriptor (or null to skip). */
    mapRoute: (document: { id: string; meta?: Record<string, unknown> }) => TRoute | null
}

/**
 * Build-time route enumeration. Auto-paginates via listAll() and
 * applies `mapRoute` to every catalog entity that matches the filter.
 * `null` returns from `mapRoute` are dropped.
 */
export function generateMikserRoutes<TRoute = unknown>(
    options: GenerateRoutesOptions<TRoute>,
): Promise<TRoute[]>

export interface HrefIndexOptions {
    /** Fallback language tag for documents that don't declare meta.lang. Default 'default'. */
    defaultLang?: string
}

export interface HrefIndex {
    /** Resolve a logical reference (`/about`) to a deployed URL for the given language. */
    href(ref: string, lang?: string): string
    /** Reverse — given a deployed URL, return the logical reference it belongs to. */
    refFor(url: string | null): string | null
    /** Alternates for a deployed URL — `current` plus the alternate-language URLs. */
    alternates(options: { route: string | null; languages?: string[] }): {
        current: { lang: string | null; url: string; ref: string } | null
        alternates: Array<{ lang: string; url: string }>
    }
    /** Raw `ref → { lang → url }` map, for inspection / debugging. */
    map: Record<string, Record<string, string>>
}

/**
 * Build a multilingual href lookup from a snapshot of catalog documents.
 * Pure data transformation — wrap in a framework-specific reactive
 * shell to drive `useHref` / `useAlternates` composables.
 */
export function createHrefIndex(
    documents: Array<{ meta?: Record<string, unknown> }>,
    options?: HrefIndexOptions,
): HrefIndex

export interface AssetRecord {
    url: string
    width?: number
    height?: number
    srcset?: string
    alt?: string
    meta?: Record<string, unknown>
}

export interface ImageProps {
    src: string
    width?: number
    height?: number
    srcset?: string
    alt?: string
}

export interface AssetIndex {
    asset(ref: string): AssetRecord | null
    image(ref: string): ImageProps | null
    map: Record<string, AssetRecord>
}

/**
 * Build an asset metadata lookup from a snapshot of asset entities.
 * Pure data transformation — wrap in a framework-specific reactive
 * shell to drive `useAsset` composables.
 */
export function createAssetIndex(
    assets: Array<{ id: string; meta?: Record<string, unknown> }>,
): AssetIndex

