import { describe, expect, test } from 'bun:test'
import { bearerAuth, createPagesClient } from './client.ts'
import { emptySelectionCursor, pollSelections } from './presence-source.ts'

function fakePresence(body: unknown) {
  const fakeFetch = (async () =>
    new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
  return createPagesClient({
    origin: 'http://pages.test',
    auth: bearerAuth('t'),
    fetch: fakeFetch,
  })
}

const selection = (overrides: Record<string, unknown> = {}) => ({
  block_id: 'b1',
  status: 'attached',
  kind: 'selection',
  start_utf16: 0,
  end_utf16: 3,
  quote: 'abc',
  ...overrides,
})

const participant = (overrides: Record<string, unknown> = {}) => ({
  peer_id: 'peer-1',
  principal: 'person-1',
  displayName: 'Person',
  driver: 'Browser',
  last_seen: '2026-11-10T00:00:00.000Z',
  selection: selection(),
  ...overrides,
})

describe('pollSelections', () => {
  test('emits selected for a new attached selection', async () => {
    const client = fakePresence({ participants: [participant()] })
    const result = await pollSelections(client, 'p', emptySelectionCursor(), 'self')
    expect(result.epoch).toBe(1)
    expect(result.changes).toEqual([
      expect.objectContaining({
        surface: 'selection',
        change: 'selected',
        peerId: 'peer-1',
        blockId: 'b1',
        kind: 'selection',
        quote: 'abc',
        actorKind: 'person',
        priority: 1,
      }),
    ])
    expect(result.cursor.seen['peer-1']?.blockId).toBe('b1')
  })

  test('an unchanged fingerprint produces nothing', async () => {
    const client = fakePresence({ participants: [participant()] })
    const first = await pollSelections(client, 'p', emptySelectionCursor(), 'self')
    const second = await pollSelections(client, 'p', first.cursor, 'self')
    expect(second.changes).toEqual([])
    expect(second.epoch).toBe(1)
  })

  test('a moved selection is updated', async () => {
    const client = fakePresence({
      participants: [participant({ selection: selection({ start_utf16: 4, end_utf16: 6 }) })],
    })
    const before = emptySelectionCursor()
    before.seen['peer-1'] = {
      blockId: 'b1',
      kind: 'selection',
      startUtf16: 0,
      endUtf16: 3,
      quote: 'abc',
      principal: 'person-1',
      displayName: 'Person',
      driver: 'Browser',
      observedAt: '2026-11-10T00:00:00.000Z',
    }
    const result = await pollSelections(client, 'p', before, 'self')
    expect(result.changes).toEqual([
      expect.objectContaining({ change: 'updated', startUtf16: 4, endUtf16: 6 }),
    ])
    expect(result.epoch).toBe(1)
  })

  test('a missing or detached selection is cleared once', async () => {
    const client = fakePresence({
      participants: [participant({ selection: selection({ status: 'detached' }) })],
    })
    const before = emptySelectionCursor()
    before.seen['peer-1'] = {
      blockId: 'b1',
      kind: 'caret',
      startUtf16: 2,
      endUtf16: 2,
      quote: null,
      principal: 'person-1',
      displayName: 'Person',
      driver: 'Browser',
      observedAt: '2026-11-10T00:00:00.000Z',
    }
    const result = await pollSelections(client, 'p', before, 'self')
    expect(result.changes).toEqual([
      expect.objectContaining({ change: 'cleared', peerId: 'peer-1', blockId: 'b1' }),
    ])
    expect(result.cursor.seen['peer-1']).toBeUndefined()
    expect(result.epoch).toBe(1)

    const again = await pollSelections(client, 'p', result.cursor, 'self')
    expect(again.changes).toEqual([])
  })

  test('a peer that disappears is cleared', async () => {
    const before = emptySelectionCursor()
    before.seen['peer-1'] = {
      blockId: 'b1',
      kind: 'selection',
      startUtf16: 0,
      endUtf16: 1,
      quote: 'a',
      principal: 'person-1',
      displayName: 'Person',
      driver: 'Browser',
      observedAt: '2026-11-10T00:00:00.000Z',
    }
    const result = await pollSelections(fakePresence({ participants: [] }), 'p', before, 'self')
    expect(result.changes).toEqual([expect.objectContaining({ change: 'cleared', peerId: 'peer-1' })])
  })

  test('own selections are filtered', async () => {
    const client = fakePresence({ participants: [participant({ principal: 'self', driver: 'Kilo' })] })
    const result = await pollSelections(client, 'p', emptySelectionCursor(), 'self')
    expect(result.changes).toEqual([])
    expect(result.epoch).toBe(0)
  })

  test('pending selections are not emitted', async () => {
    const client = fakePresence({
      participants: [participant({ selection: selection({ status: 'pending' }) })],
    })
    const result = await pollSelections(client, 'p', emptySelectionCursor(), 'self')
    expect(result.changes).toEqual([])
  })

  test('multiple peers coalesce into one epoch', async () => {
    const client = fakePresence({
      participants: [participant(), participant({ peer_id: 'peer-2', principal: 'person-2' })],
    })
    const result = await pollSelections(client, 'p', emptySelectionCursor(), 'self')
    expect(result.changes).toHaveLength(2)
    expect(result.epoch).toBe(1)
  })
})
