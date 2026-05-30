// Small HTTP helpers shared across the SDK.
import { MikserError } from './error.js'

export function bearer(token) {
    return token ? { authorization: `Bearer ${token}` } : {}
}

// Throws MikserError on non-2xx so callers can use plain `await`
// without checking res.ok each time.
export async function jsonOrThrow(res, url) {
    if (!res.ok) {
        let body
        try { body = await res.json() } catch { /* leave undefined */ }
        throw new MikserError(res.status, res.statusText, body, url)
    }
    return res.json()
}
