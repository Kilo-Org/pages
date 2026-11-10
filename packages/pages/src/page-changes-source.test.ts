import { describe, expect, test } from 'bun:test'
import { bearerAuth, createPagesClient, emptySelectionCursor } from './index.ts'
import { openCursor, pollPage, type PageCursor } from './page-changes-source.ts'

type Reply = { status?: number; body: unknown }

function fakePages(replies: Record<string, Reply[]>) {
  const calls: { operation: string; args: Record<string, unknown> }[] = []
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const { operation, arguments: args } = JSON.parse(String(init?.body))
    calls.push({ operation, args })
    const queue = replies[operation]
    const reply = queue && queue.length > 1 ? queue.shift()! : queue?.[0]
    if (!reply) {
      if (operation === 'read_page_presence') {
        return new Response(JSON.stringify({ participants: [] }), { status: 200 })
      }
      throw new Error(`no scripted reply for ${operation}`)
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }) as typeof fetch
  const client = createPagesClient({ origin: 'http://pages.test', auth: bearerAuth('t'), fetch: fakeFetch })
  return { client, calls }
}

const cursor = (
  heads: string[],
  commentHeads: string[] | null = ['c0'],
  selection = emptySelectionCursor(),
): PageCursor => ({ heads, commentHeads, title: 'T', selection })

const delta = (
  heads: string[],
  options: {
    commentHeads?: string[]
    texts?: string[]
    comments?: unknown[]
    snapshot?: boolean
  } = {},
) => ({
  body: {
    heads,
    ...(options.commentHeads ? { comment_heads: options.commentHeads } : {}),
    title_changed: false,
    changes: (options.texts ?? []).map((markdown, i) => ({
      block_id: 'b1',
      scope: 'node',
      change: 'updated',
      node_index: i,
      node_id: null,
      type: 'paragraph',
      markdown,
    })),
    comments: options.comments ?? [],
    ...(options.snapshot ? { comments_snapshot: true } : {}),
  },
})

const person = { principal: 'person-1', displayName: 'Person', driver: 'Browser' }

describe('pollPage — content and comments', () => {
  test('maps a body delta and advances both heads', async () => {
    const { client } = fakePages({ read_page_changes: [delta(['h1'], { texts: ['Hi'] })] })
    const result = await pollPage(client, 'p', cursor(['h0']), {
      ownPrincipal: 'self',
      now: () => new Date(0),
    })
    expect(result.event).toMatchObject({
      id: 'p@h1+c:c0+s:0',
      fromHeads: ['h0'],
      toHeads: ['h1'],
      changes: [{ surface: 'body', actorKind: 'unknown', priority: 2, markdown: 'Hi' }],
    })
    expect(result.cursor.heads).toEqual(['h1'])
  })

  test('a comment-only change produces an event even when Page heads do not move', async () => {
    const { client } = fakePages({
      read_page_changes: [
        delta(['h0'], {
          commentHeads: ['c1'],
          comments: [
            {
              thread_id: 't1',
              change: 'inserted',
              block_id: 'b1',
              messages: [{ id: 'm1', body: 'Hello', author: person }],
            },
          ],
        }),
      ],
    })
    const result = await pollPage(client, 'p', cursor(['h0']), { ownPrincipal: 'self' })
    expect(result.event?.id).toBe('p@h0+c:c1+s:0')
    expect(result.event?.changes).toEqual([
      expect.objectContaining({
        surface: 'comment',
        change: 'inserted',
        threadId: 't1',
        messageId: 'm1',
        body: 'Hello',
        authorPrincipal: 'person-1',
        actorKind: 'person',
        priority: 1,
      }),
    ])
    expect(result.cursor.commentHeads).toEqual(['c1'])
  })

  test('body and comment changes arrive in one event', async () => {
    const { client } = fakePages({
      read_page_changes: [
        delta(['h1'], {
          texts: ['New text'],
          commentHeads: ['c1'],
          comments: [
            {
              thread_id: 't1',
              change: 'updated',
              block_id: 'b1',
              messages: [{ id: 'm2', body: 'A comment', author: person }],
            },
          ],
        }),
      ],
    })
    const result = await pollPage(client, 'p', cursor(['h0']), { ownPrincipal: 'self' })
    expect(result.event?.changes.map((change) => change.surface)).toEqual(['body', 'comment'])
  })

  test('self-authored comments are filtered before the event', async () => {
    const { client } = fakePages({
      read_page_changes: [
        delta(['h0'], {
          commentHeads: ['c1'],
          comments: [
            {
              thread_id: 't1',
              change: 'inserted',
              block_id: 'b1',
              messages: [{ id: 'm1', body: 'echo', author: { principal: 'self', driver: 'Kilo' } }],
            },
          ],
        }),
      ],
    })
    const result = await pollPage(client, 'p', cursor(['h0']), { ownPrincipal: 'self' })
    expect(result.event?.changes).toEqual([])
    expect(result.cursor.commentHeads).toEqual(['c1'])
  })

  test('mixed threads keep only the person messages', async () => {
    const { client } = fakePages({
      read_page_changes: [
        delta(['h0'], {
          commentHeads: ['c1'],
          comments: [
            {
              thread_id: 't1',
              change: 'updated',
              block_id: 'b1',
              messages: [
                { id: 'm1', body: 'echo', author: { principal: 'self', driver: 'Kilo' } },
                { id: 'm2', body: 'thanks', author: person },
              ],
            },
          ],
        }),
      ],
    })
    const result = await pollPage(client, 'p', cursor(['h0']), { ownPrincipal: 'self' })
    expect(result.event?.changes).toHaveLength(1)
    expect(result.event?.changes[0]).toMatchObject({ messageId: 'm2', body: 'thanks' })
  })

  test('a snapshot establishes the comment baseline without replaying it', async () => {
    const { client } = fakePages({
      read_page_changes: [
        delta(['h0'], {
          commentHeads: ['c1'],
          snapshot: true,
          comments: [{ thread_id: 't1', change: 'snapshot', block_id: 'b1' }],
        }),
      ],
    })
    const result = await pollPage(client, 'p', cursor(['h0'], null), { ownPrincipal: 'self' })
    expect(result.event).toBeNull()
    expect(result.cursor.commentHeads).toEqual(['c1'])
  })

  test('a deleted thread is one thread-level change', async () => {
    const { client } = fakePages({
      read_page_changes: [
        delta(['h0'], { commentHeads: ['c1'], comments: [{ thread_id: 't1', change: 'deleted' }] }),
      ],
    })
    const result = await pollPage(client, 'p', cursor(['h0']), { ownPrincipal: 'self' })
    expect(result.event?.changes).toEqual([
      expect.objectContaining({
        surface: 'comment',
        change: 'deleted',
        threadId: 't1',
        messageId: null,
        body: null,
        actorKind: 'unknown',
      }),
    ])
  })

  test('an unavailable comment baseline resyncs both revisions and keeps selection state', async () => {
    const selection = {
      epoch: 2,
      seen: {
        'peer-1': {
          blockId: 'b1',
          kind: 'caret' as const,
          startUtf16: 1,
          endUtf16: 1,
          quote: null,
          principal: 'person-1',
          displayName: 'Person',
          driver: 'Browser',
          observedAt: '2026-11-10T00:00:00.000Z',
        },
      },
    }
    const { client } = fakePages({
      read_page_changes: [
        { status: 409, body: { code: 'resync_required', error: 'unknown comments baseline' } },
      ],
      read_page: [{ body: { title: 'T', heads: ['h9'], comment_heads: ['c9'] } }],
    })
    const result = await pollPage(client, 'p', cursor(['h0'], ['c0'], selection), {
      ownPrincipal: 'self',
    })
    expect(result).toMatchObject({
      event: null,
      resynced: true,
      cursor: { heads: ['h9'], commentHeads: ['c9'], selection },
    })
  })

  test('openCursor records both heads', async () => {
    const { client } = fakePages({
      read_page: [{ body: { title: 'T', heads: ['h1'], comment_heads: ['c1'] } }],
    })
    expect(await openCursor(client, 'p')).toMatchObject({
      heads: ['h1'],
      commentHeads: ['c1'],
      title: 'T',
    })
  })
})

describe('pollPage — selections', () => {
  test('a selection-only change produces an event and increments the epoch', async () => {
    const { client } = fakePages({
      read_page_changes: [delta(['h0'])],
      read_page_presence: [
        {
          body: {
            participants: [
              {
                peer_id: 'peer-1',
                principal: 'person-1',
                displayName: 'Person',
                driver: 'Browser',
                last_seen: '2026-11-10T00:00:00.000Z',
                selection: {
                  block_id: 'b1',
                  status: 'attached',
                  kind: 'selection',
                  start_utf16: 0,
                  end_utf16: 3,
                  quote: 'abc',
                },
              },
            ],
          },
        },
      ],
    })
    const result = await pollPage(client, 'p', cursor(['h0']), { ownPrincipal: 'self' })
    expect(result.event?.id).toBe('p@h0+c:c0+s:1')
    expect(result.event?.changes).toEqual([
      expect.objectContaining({
        surface: 'selection',
        change: 'selected',
        blockId: 'b1',
        kind: 'selection',
        quote: 'abc',
        actorKind: 'person',
      }),
    ])
    expect(result.cursor.selection.epoch).toBe(1)
  })

  test('own selections are filtered', async () => {
    const { client } = fakePages({
      read_page_changes: [delta(['h0'])],
      read_page_presence: [
        {
          body: {
            participants: [
              {
                peer_id: 'peer-1',
                principal: 'self',
                driver: 'Kilo',
                selection: { block_id: 'b1', status: 'attached', kind: 'caret' },
              },
            ],
          },
        },
      ],
    })
    const result = await pollPage(client, 'p', cursor(['h0']), { ownPrincipal: 'self' })
    expect(result.event).toBeNull()
  })

  test('a presence failure is skipped without failing the content poll', async () => {
    const logs: string[] = []
    const { client } = fakePages({
      read_page_changes: [delta(['h1'], { texts: ['Hi'] })],
      read_page_presence: [{ status: 500, body: { error: 'presence down' } }],
    })
    const result = await pollPage(client, 'p', cursor(['h0']), {
      ownPrincipal: 'self',
      log: (line) => void logs.push(line),
    })
    expect(result.event?.changes.map((change) => change.surface)).toEqual(['body'])
    expect(logs.some((line) => line.includes('presence read failed'))).toBe(true)
  })
})
