// Server-Sent Events parser. Splits the raw body stream into one
// event block per "\n\n" and decodes each. Used by entities.watch()
// and entities.live().

// Parse one SSE event block ("event: foo\ndata: {...}\n"). Returns
// { type, ...payload } when data is JSON; { type, data } otherwise.
// Returns null on completely empty blocks (e.g. comment-only).
export function parseSseEvent(raw) {
    let type = 'message'
    let data = ''
    let sawAny = false
    for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue          // SSE comment
        if (line.startsWith('event:')) { type = line.slice(6).trim(); sawAny = true; continue }
        if (line.startsWith('data:'))  { data += line.slice(5).trim(); sawAny = true; continue }
    }
    if (!sawAny) return null
    try { return { type, ...JSON.parse(data || '{}') } }
    catch { return { type, data } }
}
