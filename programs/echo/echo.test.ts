import { describe, expect, test } from 'bun:test'
import echo, { textDelta } from './index.ts'
import type { CommentsCapability, LlmCapability, NodeChange, PageChangedEvent, ProgramContext } from '@pages-programs/sdk'

function harness(extra?: { llm?: LlmCapability; comments?: CommentsCapability }) {
  const lines: string[] = []
  const kv: Record<string, unknown> = {}
  const ctx: ProgramContext = {
    log: (message) => void lines.push(message),
    state: {
      get: async <T>(key: string) => kv[key] as T | undefined,
      set: async (key, value) => void (kv[key] = value),
      delete: async (key) => void delete kv[key],
      list: async (prefix) => Object.keys(kv).filter((key) => key.startsWith(prefix)),
    },
    llm: extra?.llm,
    comments: extra?.comments,
  }
  return { lines, kv, ctx }
}

function fakeLlm(decide: (prompt: string) => { respond: boolean; reply?: string } | Error): LlmCapability {
  return {
    complete: async ({ prompt }) => {
      const result = decide(prompt)
      if (result instanceof Error) throw result
      return JSON.stringify(result)
    },
  }
}

function fakeComments(): CommentsCapability & { posts: { blockId: string; body: string; dedupeOn: string }[] } {
  const posts: { blockId: string; body: string; dedupeOn: string }[] = []
  return {
    posts,
    addBlock: async (input) => {
      posts.push(input)
      return { threadId: `thread-${posts.length}`, messageId: `message-${posts.length}` }
    },
  }
}

const node = (change: NodeChange['change'], markdown: string | null): NodeChange => ({
  scope: 'node',
  blockId: 'b1',
  change,
  nodeIndex: 0,
  nodeId: null,
  type: 'paragraph',
  markdown,
})

const event = (n: number, changes: NodeChange[]): PageChangedEvent => ({
  id: `p@${n}`,
  type: 'page.changed',
  at: '2026-11-09T00:00:00.000Z',
  pageId: 'p',
  title: 'T',
  titleChanged: false,
  fromHeads: [`h${n - 1}`],
  toHeads: [`h${n}`],
  changes,
})

describe('textDelta', () => {
  test('insertion, deletion and replacement', () => {
    expect(textDelta('Hello', 'Hello!')).toEqual({ removed: '', added: '!' })
    expect(textDelta('Hello world', 'Hello')).toEqual({ removed: ' world', added: '' })
    expect(textDelta('cat', 'cot')).toEqual({ removed: 'a', added: 'o' })
    expect(textDelta('a', 'a')).toEqual({ removed: '', added: '' })
  })
})

describe('echo program', () => {
  test('first sight, then deltas, from state', async () => {
    const { lines, ctx } = harness()
    await echo.handle(event(1, [node('updated', 'Hello')]), ctx)
    await echo.handle(event(2, [node('updated', 'Hello, wor')]), ctx)
    await echo.handle(event(3, [node('updated', 'Hello, world')]), ctx)
    expect(lines).toEqual([
      'first sight of paragraph: "Hello"',
      '+", wor"  → "Hello, wor"',
      '+"ld"  → "Hello, world"',
    ])
  })

  test('deleted nodes forget their text', async () => {
    const { lines, ctx } = harness()
    await echo.handle(event(1, [node('updated', 'x')]), ctx)
    await echo.handle(event(2, [node('deleted', null)]), ctx)
    await echo.handle(event(3, [node('inserted', 'x')]), ctx)
    expect(lines[1]).toBe('deleted paragraph')
    expect(lines[2]).toStartWith('first sight')
  })

  test('is keyed by page', () => {
    expect(echo.key(event(1, []))).toBe('p')
  })
})

const backdate = (kv: Record<string, unknown>, key: string, ms: number) => {
  ;(kv[key] as { changedAt: number }).changedAt = Date.now() - ms
}

describe('echo tick (reply to settled text)', () => {
  test('does nothing before the quiet period elapses', async () => {
    const { kv, ctx } = harness({ llm: fakeLlm(() => ({ respond: true, reply: 'hi' })), comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'Is this a question?')]), ctx)
    await echo.tick!(ctx)
    expect((kv['nodes/b1:0'] as { evaluatedText: string | null }).evaluatedText).toBeNull()
  })

  test('replies once when the model says yes, and not again on a repeat tick', async () => {
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: fakeLlm(() => ({ respond: true, reply: 'Yes, this works.' })), comments })
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    backdate(kv, 'nodes/b1:0', 20_000)
    await echo.tick!(ctx)
    expect(comments.posts).toEqual([{ blockId: 'b1', body: 'Yes, this works.', dedupeOn: 'Does it work?' }])
    expect((kv['nodes/b1:0'] as { evaluatedText: string | null }).evaluatedText).toBe('Does it work?')

    await echo.tick!(ctx)
    expect(comments.posts.length).toBe(1)
  })

  test('skips text below the length gate, and text the model declines', async () => {
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: fakeLlm(() => ({ respond: false })), comments })
    await echo.handle(event(1, [node('updated', 'ok')]), ctx)
    backdate(kv, 'nodes/b1:0', 20_000)
    await echo.tick!(ctx)
    expect(comments.posts).toEqual([])
    expect((kv['nodes/b1:0'] as { evaluatedText: string | null }).evaluatedText).toBeNull()

    await echo.handle(event(2, [node('updated', 'Just a statement.')]), ctx)
    backdate(kv, 'nodes/b1:0', 20_000)
    await echo.tick!(ctx)
    expect(comments.posts).toEqual([])
    expect((kv['nodes/b1:0'] as { evaluatedText: string | null }).evaluatedText).toBe('Just a statement.')
  })

  test('a further edit after answering makes the node eligible again', async () => {
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: fakeLlm(() => ({ respond: true, reply: 'answered' })), comments })
    await echo.handle(event(1, [node('updated', 'Question one?')]), ctx)
    backdate(kv, 'nodes/b1:0', 20_000)
    await echo.tick!(ctx)
    expect(comments.posts.length).toBe(1)

    await echo.handle(event(2, [node('updated', 'Question two?')]), ctx)
    expect((kv['nodes/b1:0'] as { evaluatedText: string | null }).evaluatedText).toBeNull()
    backdate(kv, 'nodes/b1:0', 20_000)
    await echo.tick!(ctx)
    expect(comments.posts.length).toBe(2)
    expect(comments.posts[1]).toMatchObject({ dedupeOn: 'Question two?' })
  })

  test('a failed model call is not marked evaluated, so the next tick retries', async () => {
    let calls = 0
    const comments = fakeComments()
    const llm = fakeLlm(() => {
      calls++
      return calls === 1 ? new Error('rate limited') : { respond: true, reply: 'ok now' }
    })
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(event(1, [node('updated', 'Will this retry?')]), ctx)
    backdate(kv, 'nodes/b1:0', 20_000)

    await echo.tick!(ctx)
    expect(comments.posts).toEqual([])
    expect((kv['nodes/b1:0'] as { evaluatedText: string | null }).evaluatedText).toBeNull()

    await echo.tick!(ctx)
    expect(comments.posts.length).toBe(1)
  })

  test('does nothing when llm/comments capabilities are not configured', async () => {
    const { kv, ctx } = harness()
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    backdate(kv, 'nodes/b1:0', 20_000)
    await echo.tick!(ctx)
    expect((kv['nodes/b1:0'] as { evaluatedText: string | null }).evaluatedText).toBeNull()
  })
})
