import { describe, expect, test } from 'bun:test'
import type {
  PageRead,
  PageReadInput,
  CommentReadInput,
  ProgramContext,
  ThreadRead,
} from '@pages-programs/sdk'
import { gatherContext } from './gather.ts'

const pageRead = (): PageRead => ({
  title: 'T',
  heads: ['h1'],
  commentHeads: ['c1'],
  blocks: [{ id: 'b1', markdown: 'Hello' }],
  outline: [
    {
      blockId: 'b1',
      nodeIndex: 0,
      nodeId: null,
      type: 'paragraph',
      headingPath: ['T', 'Intro'],
      markdownBytes: 5,
    },
  ],
  presence: [],
})

const threadRead = (): ThreadRead => ({
  id: 't1',
  state: 'open',
  blockId: 'b1',
  selection: null,
  messageCount: 1,
  messages: [],
})

type Calls = {
  page: PageReadInput[]
  comments: CommentReadInput[]
}

function gatherHarness(options: {
  page?: (input: PageReadInput, call: number) => PageRead
  comments?: (input: CommentReadInput) => ThreadRead[]
} = {}) {
  const calls: Calls = { page: [], comments: [] }
  const logs: string[] = []
  const scratch = new Map<string, unknown>()
  const ctx: ProgramContext = {
    pageId: 'p',
    log: (message) => void logs.push(message),
    state: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    },
    scratch: {
      get: <T>(key: string) => scratch.get(key) as T | undefined,
      set: (key, value) => void scratch.set(key, value),
      delete: (key) => void scratch.delete(key),
    },
    reads: {
      page: async (input = {}) => {
        calls.page.push(input)
        return options.page ? options.page(input, calls.page.length) : pageRead()
      },
      comments: async (input = {}) => {
        calls.comments.push(input)
        return options.comments ? options.comments(input) : [threadRead()]
      },
    },
  }
  return { ctx, calls, logs, scratch }
}

describe('gatherContext', () => {
  test('a body trigger reads the block and open threads on it', async () => {
    const { ctx, calls } = gatherHarness()
    const gathered = await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'body',
      blockId: 'b1',
      threadId: 't1',
      key: 'trigger',
    })
    expect(gathered.page?.title).toBe('T')
    expect(gathered.threads).toHaveLength(1)
    expect(gathered.degraded).toBe(false)
    expect(calls.page[0]).toMatchObject({
      blockIds: ['b1'],
      includeContent: true,
      includePresence: true,
    })
    expect(calls.comments).toHaveLength(2)
    expect(calls.comments[0]).toMatchObject({
      threadIds: ['t1'],
      state: 'all',
      includeMessages: true,
    })
    expect(calls.comments[1]).toMatchObject({
      blockId: 'b1',
      state: 'open',
      includeMessages: true,
    })
    expect(gathered.threads).toHaveLength(1)
  })

  test('a comment trigger reads the thread, not every open thread on the block', async () => {
    const { ctx, calls } = gatherHarness()
    await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'comment',
      blockId: 'b1',
      threadId: 't1',
      key: 'm1',
    })
    expect(calls.page[0]).toMatchObject({ blockIds: ['b1'], includeContent: true })
    expect(calls.comments[0]).toMatchObject({
      threadIds: ['t1'],
      state: 'all',
      includeMessages: true,
    })
    expect(calls.comments[0]?.blockId).toBeUndefined()
  })

  test('a budget failure retries the page outline and thread summaries', async () => {
    const { ctx, calls, logs } = gatherHarness({
      page: (_input, call) => {
        if (call === 1) throw Object.assign(new Error('too big'), { code: 'read_budget_exceeded' })
        return { ...pageRead(), blocks: [] }
      },
      comments: (input) => {
        if (input.includeMessages) throw Object.assign(new Error('too big'), { code: 'read_budget_exceeded' })
        return [threadRead()]
      },
    })
    const gathered = await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'body',
      blockId: 'b1',
      threadId: null,
      key: 'trigger',
    })
    expect(gathered.degraded).toBe(true)
    expect(gathered.page?.blocks).toEqual([])
    expect(calls.page[0]?.includeContent).toBe(true)
    expect(calls.page[1]?.includeContent).toBe(false)
    expect(calls.comments[0]?.includeMessages).toBe(true)
    expect(calls.comments[1]?.includeMessages).toBe(false)
    expect(logs.some((line) => line.includes('exceeded its budget'))).toBe(true)
  })

  test('a generic read failure degrades instead of throwing', async () => {
    const { ctx, logs } = gatherHarness({
      page: () => {
        throw new Error('network down')
      },
      comments: () => {
        throw new Error('network down')
      },
    })
    const gathered = await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'body',
      blockId: 'b1',
      threadId: null,
      key: 'trigger',
    })
    expect(gathered).toEqual({ page: null, threads: [], degraded: true })
    expect(logs.filter((line) => line.includes('context reads degraded'))).toHaveLength(1)
  })

  test('without a reads capability the program still runs', async () => {
    const { ctx } = gatherHarness()
    delete ctx.reads
    const gathered = await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'body',
      blockId: 'b1',
      threadId: null,
      key: 'trigger',
    })
    expect(gathered).toEqual({ page: null, threads: [], degraded: false })
  })

  test('a blockless comment still reads the page outline', async () => {
    const { ctx, calls } = gatherHarness()
    const gathered = await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'comment',
      blockId: null,
      threadId: 't1',
      key: 'm1',
    })
    expect(gathered.page?.title).toBe('T')
    expect(calls.page[0]).toMatchObject({ includeContent: false, includePresence: true })
    expect(calls.page[0]?.blockIds).toBeUndefined()
    expect(calls.comments[0]).toMatchObject({ threadIds: ['t1'], state: 'all' })
  })

  test('reads a resolved target thread with state all', async () => {
    const resolved = { ...threadRead(), state: 'resolved' }
    const { ctx, calls } = gatherHarness({
      comments: (input) => (input.threadIds ? [resolved] : []),
    })
    const gathered = await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'body',
      blockId: 'b1',
      threadId: 't1',
      key: 'trigger',
    })
    expect(calls.comments[0]).toMatchObject({ threadIds: ['t1'], state: 'all' })
    expect(gathered.threads[0]?.state).toBe('resolved')
  })

  test('a slow read times out and degrades instead of hanging', async () => {
    const logs: string[] = []
    const scratch = new Map<string, unknown>()
    const ctx: ProgramContext = {
      pageId: 'p',
      log: (message) => void logs.push(message),
      state: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
      scratch: {
        get: <T>(key: string) => scratch.get(key) as T | undefined,
        set: (key, value) => void scratch.set(key, value),
        delete: (key) => void scratch.delete(key),
      },
      reads: {
        page: ({ signal } = {}) =>
          new Promise<PageRead>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            })
          }),
        comments: async () => [],
      },
    }
    const gathered = await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'body',
      blockId: 'b1',
      threadId: null,
      key: 'slow',
      timeoutMs: 20,
    })
    expect(gathered.page).toBeNull()
    expect(gathered.degraded).toBe(true)
    expect(logs.some((line) => line.includes('timed out'))).toBe(true)
  })

  test('a caller abort skips the reads', async () => {
    const { ctx, calls } = gatherHarness()
    const controller = new AbortController()
    controller.abort()
    const gathered = await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'body',
      blockId: 'b1',
      threadId: null,
      key: 'aborted',
      signal: controller.signal,
    })
    expect(gathered).toEqual({ page: null, threads: [], degraded: false })
    expect(calls.page).toHaveLength(0)
    expect(calls.comments).toHaveLength(0)
  })

  test('caches the same trigger for a short window', async () => {
    const { ctx, calls } = gatherHarness()
    await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'body',
      blockId: 'b1',
      threadId: null,
      key: 'same',
    })
    await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'body',
      blockId: 'b1',
      threadId: null,
      key: 'same',
    })
    expect(calls.page).toHaveLength(1)
    expect(calls.comments).toHaveLength(1)

    await gatherContext({
      ctx,
      pageId: 'p',
      surface: 'body',
      blockId: 'b1',
      threadId: null,
      key: 'different',
    })
    expect(calls.page).toHaveLength(2)
  })
})
