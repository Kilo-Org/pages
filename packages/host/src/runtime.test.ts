import { describe, expect, test } from 'bun:test'
import { bearerAuth, createPagesClient } from '@pages-programs/pages'
import { pollPage } from '@pages-programs/pages'
import { defineProgram } from '@pages-programs/sdk'
import { runProgram, type SavedInstance } from './runtime.ts'

type Reply = { status?: number; body: unknown }

function fakePages(replies: Record<string, Reply[]>) {
  const calls: { operation: string; args: Record<string, unknown> }[] = []
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { operation, arguments: args } = JSON.parse(String(init?.body))
    calls.push({ operation, args })
    const queue = replies[operation]
    const reply = queue && queue.length > 1 ? queue.shift()! : queue?.[0]
    if (!reply) throw new Error(`no scripted reply for ${operation}`)
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }) as typeof fetch
  const client = createPagesClient({ origin: 'http://pages.test', auth: bearerAuth('t'), fetch: fakeFetch })
  return { client, calls }
}

const changes = (heads: string[], texts: string[]) => ({
  body: {
    heads,
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
    const result = await pollPage(client, 'p', { heads: ['h0'], title: 'T' }, () => new Date(0))
    expect(result.event).toMatchObject({
      id: 'p@h1',
      type: 'page.changed',
      fromHeads: ['h0'],
      toHeads: ['h1'],
      changes: [{ scope: 'node', markdown: 'Hi' }],
    })
    expect(result.cursor.heads).toEqual(['h1'])
  })

  test('unchanged heads produce no event', async () => {
    const { client } = fakePages({ read_page_changes: [changes(['h0'], [])] })
    const result = await pollPage(client, 'p', { heads: ['h0'], title: 'T' })
    expect(result.event).toBeNull()
  })

  test('unknown heads resync to current heads instead of failing', async () => {
    const { client } = fakePages({
      read_page_changes: [{ status: 409, body: { code: 'resync_required', error: 'unknown history' } }],
      read_page: [{ body: { title: 'T', heads: ['h9'] } }],
    })
    const result = await pollPage(client, 'p', { heads: ['h0'], title: 'T' })
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
    expect(seen).toEqual(['p@h1', 'p@h2'])
    expect(second.calls[0]?.args.since_heads).toEqual(['h1'])
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
    expect(store.peek()?.lastEventId).toBe('p@h1')
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
})
