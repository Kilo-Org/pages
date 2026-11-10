import { describe, expect, test } from 'bun:test'
import echo, { attempt, looksComplete, SPECULATIVE_PAUSE_MS, textDelta } from './index.ts'
import type { CommentsCapability, LlmCapability, NodeChange, PageChangedEvent, ProgramContext } from '@pages-programs/sdk'

function harness(extra?: { llm?: LlmCapability; comments?: CommentsCapability }) {
  const lines: string[] = []
  const kv: Record<string, unknown> = {}
  const scratch = new Map<string, unknown>()
  const ctx: ProgramContext = {
    log: (message) => void lines.push(message),
    state: {
      get: async <T>(key: string) => kv[key] as T | undefined,
      set: async (key, value) => void (kv[key] = value),
      delete: async (key) => void delete kv[key],
      list: async (prefix) => Object.keys(kv).filter((key) => key.startsWith(prefix)),
    },
    scratch: {
      get: <T>(key: string) => scratch.get(key) as T | undefined,
      set: (key, value) => void scratch.set(key, value),
      delete: (key) => void scratch.delete(key),
    },
    llm: extra?.llm,
    comments: extra?.comments,
  }
  return { lines, kv, scratch, ctx }
}

/** Resolves (or rejects) immediately — for tests that don't care about in-flight timing. */
function fakeLlm(decide: (prompt: string) => { respond: boolean; reply?: string } | Error): LlmCapability {
  return {
    complete: async ({ prompt }) => {
      const result = decide(prompt)
      if (result instanceof Error) throw result
      return JSON.stringify(result)
    },
  }
}

/**
 * Each call() gets its own independently-resolvable promise (doesn't resolve until the
 * test calls `resolve()`, by default the most recent call; rejects with a real AbortError
 * if its own signal fires first) — so a test can have two overlapping calls in flight and
 * settle them independently, instead of one shared resolution affecting every call.
 */
function deferredLlm() {
  const pending: { resolve: (value: { respond: boolean; reply?: string }) => void }[] = []
  let promptSeen: string | undefined
  const llm: LlmCapability = {
    complete: ({ prompt, signal }) => {
      promptSeen = prompt
      return new Promise<string>((resolve, reject) => {
        pending.push({ resolve: (v) => resolve(JSON.stringify(v)) })
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    },
  }
  return {
    llm,
    resolve: (value: { respond: boolean; reply?: string }, callIndex = pending.length - 1) => pending[callIndex]?.resolve(value),
    get calls() {
      return pending.length
    },
    get promptSeen() {
      return promptSeen
    },
  }
}

function fakeComments(): CommentsCapability & {
  posts: { blockId: string; body: string; dedupeOn: string }[]
  edits: { threadId: string; messageId: string; body: string; dedupeOn: string }[]
} {
  const posts: { blockId: string; body: string; dedupeOn: string }[] = []
  const edits: { threadId: string; messageId: string; body: string; dedupeOn: string }[] = []
  return {
    posts,
    edits,
    addBlock: async (input) => {
      posts.push(input)
      return { threadId: `thread-${posts.length}`, messageId: `message-${posts.length}` }
    },
    editMessage: async (input) => {
      edits.push(input)
      return { threadId: input.threadId, messageId: input.messageId }
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

const backdate = (kv: Record<string, unknown>, key: string, ms: number) => {
  ;(kv[key] as { changedAt: number }).changedAt = Date.now() - ms
}

/** Lets a fire-and-forget promise chain (tick() never awaits attempt()) fully settle before asserting. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('textDelta', () => {
  test('insertion, deletion and replacement', () => {
    expect(textDelta('Hello', 'Hello!')).toEqual({ removed: '', added: '!' })
    expect(textDelta('Hello world', 'Hello')).toEqual({ removed: ' world', added: '' })
    expect(textDelta('cat', 'cot')).toEqual({ removed: 'a', added: 'o' })
    expect(textDelta('a', 'a')).toEqual({ removed: '', added: '' })
  })
})

describe('looksComplete', () => {
  test('ends with sentence-ending punctuation, trailing whitespace tolerated', () => {
    expect(looksComplete('Does it work?')).toBe(true)
    expect(looksComplete('This is done.')).toBe(true)
    expect(looksComplete('Wow!')).toBe(true)
    expect(looksComplete('Does it work?  ')).toBe(true)
    expect(looksComplete('Does it work?\n')).toBe(true)
  })

  test('no trailing punctuation, or still mid-word/mid-sentence', () => {
    expect(looksComplete('still thinking out loud')).toBe(false)
    expect(looksComplete('what is the capital of france')).toBe(false)
    expect(looksComplete('')).toBe(false)
    expect(looksComplete('wait, actually')).toBe(false)
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

  test('a stale pre-upgrade state value (a plain string) is treated as unseen, not a crash', async () => {
    const { lines, kv, ctx } = harness()
    kv['nodes/b1:0'] = 'Hello' // the old state shape, before NodeRecord existed
    await echo.handle(event(1, [node('updated', 'Hello world')]), ctx)
    expect(lines).toEqual(['first sight of paragraph: "Hello world"'])
    expect(kv['nodes/b1:0']).toMatchObject({ text: 'Hello world', evaluatedText: null, failures: 0 })
  })
})

describe('echo tick — speculative scheduling (Part A)', () => {
  test('does not start a draft before the pause elapses, for text with no completeness signal', async () => {
    const d = deferredLlm()
    const { ctx } = harness({ llm: d.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'still thinking out loud')]), ctx)
    await echo.tick!(ctx)
    await flush()
    expect(d.calls).toBe(0)
  })

  test('starts a draft after a short pause, well under the old 8s quiet period', async () => {
    const d = deferredLlm()
    const { kv, ctx } = harness({ llm: d.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'still thinking out loud')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await flush()
    expect(d.calls).toBe(1)
    expect(d.promptSeen).toBe('still thinking out loud')
  })

  test('skips the pause entirely for text that already looks sentence-complete', async () => {
    const d = deferredLlm()
    const { ctx } = harness({ llm: d.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    await echo.tick!(ctx) // no backdate — this is the whole point
    await flush()
    expect(d.calls).toBe(1)
    expect(d.promptSeen).toBe('Does it work?')
  })

  test('commits immediately once a matching draft resolves — no further wait', async () => {
    const d = deferredLlm()
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: d.llm, comments })
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    d.resolve({ respond: true, reply: 'Yes.' })
    await flush()
    expect(comments.posts).toEqual([{ blockId: 'b1', body: 'Yes.', dedupeOn: 'Does it work?' }])
    expect((kv['nodes/b1:0'] as { evaluatedText: string | null }).evaluatedText).toBe('Does it work?')
  })

  test('a text change before the draft resolves aborts it — nothing posts even once it later settles', async () => {
    const d = deferredLlm()
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: d.llm, comments })
    // No trailing punctuation on either text: neither looks complete, so this stays on the
    // pause-based path and no second draft starts right after the edit (kept separate from
    // the looksComplete+abort interaction, covered below).
    await echo.handle(event(1, [node('updated', 'still thinking about this')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await flush()
    expect(d.calls).toBe(1)

    // New input arrives before the draft resolved — handle() aborts it directly.
    await echo.handle(event(2, [node('updated', 'still thinking about this some more')]), ctx)
    await echo.tick!(ctx)
    await flush()

    // Even if the stale draft "resolves" after being aborted, nothing should post for it.
    d.resolve({ respond: true, reply: 'stale answer' })
    await flush()
    expect(comments.posts).toEqual([])
  })

  test('a correction that itself looks complete starts a second draft immediately, and only the final one can ever post', async () => {
    const d = deferredLlm()
    const comments = fakeComments()
    const { ctx } = harness({ llm: d.llm, comments })
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    await echo.tick!(ctx) // looksComplete — starts immediately, no backdate needed
    await flush()
    expect(d.calls).toBe(1)

    // Corrected before the first draft resolved — also looks complete, so a second draft
    // starts right away rather than waiting out a pause.
    await echo.handle(event(2, [node('updated', 'Does it actually work?')]), ctx)
    await echo.tick!(ctx)
    await flush()
    expect(d.calls).toBe(2)

    // Resolving the stale first call does nothing — it was aborted.
    d.resolve({ respond: true, reply: 'stale answer' }, 0)
    await flush()
    expect(comments.posts).toEqual([])

    // Resolving the second (legitimate) call posts, for the final text only.
    d.resolve({ respond: true, reply: 'real answer' }, 1)
    await flush()
    expect(comments.posts).toEqual([{ blockId: 'b1', body: 'real answer', dedupeOn: 'Does it actually work?' }])
  })

  test('only one draft runs per node at a time', async () => {
    const d = deferredLlm()
    const { kv, ctx } = harness({ llm: d.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await echo.tick!(ctx) // same, still-matching text — must not start a second call
    await flush()
    expect(d.calls).toBe(1)
  })

  test('skips text below the length gate — never asks the model', async () => {
    const d = deferredLlm()
    const { kv, ctx } = harness({ llm: d.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'ok')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await flush()
    expect(d.calls).toBe(0)
  })

  test('a decline is recorded as evaluated (not re-asked), and nothing posts', async () => {
    const comments = fakeComments()
    const llm = fakeLlm(() => ({ respond: false }))
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(event(1, [node('updated', 'Just a statement.')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await flush()
    expect(comments.posts).toEqual([])
    expect((kv['nodes/b1:0'] as { evaluatedText: string | null }).evaluatedText).toBe('Just a statement.')

    await echo.tick!(ctx)
    await flush()
    expect(comments.posts).toEqual([]) // still nothing — not re-asked
  })

  test('does nothing when llm/comments capabilities are not configured', async () => {
    const { kv, ctx } = harness()
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    expect((kv['nodes/b1:0'] as { evaluatedText: string | null }).evaluatedText).toBeNull()
  })

  test('a further edit after a reply updates the same thread in place, end to end', async () => {
    const comments = fakeComments()
    let replyCount = 0
    const llm = fakeLlm(() => {
      replyCount++
      return replyCount === 1 ? { respond: true, reply: 'First answer.' } : { respond: true, reply: 'Updated answer.' }
    })
    const { kv, ctx } = harness({ llm, comments })

    await echo.handle(event(1, [node('updated', 'Question one?')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await flush()
    expect(comments.posts).toEqual([{ blockId: 'b1', body: 'First answer.', dedupeOn: 'Question one?' }])
    expect(comments.edits).toEqual([])

    await echo.handle(event(2, [node('updated', 'Question two?')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await flush()
    expect(comments.posts.length).toBe(1) // no second thread
    expect(comments.edits).toEqual([{ threadId: 'thread-1', messageId: 'message-1', body: 'Updated answer.', dedupeOn: 'Question two?' }])
  })
})

describe('echo tick — backoff after a genuine failure', () => {
  test('repeated failures back off for longer each time', async () => {
    const comments = fakeComments()
    const llm = fakeLlm(() => new Error('still down'))
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(event(1, [node('updated', 'Will this ever work?')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    const record = () => kv['nodes/b1:0'] as { failures: number; lastAttemptAt: number }

    await echo.tick!(ctx)
    await flush() // failures: 0 -> 1, backoff ~SPECULATIVE_PAUSE_MS
    expect(record().failures).toBe(1)

    record().lastAttemptAt = Date.now() // immediately again — still within backoff
    await echo.tick!(ctx)
    await flush()
    expect(record().failures).toBe(1)

    record().lastAttemptAt = Date.now() - (SPECULATIVE_PAUSE_MS + 500) // past the first backoff window
    await echo.tick!(ctx)
    await flush() // failures: 1 -> 2, backoff doubles
    expect(record().failures).toBe(2)

    record().lastAttemptAt = Date.now() - (SPECULATIVE_PAUSE_MS + 500) // past the 1st-level window, not the 2nd
    await echo.tick!(ctx)
    await flush()
    expect(record().failures).toBe(2) // still gated

    record().lastAttemptAt = Date.now() - (SPECULATIVE_PAUSE_MS * 2 + 500)
    await echo.tick!(ctx)
    await flush()
    expect(record().failures).toBe(3)
  })
})

describe('attempt() — commit fence, and first reply vs. correction (Part A fence + Part B)', () => {
  function record(overrides: Partial<Parameters<typeof attempt>[1]>) {
    return {
      blockId: 'b1',
      text: 'placeholder',
      changedAt: Date.now(),
      evaluatedText: null,
      failures: 0,
      lastAttemptAt: 0,
      threadId: null,
      messageId: null,
      lastReply: null,
      ...overrides,
    }
  }

  test('discards a resolved draft if the text moved on since it started, even without an explicit abort', async () => {
    const comments = fakeComments()
    const llm = fakeLlm(() => ({ respond: true, reply: 'stale answer' }))
    const { ctx } = harness({ llm, comments })
    const base = record({ text: 'Original question?' })
    await ctx.state.set('nodes/b1:0', record({ text: 'A completely different question now' }))
    await attempt('nodes/b1:0', base, ctx, new AbortController().signal)
    expect(comments.posts).toEqual([])
  })

  test('first reply creates a new thread', async () => {
    const comments = fakeComments()
    const llm = fakeLlm(() => ({ respond: true, reply: 'Yes, this works.' }))
    const { ctx } = harness({ llm, comments })
    const base = record({ text: 'Does it work?' })
    await ctx.state.set('nodes/b1:0', base)
    await attempt('nodes/b1:0', base, ctx, new AbortController().signal)
    expect(comments.posts).toEqual([{ blockId: 'b1', body: 'Yes, this works.', dedupeOn: 'Does it work?' }])
    expect(comments.edits).toEqual([])
    const saved = await ctx.state.get('nodes/b1:0')
    expect(saved).toMatchObject({ threadId: 'thread-1', messageId: 'message-1', lastReply: 'Yes, this works.', evaluatedText: 'Does it work?' })
  })

  test('a correction after a reply edits the same thread/message, not a new one', async () => {
    const comments = fakeComments()
    const llm = fakeLlm((prompt) => {
      expect(prompt).toContain('Yes, this works.') // the follow-up prompt includes the prior reply
      return { respond: true, reply: 'Yes, definitely.' }
    })
    const { ctx } = harness({ llm, comments })
    const base = record({ text: 'Does it really work?', threadId: 'thread-1', messageId: 'message-1', lastReply: 'Yes, this works.' })
    await ctx.state.set('nodes/b1:0', base)
    await attempt('nodes/b1:0', base, ctx, new AbortController().signal)
    expect(comments.posts).toEqual([])
    expect(comments.edits).toEqual([{ threadId: 'thread-1', messageId: 'message-1', body: 'Yes, definitely.', dedupeOn: 'Does it really work?' }])
    const saved = await ctx.state.get('nodes/b1:0')
    expect(saved).toMatchObject({ lastReply: 'Yes, definitely.', threadId: 'thread-1', messageId: 'message-1' })
  })

  test('a follow-up deciding not to update leaves the existing reply untouched', async () => {
    const comments = fakeComments()
    const llm = fakeLlm(() => ({ respond: false }))
    const { ctx } = harness({ llm, comments })
    const base = record({
      text: 'Does it really work? Yes I think so.',
      threadId: 'thread-1',
      messageId: 'message-1',
      lastReply: 'Yes, this works.',
    })
    await ctx.state.set('nodes/b1:0', base)
    await attempt('nodes/b1:0', base, ctx, new AbortController().signal)
    expect(comments.posts).toEqual([])
    expect(comments.edits).toEqual([])
    const saved = await ctx.state.get('nodes/b1:0')
    expect(saved).toMatchObject({ threadId: 'thread-1', messageId: 'message-1', lastReply: 'Yes, this works.', evaluatedText: base.text })
  })

  test('a genuine failure on the edit path backs off the same way as on the add path', async () => {
    const comments: CommentsCapability = {
      addBlock: async () => ({ threadId: 'x', messageId: 'y' }),
      editMessage: async () => {
        throw new Error('pages api down')
      },
    }
    const llm = fakeLlm(() => ({ respond: true, reply: 'update' }))
    const { ctx } = harness({ llm, comments })
    const base = record({ text: 'new text', threadId: 'thread-1', messageId: 'message-1', lastReply: 'old reply' })
    await ctx.state.set('nodes/b1:0', base)
    await attempt('nodes/b1:0', base, ctx, new AbortController().signal)
    const saved = await ctx.state.get('nodes/b1:0')
    expect(saved).toMatchObject({ failures: 1, evaluatedText: null }) // not marked evaluated — will retry
  })

  test('an aborted attempt is not recorded as a failure', async () => {
    const comments = fakeComments()
    const controller = new AbortController()
    const llm: LlmCapability = {
      complete: async () => {
        throw new DOMException('aborted', 'AbortError')
      },
    }
    const { ctx } = harness({ llm, comments })
    const base = record({ text: 'x' })
    await ctx.state.set('nodes/b1:0', base)
    await attempt('nodes/b1:0', base, ctx, controller.signal)
    const saved = await ctx.state.get('nodes/b1:0')
    expect(saved).toEqual(base) // untouched — abort isn't a failure
  })
})
