import { describe, expect, test } from 'bun:test'
import { bearerAuth, createPagesClient, type PageCursor } from '@pages-programs/pages'
import { pollPage } from '@pages-programs/pages'
import { defineProgram } from '@pages-programs/sdk'
import { runProgram, type SavedInstance } from './runtime.ts'

type Reply = { status?: number; body: unknown }

function fakePages(replies: Record<string, Reply[]>) {
  const calls: { operation: string; args: Record<string, unknown> }[] = []
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/whoami')) {
      calls.push({ operation: 'whoami', args: {} })
      const reply = replies.whoami?.[0]
      if (reply?.status && reply.status >= 400) {
        return new Response(JSON.stringify(reply.body), { status: reply.status })
      }
      return new Response(
        JSON.stringify(
          reply?.body ?? {
            account: { principal: 'self' },
            credential: { kind: 'api-key', can_write: true },
          },
        ),
        { status: 200 },
      )
    }
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

const cursor = (heads: string[], commentHeads: string[] | null = null): PageCursor => ({
  heads,
  commentHeads,
  title: 'T',
  selection: { epoch: 0, seen: {} },
})

const eventId = (heads: string[], commentHeads: string[] = [], epoch = 0) =>
  `p@${heads.join('+')}+c:${commentHeads.join('+')}+s:${epoch}`

const changes = (heads: string[], texts: string[], commentHeads?: string[]) => ({
  body: {
    heads,
    ...(commentHeads ? { comment_heads: commentHeads } : {}),
    title_changed: false,
    changes: texts.map((markdown, i) => ({
      block_id: 'b1',
      scope: 'node',
      change: 'updated',
      node_index: i,
      node_id: null,
      type: 'paragraph',
      markdown,
    })),
  },
})

const opened = { body: { title: 'T', heads: ['h0'] } }

describe('pollPage', () => {
  test('maps a net diff to one stable event and advances the cursor', async () => {
    const { client } = fakePages({ read_page_changes: [changes(['h1'], ['Hi'])] })
    const result = await pollPage(client, 'p', cursor(['h0']), { now: () => new Date(0) })
    expect(result.event).toMatchObject({
      id: eventId(['h1']),
      type: 'page.changed',
      fromHeads: ['h0'],
      toHeads: ['h1'],
      changes: [{ surface: 'body', scope: 'node', markdown: 'Hi' }],
    })
    expect(result.cursor.heads).toEqual(['h1'])
  })

  test('unchanged heads produce no event', async () => {
    const { client } = fakePages({ read_page_changes: [changes(['h0'], [])] })
    const result = await pollPage(client, 'p', cursor(['h0']))
    expect(result.event).toBeNull()
  })

  test('unknown heads resync to current heads instead of failing', async () => {
    const { client } = fakePages({
      read_page_changes: [{ status: 409, body: { code: 'resync_required', error: 'unknown history' } }],
      read_page: [{ body: { title: 'T', heads: ['h9'] } }],
    })
    const result = await pollPage(client, 'p', cursor(['h0']))
    expect(result).toMatchObject({ event: null, resynced: true, cursor: { heads: ['h9'] } })
  })
})

describe('runProgram', () => {
  const memoryStore = (initial?: SavedInstance) => {
    let saved = initial
    return { load: async () => saved, save: async (next: SavedInstance) => void (saved = next), peek: () => saved }
  }

  test('handles events, then resumes from the saved cursor', async () => {
    const seen: string[] = []
    const program = defineProgram({
      manifest: { name: 't', triggers: ['page.changed'] },
      key: (e) => e.pageId,
      handle: async (e) => void seen.push(e.id),
    })
    const store = memoryStore()
    const first = fakePages({ read_page: [opened], read_page_changes: [changes(['h1'], ['a'])] })
    await runProgram({
      program, client: first.client, pageId: 'p', store, intervalMs: 1,
      signal: new AbortController().signal, log: () => {}, stopAfterEvents: 1,
    })
    expect(store.peek()?.cursor.heads).toEqual(['h1'])

    const second = fakePages({ read_page_changes: [changes(['h2'], ['b'])] })
    await runProgram({
      program, client: second.client, pageId: 'p', store, intervalMs: 1,
      signal: new AbortController().signal, log: () => {}, stopAfterEvents: 1,
    })
    expect(seen).toEqual([eventId(['h1']), eventId(['h2'])])
    expect(second.calls.find((c) => c.operation === 'read_page_changes')?.args.since_heads).toEqual(['h1'])
    expect(second.calls.some((c) => c.operation === 'read_page')).toBe(false)
  })

  test('a failing handler does not advance the durable cursor', async () => {
    let attempts = 0
    const program = defineProgram({
      manifest: { name: 't', triggers: ['page.changed'] },
      key: (e) => e.pageId,
      handle: async () => {
        if (++attempts === 1) throw new Error('boom')
      },
    })
    const store = memoryStore()
    const { client } = fakePages({ read_page: [opened], read_page_changes: [changes(['h1'], ['a'])] })
    const logs: string[] = []
    await runProgram({
      program, client, pageId: 'p', store, intervalMs: 1,
      signal: new AbortController().signal, log: (l) => void logs.push(l), stopAfterEvents: 1,
    })
    expect(attempts).toBe(2)
    expect(logs.some((l) => l.includes('boom'))).toBe(true)
    expect(store.peek()?.lastEventId).toBe(eventId(['h1']))
  })

  test('calls tick every poll, even with no event, with llm/comments wired into ctx', async () => {
    const controller = new AbortController()
    const seen: { hasLlm: boolean; hasComments: boolean }[] = []
    const program = defineProgram({
      manifest: { name: 't', triggers: ['page.changed'] },
      key: (e) => e.pageId,
      handle: async () => {},
      tick: async (ctx) => {
        seen.push({ hasLlm: ctx.llm !== undefined, hasComments: typeof ctx.comments?.addBlock === 'function' })
        controller.abort()
      },
    })
    const store = memoryStore()
    const { client } = fakePages({ read_page: [opened], read_page_changes: [changes(['h0'], [])] })
    await runProgram({
      program, client, pageId: 'p', store, intervalMs: 1,
      signal: controller.signal, log: () => {}, llm: { complete: async () => 'x' },
    })
    expect(seen).toEqual([{ hasLlm: true, hasComments: true }])
  })

  test('a throwing tick does not advance the cursor until it succeeds, and does not re-run handle() for the already-seen event', async () => {
    const controller = new AbortController()
    const handledIds: string[] = []
    const savedHeadsLog: string[][] = []
    let tickCalls = 0
    const program = defineProgram({
      manifest: { name: 't', triggers: ['page.changed'] },
      key: (e) => e.pageId,
      handle: async (e) => void handledIds.push(e.id),
      tick: async () => {
        tickCalls++
        if (tickCalls < 3) throw new Error('tick boom')
        controller.abort()
      },
    })
    let saved: SavedInstance | undefined
    const store = {
      load: async () => saved,
      save: async (next: SavedInstance) => {
        saved = next
        savedHeadsLog.push(next.cursor.heads)
      },
    }
    const { client } = fakePages({ read_page: [opened], read_page_changes: [changes(['h1'], ['a'])] })
    await runProgram({
      program, client, pageId: 'p', store, intervalMs: 1,
      signal: controller.signal, log: () => {},
    })
    // handle() ran exactly once: lastEventId already matched on the retries while tick kept failing.
    expect(handledIds).toEqual([eventId(['h1'])])
    expect(tickCalls).toBe(3)
    // Only the startup persist (h0) and the final successful one (h1) happened — nothing in between,
    // i.e. the cursor was never advanced on disk while tick kept throwing.
    expect(savedHeadsLog).toEqual([['h0'], ['h1']])
  })

  test('tick that changes nothing does not persist on every poll', async () => {
    const controller = new AbortController()
    let tickCalls = 0
    const program = defineProgram({
      manifest: { name: 't', triggers: ['page.changed'] },
      key: (e) => e.pageId,
      handle: async () => {},
      tick: async () => {
        tickCalls++
        if (tickCalls >= 5) controller.abort()
      },
    })
    let saveCalls = 0
    const store = { load: async () => undefined, save: async () => void saveCalls++ }
    const { client } = fakePages({ read_page: [opened], read_page_changes: [changes(['h0'], [])] })
    await runProgram({
      program, client, pageId: 'p', store, intervalMs: 1,
      signal: controller.signal, log: () => {},
    })
    expect(tickCalls).toBe(5)
    expect(saveCalls).toBe(1) // only the initial startup persist — no event, no resync, no state mutation
  })

  test('whoami failure disables comments and presence but keeps body events', async () => {
    const seen: string[] = []
    const logs: string[] = []
    const program = defineProgram({
      manifest: { name: 't', triggers: ['page.changed'] },
      key: (e) => e.pageId,
      handle: async (e) => void seen.push(e.id),
    })
    const { client, calls } = fakePages({
      whoami: [{ status: 500, body: { code: 'request_failed', error: 'no identity' } }],
      read_page: [opened],
      read_page_changes: [changes(['h1'], ['a'])],
    })
    await runProgram({
      program, client, pageId: 'p', store: memoryStore(), intervalMs: 1,
      signal: new AbortController().signal, log: (l) => void logs.push(l), stopAfterEvents: 1,
    })
    expect(seen).toEqual([eventId(['h1'])])
    expect(calls.some((c) => c.operation === 'read_page_presence')).toBe(false)
    expect(calls.find((c) => c.operation === 'read_page_changes')?.args.comments).toBe('none')
    expect(logs.some((l) => l.includes('comment/selection watching disabled'))).toBe(true)
  })

  test('persists the selection epoch and fingerprints across a restart', async () => {
    const program = defineProgram({
      manifest: { name: 't', triggers: ['page.changed'] },
      key: (e) => e.pageId,
      handle: async () => {},
    })
    const store = memoryStore()
    const presence = {
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
    }
    await runProgram({
      program,
      client: fakePages({
        read_page: [opened],
        read_page_changes: [changes(['h0'], [])],
        read_page_presence: [presence],
      }).client,
      pageId: 'p',
      store,
      intervalMs: 1,
      signal: new AbortController().signal,
      log: () => {},
      stopAfterEvents: 1,
    })
    const saved = store.peek()
    expect(saved?.cursor.selection.epoch).toBe(1)
    expect(saved?.cursor.selection.seen['peer-1']?.blockId).toBe('b1')
  })
})
