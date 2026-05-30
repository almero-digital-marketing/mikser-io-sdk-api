// Error type used across the SDK for non-2xx responses.
// Callers can `instanceof MikserError` to branch on this specifically.
export class MikserError extends Error {
    constructor(status, statusText, body, url) {
        const detail = body?.error ? ': ' + body.error : ''
        super(`mikser-io-sdk-api ${status} ${statusText}${detail} (${url})`)
        this.name = 'MikserError'
        this.status = status
        this.body = body
    }
}
