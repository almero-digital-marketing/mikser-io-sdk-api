import { describe, it, expect } from 'vitest'
import { parseSseEvent } from '../src/sse.js'

describe('parseSseEvent', () => {
    it('returns null for fully empty blocks', () => {
        expect(parseSseEvent('')).toBeNull()
    })

    it('returns null when the block is comment-only', () => {
        // SSE comments start with ':' and carry no event/data — heartbeats
        // from many servers look like ': keep-alive'.
        expect(parseSseEvent(': keep-alive')).toBeNull()
    })

    it('defaults type to "message" when no event: line is present', () => {
        const event = parseSseEvent('data: {"x":1}')
        expect(event.type).toBe('message')
        expect(event.x).toBe(1)
    })

    it('parses event: and merges JSON data fields onto the event', () => {
        const event = parseSseEvent('event: create\ndata: {"id":"abc","entity":{"meta":{}}}')
        expect(event.type).toBe('create')
        expect(event.id).toBe('abc')
        expect(event.entity).toEqual({ meta: {} })
    })

    it('falls back to {type, data} when data is not JSON', () => {
        const event = parseSseEvent('event: hello\ndata: world')
        expect(event).toEqual({ type: 'hello', data: 'world' })
    })

    it('handles missing data line as empty JSON', () => {
        const event = parseSseEvent('event: heartbeat')
        expect(event.type).toBe('heartbeat')
    })

    it('skips comment lines but still parses the data', () => {
        const raw = ': retry: 1000\nevent: update\ndata: {"id":"x"}'
        const event = parseSseEvent(raw)
        expect(event.type).toBe('update')
        expect(event.id).toBe('x')
    })

    it('concatenates multiple data: lines without a separator (parser quirk worth knowing)', () => {
        // The parser joins data lines by raw concatenation, not by '\n' as
        // the SSE spec strictly requires. This works fine for the mikser
        // api plugin because it always emits JSON on a single data line,
        // but the test documents the behavior so anyone changing it knows
        // what they'd be changing.
        const raw = 'event: x\ndata: {"a":\ndata: 1}'
        const event = parseSseEvent(raw)
        // Concatenated → '{"a":1}' → valid JSON → merged onto the event
        expect(event).toEqual({ type: 'x', a: 1 })
    })

    it('falls back to {type, data: string} when concatenated data is not valid JSON', () => {
        const event = parseSseEvent('event: blob\ndata: not json at all')
        expect(event).toEqual({ type: 'blob', data: 'not json at all' })
    })
})
