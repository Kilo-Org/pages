import { describe, expect, test } from 'bun:test'
import { PagesError, type PagesClient } from './client.ts'
import { readComments, readPage } from './reads.ts'

type Call = { operation: string; args: Record<string, unknown> }

function fakeClient(reply: (operation: string, args: Record<string, unknown>) => unknown) {
  const calls: Call[] = []
  const client = {
    call: async (operation: string, args: Record<string, unknown>) => {
      calls.push({ operation, args })
      return reply(operation, args)
    },
    whoami: async () => {
      throw new Error('not used')
    },
  } as unknown as PagesClient
  return { client, calls }
}

const pageBody = {
  title: 'Q4 plan',
  heads: ['h1'],
  comment_heads: ['c1'],
  blocks: [
    {
      id: 'b1',
      position: 0,
      markdown: 'Hello',
      partial: true,
      node_range: { block_id: 'b1', from: 0, to: 1 },
    },
  ],
  outline: {
    entries: [
      {
        block_id: 'b1',
        node_index: 0,
        node_id: null,
        type: 'paragraph',
        heading_path: ['Q4 plan', 'Intro'],
        heading: 'Intro',
        level: 2,
        markdown_bytes: 5,
      },
    ],
    total: 1,
    offset: 0,
    next_offset: null,
  },
  presence: {
    participants: [
      {
        peer_id: 'peer-1',
        principal: 'person-1',
        displayName: 'Sam',
        driver: 'Browser',
        last_seen: '2026-11-12T22:00:00.000Z',
        selection: {
          block_id: 'b1',
          status: 'attached',
          kind: 'selection',
          start_utf16: 0,
          end_utf16: 5,
          quote: 'Hello',
        },
      },
    ],
  },
}

const commentsBody = {
  comments: [
    {
      id: 't1',
      state: 'open',
      block_id: 'b1',
      selectionContext: { status: 'attached', text: 'Hello' },
      message_count: 2,
      messages: [
        {
          id: 'm1',
          body: 'Yes, keep both.',
          author: {
            principal: 'self',
            displayName: 'Echo',
            driver: 'agent',
            agent: { name: 'echo', model: 'test' },
          },
          createdAt: '2026-11-12T21:59:00.000Z',
          deletedAt: null,
        },
        {
          id: 'm2',
          body: 'Then tighten the rest.',
          author: { principal: 'person-1', displayName: 'Sam', driver: 'Browser' },
          createdAt: '2026-11-12T22:00:00.000Z',
          deletedAt: null,
        },
      ],
    },
  ],
}

describe('readPage', () => {
  test('maps a scoped read into typed blocks, outline, and presence', async () => {
    const { client, calls } = fakeClient(() => pageBody)
    const page = await readPage(client, 'p', {
      blockIds: ['b1'],
      includeContent: true,
      includePresence: true,
      maxBytes: 8192,
    })
    expect(calls[0]).toEqual({
      operation: 'read_page',
      args: {
        page_id: 'p',
        include_content: true,
        comments: 'none',
        block_ids: ['b1'],
        include_presence: true,
        max_bytes: 8192,
      },
    })
    expect(page).toMatchObject({
      title: 'Q4 plan',
      heads: ['h1'],
      commentHeads: ['c1'],
      blocks: [
        {
          id: 'b1',
          markdown: 'Hello',
          partial: true,
          nodeRange: { blockId: 'b1', from: 0, to: 1 },
        },
      ],
      outline: [
        {
          blockId: 'b1',
          nodeIndex: 0,
          nodeId: null,
          type: 'paragraph',
          headingPath: ['Q4 plan', 'Intro'],
          heading: 'Intro',
          level: 2,
          markdownBytes: 5,
        },
      ],
      presence: [
        {
          peerId: 'peer-1',
          principal: 'person-1',
          displayName: 'Sam',
          driver: 'Browser',
          selection: {
            blockId: 'b1',
            status: 'attached',
            kind: 'selection',
            startUtf16: 0,
            endUtf16: 5,
            quote: 'Hello',
          },
        },
      ],
    })
  })

  test('an outline-only read omits block ids and content', async () => {
    const { client, calls } = fakeClient(() => ({
      title: 'T',
      heads: ['h1'],
      blocks: [],
      outline: { entries: [], total: 0, offset: 0, next_offset: null },
      presence: { participants: [] },
    }))
    const page = await readPage(client, 'p', { includeContent: false })
    expect(calls[0]?.args).toEqual({
      page_id: 'p',
      include_content: false,
      comments: 'none',
    })
    expect(page.blocks).toEqual([])
    expect(page.presence).toEqual([])
  })
})

describe('readComments', () => {
  test('a thread read marks the host own messages and maps the selection', async () => {
    const { client, calls } = fakeClient(() => commentsBody)
    const threads = await readComments(
      client,
      'p',
      { threadIds: ['t1'], state: 'all', includeMessages: true },
      { ownPrincipal: 'self' },
    )
    expect(calls[0]).toEqual({
      operation: 'list_page_comments',
      args: {
        page_id: 'p',
        state: 'all',
        include_messages: true,
        thread_ids: ['t1'],
      },
    })
    expect(threads[0]).toMatchObject({
      id: 't1',
      state: 'open',
      blockId: 'b1',
      selection: { text: 'Hello' },
      messageCount: 2,
    })
    expect(threads[0]?.messages.map((message) => message.isSelf)).toEqual([true, false])
    expect(threads[0]?.messages[0]?.author).toMatchObject({
      principal: 'self',
      displayName: 'Echo',
      driver: 'agent',
      agent: { name: 'echo', model: 'test' },
    })
  })

  test('a block read scopes by block, never by thread', async () => {
    const { client, calls } = fakeClient(() => commentsBody)
    await readComments(client, 'p', { blockId: 'b1' }, { ownPrincipal: 'self' })
    expect(calls[0]?.args).toMatchObject({
      page_id: 'p',
      state: 'open',
      include_messages: true,
      block_id: 'b1',
    })
    expect(calls[0]?.args.thread_ids).toBeUndefined()
  })

  test('detached selection context is not passed on as a quote', async () => {
    const { client } = fakeClient(() => ({
      comments: [
        {
          id: 't1',
          state: 'open',
          block_id: 'b1',
          selectionContext: { status: 'detached' },
          message_count: 0,
          messages: [],
        },
      ],
    }))
    const [thread] = await readComments(client, 'p', { blockId: 'b1' })
    expect(thread?.selection).toBeNull()
  })

  test('a budget failure surfaces as a typed error the gather can retry', async () => {
    const { client } = fakeClient(() => {
      throw new PagesError(413, 'read_budget_exceeded', 'too big', {})
    })
    await expect(readPage(client, 'p', { blockIds: ['b1'] })).rejects.toMatchObject({
      code: 'read_budget_exceeded',
    })
  })
})
