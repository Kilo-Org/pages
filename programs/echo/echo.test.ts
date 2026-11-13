import { describe, expect, test } from 'bun:test'
import echo, { attempt, looksComplete, SPECULATIVE_PAUSE_MS, textDelta } from './index.ts'
import type { RoomState, TargetState } from './room.ts'
import { TRIAGE_SYSTEM_PROMPT } from './triage.ts'
import type {
  BodyChange,
  CommentsCapability,
  LlmCapability,
  PageChange,
  PageChangedEvent,
  PageRead,
  PresenceCapability,
  ProgramContext,
  ReadsCapability,
  ThreadRead,
} from '@pages-programs/sdk'

function harness(extra?: {
  llm?: LlmCapability
  comments?: CommentsCapability
  presence?: PresenceCapability
  reads?: ReadsCapability
  ownPrincipal?: string
}) {
  const lines: string[] = []
  const kv: Record<string, unknown> = {}
  const scratch = new Map<string, unknown>()
  const ctx: ProgramContext = {
    pageId: 'p',
    ownPrincipal: extra?.ownPrincipal,
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
    presence: extra?.presence,
    reads: extra?.reads,
  }
  return { lines, kv, scratch, ctx }
}

function fakePresence(): PresenceCapability & { shown: string[] } {
  const shown: string[] = []
  return {
    shown,
    showReading: async (blockId) => void shown.push(blockId),
  }
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
type DecisionValue = {
  respond: boolean
  reply?: string
  completed?: boolean
  completedTasks?: string[]
}

function deferredLlm() {
  const pending: { resolve: (value: DecisionValue) => void }[] = []
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
    resolve: (value: DecisionValue, callIndex = pending.length - 1) =>
      pending[callIndex]?.resolve(value),
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
  replies: { threadId: string; body: string; dedupeOn: string }[]
} {
  const posts: { blockId: string; body: string; dedupeOn: string }[] = []
  const edits: { threadId: string; messageId: string; body: string; dedupeOn: string }[] = []
  const replies: { threadId: string; body: string; dedupeOn: string }[] = []
  return {
    posts,
    edits,
    replies,
    addBlock: async (input) => {
      posts.push(input)
      return { threadId: `thread-${posts.length}`, messageId: `message-${posts.length}` }
    },
    editMessage: async (input) => {
      edits.push(input)
      return { threadId: input.threadId, messageId: input.messageId }
    },
    replyToThread: async (input) => {
      replies.push(input)
      return { threadId: input.threadId, messageId: `reply-${replies.length}` }
    },
  }
}

/** The model prompt starts with a trust line, then the JSON envelope. */
const envelopeOf = (prompt: string | undefined) => {
  if (!prompt) throw new Error('no prompt was recorded')
  const start = prompt.indexOf('{')
  return JSON.parse(prompt.slice(start)) as {
    task: {
      purpose: string
      surface: string
      instruction: string
      intent: { kind: string | null; version: number | null; step: unknown }
      previousReply: string | null
      plan?: { key: string; description: string; status: string }[]
    }
    context: {
      trigger: {
        text: string
        previousText: string | null
        threadId: string | null
        blockId: string | null
      }
      page: {
        title: string | null
        block: { headingPath: string[]; markdown: string | null; type: string | null } | null
        outline: { heading: string; level: number; blockId: string }[]
      }
      thread: {
        id: string
        messages: { author: string; body: string }[]
      } | null
      openThreads: { id: string; messages: { author: string; body: string }[] }[]
      timeline: { hot: { summary: string }[]; warm: string | null } | null
      presence: unknown[]
    }
  }
}

const pageRead = (overrides: Partial<PageRead> = {}): PageRead => ({
  title: 'Q4 plan',
  heads: ['h1'],
  commentHeads: ['c1'],
  blocks: [
    {
      id: 'b1',
      markdown: 'Please tighten the budget paragraph but keep the two examples.',
    },
  ],
  outline: [
    {
      blockId: 'b1',
      nodeIndex: 0,
      nodeId: null,
      type: 'paragraph',
      headingPath: ['Q4 plan', 'Budget'],
      heading: 'Budget',
      level: 2,
      markdownBytes: 58,
    },
  ],
  presence: [
    {
      peerId: 'peer-other',
      principal: 'person-1',
      displayName: 'Sam',
      driver: 'Browser',
      lastSeen: new Date().toISOString(),
      selection: {
        blockId: 'b1',
        status: 'attached',
        kind: 'selection',
        startUtf16: 0,
        endUtf16: 6,
        quote: 'budget',
      },
    },
    {
      peerId: 'peer-self',
      principal: 'self',
      displayName: 'Echo',
      driver: 'agent',
      lastSeen: new Date().toISOString(),
      selection: {
        blockId: 'b1',
        status: 'attached',
        kind: 'caret',
        startUtf16: 0,
        endUtf16: 0,
        quote: null,
      },
    },
  ],
  ...overrides,
})

const threadRead = (overrides: Partial<ThreadRead> = {}): ThreadRead => ({
  id: 't1',
  state: 'open',
  blockId: 'b1',
  selection: { text: 'the two examples' },
  messageCount: 2,
  messages: [
    {
      id: 'm0',
      body: 'Should we keep the examples?',
      author: {
        principal: 'person-1',
        displayName: 'Sam',
        driver: 'Browser',
        agent: null,
      },
      createdAt: '2026-11-12T21:58:00.000Z',
      deletedAt: null,
      isSelf: false,
    },
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
      isSelf: true,
    },
  ],
  ...overrides,
})

function fakeReads(options: {
  page?: PageRead
  threads?: ThreadRead[]
  fail?: boolean
} = {}) {
  const counters = { page: 0, comments: 0 }
  const reads: ReadsCapability = {
    page: async () => {
      counters.page++
      if (options.fail) throw new Error('read unavailable')
      return options.page ?? pageRead()
    },
    comments: async () => {
      counters.comments++
      if (options.fail) throw new Error('read unavailable')
      return options.threads ?? [threadRead()]
    },
  }
  return { reads, counters }
}

const node = (change: BodyChange['change'], markdown: string | null): BodyChange => ({
  surface: 'body',
  scope: 'node',
  blockId: 'b1',
  change,
  nodeIndex: 0,
  nodeId: null,
  type: 'paragraph',
  markdown,
  actorKind: 'unknown',
  priority: 2,
})

const nodeAt = (blockId: string, markdown: string): BodyChange => ({
  ...node('updated', markdown),
  blockId,
})

const event = (n: number, changes: PageChange[]): PageChangedEvent => ({
  id: `p@${n}+c:+s:0`,
  type: 'page.changed',
  at: '2026-11-09T00:00:00.000Z',
  pageId: 'p',
  title: 'T',
  titleChanged: false,
  fromHeads: [`h${n - 1}`],
  toHeads: [`h${n}`],
  fromCommentHeads: null,
  toCommentHeads: null,
  selectionEpoch: 0,
  changes,
})

const targetOf = (kv: Record<string, unknown>, key = 'nodes/b1:0') => {
  const room = kv.room as RoomState | undefined
  return (room?.targets[key] ?? kv[key]) as TargetState | undefined
}

const savedTarget = async (ctx: ProgramContext, key = 'nodes/b1:0') => {
  const room = await ctx.state.get<RoomState>('room')
  return room?.targets[key] ?? (await ctx.state.get<TargetState>(key))
}

const backdate = (kv: Record<string, unknown>, key: string, ms: number) => {
  const target = targetOf(kv, key)
  if (target) target.changedAt = Date.now() - ms
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
    expect(targetOf(kv)).toMatchObject({ text: 'Hello world', evaluatedText: null, failures: 0 })
  })

  test('logs comment changes without treating them as node text', async () => {
    const { lines, kv, ctx } = harness()
    await echo.handle(
      event(1, [
        {
          surface: 'comment',
          change: 'inserted',
          threadId: 't1',
          messageId: 'm1',
          blockId: 'b1',
          body: 'Can you tighten this?',
          authorPrincipal: 'person-1',
          authorDisplayName: 'Person',
          driver: 'Browser',
          actorKind: 'person',
          priority: 1,
        },
      ]),
      ctx,
    )
    expect(lines).toEqual(['comment t1 inserted by Browser: "Can you tighten this?"'])
    expect((kv.room as RoomState).targets).toEqual({})
  })

  test('logs selection changes without scheduling a reply', async () => {
    const { lines, kv, ctx } = harness()
    await echo.handle(
      event(1, [
        {
          surface: 'selection',
          change: 'selected',
          peerId: 'peer-1',
          principal: 'person-1',
          displayName: 'Person',
          driver: 'Browser',
          blockId: 'b1',
          kind: 'selection',
          startUtf16: 0,
          endUtf16: 3,
          quote: 'abc',
          observedAt: '2026-11-10T00:00:00.000Z',
          actorKind: 'person',
          priority: 2,
        },
      ]),
      ctx,
    )
    expect(lines).toEqual(['selection b1 selected (selection) by Browser: "abc"'])
    expect((kv.room as RoomState).targets).toEqual({})
  })

  test('triage creates the intent; the next change bumps its version and generation', async () => {
    const spy = scriptedLlm(() => ({ respond: true, reply: 'Yes.' }))
    const { kv, ctx } = harness({ llm: spy.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'Question?')]), ctx)
    await echo.tick!(ctx)
    await flush()
    const first = kv.room as RoomState
    const intentId = Object.keys(first.intents)[0]!
    expect(first.intents[intentId]).toMatchObject({ version: 1, status: 'active' })
    expect(first.targets['nodes/b1:0']).toMatchObject({ generation: 1, assumedIntentVersion: 1 })

    await echo.handle(event(2, [node('updated', 'Question two?')]), ctx)
    await echo.tick!(ctx)
    await flush()
    const second = kv.room as RoomState
    expect(second.intents[intentId]?.version).toBe(2)
    expect(second.targets['nodes/b1:0']).toMatchObject({
      text: 'Question two?',
      generation: 2,
      assumedIntentVersion: 2,
    })
  })
})

describe('echo tick — speculative scheduling (Part A)', () => {
  test('does not start a draft before the pause elapses, for text with no completeness signal', async () => {
    const d = deferredLlm()
    const { ctx } = harness({ llm: d.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'please tighten this paragraph')]), ctx)
    await echo.tick!(ctx)
    await flush()
    expect(d.calls).toBe(0)
  })

  test('starts a draft after a short pause, well under the old 8s quiet period', async () => {
    const d = deferredLlm()
    const { kv, ctx } = harness({ llm: d.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'please tighten this paragraph')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await flush()
    expect(d.calls).toBe(1)
    expect(envelopeOf(d.promptSeen).context.trigger.text).toBe('please tighten this paragraph')
  })

  test('skips the pause entirely for text that already looks sentence-complete', async () => {
    const d = deferredLlm()
    const { ctx } = harness({ llm: d.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    await echo.tick!(ctx) // no backdate — this is the whole point
    await flush()
    expect(d.calls).toBe(1)
    expect(envelopeOf(d.promptSeen).context.trigger.text).toBe('Does it work?')
  })

  test('commits immediately once a matching draft resolves — no further wait', async () => {
    const d = deferredLlm()
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: d.llm, comments })
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await flush()
    d.resolve({ respond: true, reply: 'Yes.' })
    await flush()
    expect(comments.posts).toEqual([{ blockId: 'b1', body: 'Yes.', dedupeOn: 'Does it work?' }])
    expect(targetOf(kv)?.evaluatedText).toBe('Does it work?')
  })

  test('a text change before the draft resolves aborts it — nothing posts even once it later settles', async () => {
    const d = deferredLlm()
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: d.llm, comments })
    // No trailing punctuation on either text: neither looks complete, so this stays on the
    // pause-based path and no second draft starts right after the edit (kept separate from
    // the looksComplete+abort interaction, covered below).
    await echo.handle(event(1, [node('updated', 'please tighten this paragraph')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await flush()
    expect(d.calls).toBe(1)

    // New input arrives before the draft resolved — handle() aborts it directly.
    await echo.handle(event(2, [node('updated', 'please tighten this paragraph more')]), ctx)
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

  test('two in-flight drafts on different nodes commit without clobbering the room', async () => {
    const d = deferredLlm()
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: d.llm, comments })
    await echo.handle(event(1, [nodeAt('b1', 'First?'), nodeAt('b2', 'Second?')]), ctx)
    await echo.tick!(ctx)
    await flush()
    expect(d.calls).toBe(2)

    d.resolve({ respond: true, reply: 'One.' }, 0)
    d.resolve({ respond: true, reply: 'Two.' }, 1)
    await flush()

    const room = kv.room as RoomState
    expect(Object.keys(room.targets).sort()).toEqual(['nodes/b1:0', 'nodes/b2:0'])
    expect(room.targets['nodes/b1:0']?.evaluatedText).toBe('First?')
    expect(room.targets['nodes/b2:0']?.evaluatedText).toBe('Second?')
    expect(comments.posts).toHaveLength(2)
  })

  test('skips empty text — never asks the model', async () => {
    const d = deferredLlm()
    const { kv, ctx } = harness({ llm: d.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', '   ')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await flush()
    expect(d.calls).toBe(0)
  })

  test('a statement reaches the classifier and gets a reply', async () => {
    const comments = fakeComments()
    const spy = scriptedLlm((system) =>
      system === TRIAGE_SYSTEM_PROMPT
        ? { outcome: 'chat', confidence: 0.8, reason: 'statement' }
        : { reply: 'Noted. I can help with that.' },
    )
    const { kv, ctx } = harness({ llm: spy.llm, comments })
    await echo.handle(event(1, [node('updated', 'Just a statement.')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    await flush()
    expect(comments.posts).toEqual([
      { blockId: 'b1', body: 'Noted. I can help with that.', dedupeOn: 'Just a statement.' },
    ])
    expect(targetOf(kv)?.evaluatedText).toBe('Just a statement.')
  })

  test('does nothing when llm/comments capabilities are not configured', async () => {
    const { kv, ctx } = harness()
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    await echo.tick!(ctx)
    expect(targetOf(kv)?.evaluatedText).toBeNull()
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
    expect(comments.edits).toEqual([{ threadId: 'thread-1', messageId: 'message-1', body: 'Updated answer.', dedupeOn: 'reply:Updated answer.' }])
  })
})

describe('echo tick — backoff after a genuine failure', () => {
  test('repeated failures back off for longer each time', async () => {
    const comments = fakeComments()
    const llm = fakeLlm(() => new Error('still down'))
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(event(1, [node('updated', 'Will this ever work?')]), ctx)
    backdate(kv, 'nodes/b1:0', SPECULATIVE_PAUSE_MS + 500)
    const record = () => targetOf(kv) as { failures: number; lastAttemptAt: number }

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
      key: 'nodes/b1:0',
      pageId: 'p',
      blockId: 'b1',
      text: 'placeholder',
      previousText: null,
      changedAt: Date.now(),
      evaluatedText: null,
      failures: 0,
      lastAttemptAt: 0,
      threadId: null,
      messageId: null,
      lastReply: null,
      generation: 1,
      assumedIntentVersion: 1,
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
    const saved = await savedTarget(ctx)
    expect(saved).toMatchObject({ threadId: 'thread-1', messageId: 'message-1', lastReply: 'Yes, this works.', evaluatedText: 'Does it work?' })
  })

  test('shows a reading caret on the block before the model call resolves, not after', async () => {
    const comments = fakeComments()
    const presence = fakePresence()
    const deferred = deferredLlm()
    const { ctx } = harness({ llm: deferred.llm, comments, presence })
    const base = record({ text: 'Does it work?' })
    await ctx.state.set('nodes/b1:0', base)
    const pending = attempt('nodes/b1:0', base, ctx, new AbortController().signal)
    await flush()
    // The reading caret shows up while the model call is still in flight, not
    // only once a reply is ready to post.
    expect(presence.shown).toEqual(['b1'])
    expect(comments.posts).toEqual([])
    deferred.resolve({ respond: true, reply: 'Yes, this works.' })
    await pending
    expect(comments.posts).toHaveLength(1)
  })

  test('a failing presence hint never blocks or breaks the actual reply', async () => {
    const comments = fakeComments()
    const llm = fakeLlm(() => ({ respond: true, reply: 'Yes, this works.' }))
    const presence: PresenceCapability = { showReading: async () => { throw new Error('read_page unavailable') } }
    const { ctx } = harness({ llm, comments, presence })
    const base = record({ text: 'Does it work?' })
    await ctx.state.set('nodes/b1:0', base)
    await attempt('nodes/b1:0', base, ctx, new AbortController().signal)
    await flush()
    expect(comments.posts).toEqual([{ blockId: 'b1', body: 'Yes, this works.', dedupeOn: 'Does it work?' }])
  })

  test('no presence capability configured: attempt still proceeds normally', async () => {
    const comments = fakeComments()
    const llm = fakeLlm(() => ({ respond: true, reply: 'Yes, this works.' }))
    const { ctx } = harness({ llm, comments })
    const base = record({ text: 'Does it work?' })
    await ctx.state.set('nodes/b1:0', base)
    await attempt('nodes/b1:0', base, ctx, new AbortController().signal)
    expect(comments.posts).toEqual([{ blockId: 'b1', body: 'Yes, this works.', dedupeOn: 'Does it work?' }])
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
    expect(comments.edits).toEqual([{ threadId: 'thread-1', messageId: 'message-1', body: 'Yes, definitely.', dedupeOn: 'reply:Yes, definitely.' }])
    const saved = await savedTarget(ctx)
    expect(saved).toMatchObject({ lastReply: 'Yes, definitely.', threadId: 'thread-1', messageId: 'message-1' })
  })

  test('a follow-up still responds when the existing reply stands', async () => {
    const comments = fakeComments()
    const spy = scriptedLlm(() => ({ reply: 'The existing answer still stands.' }))
    const { ctx } = harness({ llm: spy.llm, comments })
    const base = record({
      text: 'Does it really work? Yes I think so.',
      threadId: 'thread-1',
      messageId: 'message-1',
      lastReply: 'Yes, this works.',
    })
    await ctx.state.set('nodes/b1:0', base)
    await attempt('nodes/b1:0', base, ctx, new AbortController().signal)
    expect(comments.posts).toEqual([])
    expect(comments.edits).toEqual([
      {
        threadId: 'thread-1',
        messageId: 'message-1',
        body: 'The existing answer still stands.',
        dedupeOn: 'reply:The existing answer still stands.',
      },
    ])
    const saved = await savedTarget(ctx)
    expect(saved).toMatchObject({
      threadId: 'thread-1',
      messageId: 'message-1',
      lastReply: 'The existing answer still stands.',
      evaluatedText: base.text,
    })
  })

  test('a genuine failure on the edit path backs off the same way as on the add path', async () => {
    const comments: CommentsCapability = {
      addBlock: async () => ({ threadId: 'x', messageId: 'y' }),
      editMessage: async () => {
        throw new Error('pages api down')
      },
      replyToThread: async () => ({ threadId: 'x', messageId: 'z' }),
    }
    const llm = fakeLlm(() => ({ respond: true, reply: 'update' }))
    const { ctx } = harness({ llm, comments })
    const base = record({ text: 'new question?', threadId: 'thread-1', messageId: 'message-1', lastReply: 'old reply' })
    await ctx.state.set('nodes/b1:0', base)
    await attempt('nodes/b1:0', base, ctx, new AbortController().signal)
    const saved = await savedTarget(ctx)
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
    const base = record({ text: 'Does it work?' })
    await ctx.state.set('nodes/b1:0', base)
    await attempt('nodes/b1:0', base, ctx, controller.signal)
    const saved = await savedTarget(ctx)
    expect(saved).toEqual(base) // untouched — abort isn't a failure
  })
})

function scriptedLlm(
  respond: (system: string, prompt: string, index: number) => string | Record<string, unknown>,
) {
  const calls: { system: string; prompt: string }[] = []
  const llm: LlmCapability = {
    complete: async ({ system, prompt }) => {
      calls.push({ system: system ?? '', prompt })
      const value = respond(system ?? '', prompt, calls.length - 1)
      return typeof value === 'string' ? value : JSON.stringify(value)
    },
  }
  return { calls, llm }
}

const commentChange = (overrides: Partial<import('@pages-programs/sdk').CommentChange> = {}) => ({
  surface: 'comment' as const,
  change: 'inserted',
  threadId: 't1',
  messageId: 'm1',
  blockId: 'b1',
  body: 'Can you explain this?',
  authorPrincipal: 'person-1',
  authorDisplayName: 'Person',
  driver: 'Browser',
  actorKind: 'person' as const,
  priority: 1 as const,
  ...overrides,
})

describe('triage wiring', () => {
  test('an unambiguous correction never calls the classification model', async () => {
    const spy = scriptedLlm(() => ({ respond: true, reply: 'Shorter answer.' }))
    const comments = fakeComments()
    const { ctx } = harness({ llm: spy.llm, comments })
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    await echo.tick!(ctx)
    await flush()

    await echo.handle(event(2, [node('updated', 'Actually make it shorter.')]), ctx)
    await echo.tick!(ctx)
    await flush()

    expect(spy.calls.filter((call) => call.system === TRIAGE_SYSTEM_PROMPT)).toHaveLength(0)
    expect(comments.posts).toHaveLength(1)
    expect(comments.edits).toHaveLength(1)
  })

  test('an ambiguous body change gets one classification call, then one generation call', async () => {
    const spy = scriptedLlm((system) =>
      system === TRIAGE_SYSTEM_PROMPT
        ? { outcome: 'new_action', intentId: null, confidence: 0.8, reason: 'model' }
        : { respond: true, reply: 'Sure.' },
    )
    const comments = fakeComments()
    const { ctx } = harness({ llm: spy.llm, comments })
    await echo.handle(event(1, [node('updated', 'Maybe the intro needs work.')]), ctx)
    await echo.tick!(ctx)
    await flush()

    expect(spy.calls[0]?.system).toBe(TRIAGE_SYSTEM_PROMPT)
    expect(spy.calls).toHaveLength(2)
    expect(comments.posts).toHaveLength(1)
  })

  test('malformed classification falls back to clarify instead of an edit', async () => {
    const spy = scriptedLlm((system) =>
      system === TRIAGE_SYSTEM_PROMPT
        ? 'not json'
        : { respond: true, reply: 'Do you want the intro shortened?' },
    )
    const comments = fakeComments()
    const { ctx } = harness({ llm: spy.llm, comments })
    await echo.handle(event(1, [node('updated', 'Maybe the intro needs work.')]), ctx)
    await echo.tick!(ctx)
    await flush()

    expect(spy.calls[1]?.system).toContain('ambiguous')
    expect(comments.posts).toEqual([
      { blockId: 'b1', body: 'Do you want the intro shortened?', dedupeOn: 'Maybe the intro needs work.' },
    ])
  })

  test('a correction with no earlier reply asks what to change instead of staying silent', async () => {
    const spy = scriptedLlm(() => ({ respond: true, reply: 'What should I change?' }))
    const comments = fakeComments()
    const { ctx, lines } = harness({ llm: spy.llm, comments })
    await echo.handle(event(1, [node('updated', 'no.')]), ctx)
    await echo.tick!(ctx)
    await flush()

    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]?.system).toContain('correction')
    expect(comments.posts).toEqual([
      { blockId: 'b1', body: 'What should I change?', dedupeOn: 'no.' },
    ])
    expect(lines.some((line) => line.includes('triage b1: correction'))).toBe(true)
  })

  test('a correction includes the text it replaced', async () => {
    const spy = scriptedLlm(() => ({ respond: true, reply: 'Shorter.' }))
    const comments = fakeComments()
    const { ctx } = harness({ llm: spy.llm, comments })
    await echo.handle(event(1, [node('updated', 'Please tighten this paragraph.')]), ctx)
    await echo.handle(event(2, [node('updated', 'Actually, make it shorter.')]), ctx)
    await echo.tick!(ctx)
    await flush()

    expect(envelopeOf(spy.calls[0]?.prompt).context.trigger.previousText).toBe(
      'Please tighten this paragraph.',
    )
    expect(envelopeOf(spy.calls[0]?.prompt).context.trigger.text).toBe(
      'Actually, make it shorter.',
    )
    expect(comments.posts).toEqual([
      { blockId: 'b1', body: 'Shorter.', dedupeOn: 'Actually, make it shorter.' },
    ])
  })

  test('a person comment gets a threaded reply, and redelivery does not duplicate it', async () => {
    const spy = scriptedLlm(() => ({ respond: true, reply: 'Yes, that is the idea.' }))
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: spy.llm, comments })
    const change = commentChange()

    await echo.handle(event(1, [change]), ctx)
    expect(spy.calls[0]?.system).toContain('always respond')
    expect(comments.replies).toEqual([
      {
        threadId: 't1',
        body: 'Yes, that is the idea.',
        dedupeOn: 'm1:Can you explain this?',
      },
    ])
    const intent = Object.values((kv.room as RoomState).intents)[0]!
    expect(intent.targetScope.threadId).toBe('t1')

    await echo.handle(event(1, [change]), ctx)
    expect(comments.replies).toHaveLength(1)
  })

  test('a comment generation failure leaves no intent behind and retries at version 1', async () => {
    let fail = true
    const spy = scriptedLlm(() => {
      if (fail) throw new Error('gateway down')
      return { respond: true, reply: 'Yes.' }
    })
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: spy.llm, comments })
    const change = commentChange()

    await expect(echo.handle(event(1, [change]), ctx)).rejects.toThrow('gateway down')
    expect(Object.keys((kv.room as RoomState | undefined)?.intents ?? {})).toEqual([])

    fail = false
    await echo.handle(event(2, [change]), ctx)
    const intent = Object.values((kv.room as RoomState).intents)[0]!
    expect(intent.version).toBe(1)
    expect(comments.replies).toHaveLength(1)
  })

  test('a correction in the same comment thread bumps the intent version', async () => {
    const spy = scriptedLlm(() => ({ respond: true, reply: 'Updated.' }))
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: spy.llm, comments })
    await echo.handle(event(1, [commentChange()]), ctx)

    await echo.handle(
      event(2, [
        commentChange({
          messageId: 'm2',
          body: 'Actually make it shorter.',
        }),
      ]),
      ctx,
    )

    const intent = Object.values((kv.room as RoomState).intents)[0]!
    expect(intent.version).toBe(2)
    expect(comments.replies).toHaveLength(2)
  })

  test('selections never call the model or post a reply', async () => {
    const spy = scriptedLlm(() => ({ respond: true, reply: 'nope' }))
    const comments = fakeComments()
    const { ctx } = harness({ llm: spy.llm, comments })
    await echo.handle(
      event(1, [
        {
          surface: 'selection',
          change: 'selected',
          peerId: 'peer-1',
          principal: 'person-1',
          displayName: 'Person',
          driver: 'Browser',
          blockId: 'b1',
          kind: 'selection',
          startUtf16: 0,
          endUtf16: 3,
          quote: 'abc',
          observedAt: '2026-11-10T00:00:00.000Z',
          actorKind: 'person',
          priority: 2,
        },
      ]),
      ctx,
    )
    expect(spy.calls).toEqual([])
    expect(comments.replies).toEqual([])
  })
})

describe('plan steps — the to-do list behind an intent', () => {
  test('a body action creates an ordered plan, active while drafting and done after posting', async () => {
    const d = deferredLlm()
    const { kv, ctx } = harness({ llm: d.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'Please tighten this paragraph.')]), ctx)
    await echo.tick!(ctx)
    await flush()

    const intentId = Object.keys((kv.room as RoomState).intents)[0]!
    expect((kv.room as RoomState).steps[`${intentId}:1:draft`]).toMatchObject({
      intentId,
      intentVersion: 1,
      status: 'active',
      kind: 'draft_reply',
      description: 'Draft the reply',
    })
    expect((kv.room as RoomState).steps[`${intentId}:1:post`]).toMatchObject({
      status: 'pending',
      kind: 'post_reply',
      dependsOn: [`${intentId}:1:draft`],
    })

    d.resolve({ respond: true, reply: 'Done.' })
    await flush()
    expect((kv.room as RoomState).steps[`${intentId}:1:draft`]?.status).toBe('done')
    expect((kv.room as RoomState).steps[`${intentId}:1:post`]?.status).toBe('done')
  })

  test('a correction bumps the version and replaces the plan', async () => {
    const spy = scriptedLlm(() => ({ respond: true, reply: 'Shorter.' }))
    const { kv, ctx } = harness({ llm: spy.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'Please tighten this paragraph.')]), ctx)
    await echo.tick!(ctx)
    await flush()
    const intentId = Object.keys((kv.room as RoomState).intents)[0]!
    expect((kv.room as RoomState).steps[`${intentId}:1:draft`]?.status).toBe('done')

    await echo.handle(event(2, [node('updated', 'Actually make it shorter.')]), ctx)
    await echo.tick!(ctx)
    await flush()

    const room = kv.room as RoomState
    expect(room.intents[intentId]?.version).toBe(2)
    expect(room.steps[`${intentId}:1:draft`]?.status).toBe('cancelled')
    expect(room.steps[`${intentId}:2:draft`]).toMatchObject({
      status: 'done',
      intentVersion: 2,
      kind: 'draft_reply',
    })
    expect(room.steps[`${intentId}:2:edit`]).toMatchObject({
      status: 'done',
      intentVersion: 2,
      kind: 'edit_reply',
    })
  })

  test('a statement is classified instead of ignored and gets no plan', async () => {
    const spy = scriptedLlm((system) =>
      system === TRIAGE_SYSTEM_PROMPT
        ? { outcome: 'chat', confidence: 0.8, reason: 'statement' }
        : { reply: 'Noted.' },
    )
    const { kv, ctx } = harness({ llm: spy.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'This is just a statement.')]), ctx)
    await echo.tick!(ctx)
    await flush()
    expect((kv.room as RoomState).steps).toEqual({})
  })

  test('deleting a comment thread closes its intent without a reply', async () => {
    const spy = scriptedLlm(() => ({ reply: 'Summary added.' }))
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: spy.llm, comments })
    await echo.handle(event(1, [commentChange({ body: 'Please add a summary.' })]), ctx)
    expect(comments.replies).toHaveLength(1)

    await echo.handle(event(2, [commentChange({ change: 'deleted' })]), ctx)

    const room = kv.room as RoomState
    const intent = Object.values(room.intents)[0]!
    expect(intent.status).toBe('abandoned')
    expect(comments.replies).toHaveLength(1)
  })

  test('a chat comment gets no plan, whether or not echo replies', async () => {
    const spy = scriptedLlm(() => ({ respond: true, reply: 'Yes.' }))
    const { kv, ctx } = harness({ llm: spy.llm, comments: fakeComments() })
    await echo.handle(event(1, [commentChange()]), ctx)
    expect((kv.room as RoomState).steps).toEqual({})
  })

  test('an action comment always posts its reply and completes the plan', async () => {
    const spy = scriptedLlm(() => ({ reply: 'Summary added.' }))
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm: spy.llm, comments })
    await echo.handle(event(1, [commentChange({ body: 'Please add a summary.' })]), ctx)

    expect(comments.replies).toHaveLength(1)
    const room = kv.room as RoomState
    const intentId = Object.keys(room.intents)[0]!
    expect(room.intents[intentId]?.kind).toBe('action')
    const steps = Object.values(room.steps).filter((step) => step.intentId === intentId)
    expect(steps).toHaveLength(2)
    expect(steps.every((step) => step.status === 'done')).toBe(true)
  })

  test('todo_write proposes the plan when the host supports tools', async () => {
    const calls: { system: string; prompt: string }[] = []
    const llm: LlmCapability = {
      complete: async ({ system, prompt }) => {
        calls.push({ system, prompt })
        return JSON.stringify({ respond: true, reply: 'Done.' })
      },
      completeWithTools: async ({ system, prompt }) => {
        calls.push({ system, prompt })
        return {
          content: null,
          toolCalls: [
            {
              id: 'call_1',
              name: 'todo_write',
              arguments: {
                steps: [
                  { key: 'draft', kind: 'draft_reply', description: 'Draft the tightened paragraph' },
                  {
                    key: 'post',
                    kind: 'post_reply',
                    description: 'Post the tightened paragraph',
                    dependsOn: ['draft'],
                  },
                ],
              },
            },
          ],
        }
      },
    }
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(event(1, [node('updated', 'Please tighten this paragraph.')]), ctx)
    await echo.tick!(ctx)
    await flush()

    const room = kv.room as RoomState
    const intentId = Object.keys(room.intents)[0]!
    expect(room.steps[`${intentId}:1:draft`]?.description).toBe('Draft the tightened paragraph')
    expect(room.steps[`${intentId}:1:post`]?.description).toBe('Post the tightened paragraph')
    expect(calls.some((call) => call.system.includes('You plan the work'))).toBe(true)
    const planCall = calls.find((call) => call.system.includes('You plan the work'))
    expect(planCall).toBeDefined()
    expect(planCall!.system).toContain('prior model output')
    const planEnvelope = JSON.parse(planCall!.prompt.slice(planCall!.prompt.indexOf('{'))) as {
      task: { purpose: string; instruction: string }
      context: { trigger: { text: string } }
    }
    expect(planEnvelope.task.purpose).toBe('plan')
    expect(planEnvelope.task.instruction).toContain('todo_write')
    expect(planEnvelope.context.trigger.text).toContain('tighten this paragraph')
    expect(comments.posts[0]?.body).toBe('Done.')
  })

  test('a multi-part body action posts a visible plan, then checks it and adds the reply', async () => {
    let resolveReply!: (value: DecisionValue) => void
    const llm: LlmCapability = {
      complete: () =>
        new Promise<string>((resolve) => {
          resolveReply = (value) => resolve(JSON.stringify(value))
        }),
      completeWithTools: async () => ({
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'todo_write',
            arguments: {
              steps: [
                { key: 'vendors', kind: 'task', description: 'List the vendors' },
                { key: 'teams', kind: 'task', description: 'Count the teams' },
                { key: 'summary', kind: 'task', description: 'Suggest a one-line summary' },
                {
                  key: 'draft',
                  kind: 'draft_reply',
                  description: 'Draft the response',
                  dependsOn: ['vendors', 'teams', 'summary'],
                },
                {
                  key: 'post',
                  kind: 'post_reply',
                  description: 'Post the response',
                  dependsOn: ['draft'],
                },
              ],
            },
          },
        ],
      }),
    }
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(
      event(1, [
        node(
          'updated',
          'Please do these three things: 1) list the vendors, 2) count the teams, 3) suggest a one-line summary.',
        ),
      ]),
      ctx,
    )
    await echo.tick!(ctx)
    await flush()

    expect(comments.posts).toHaveLength(1)
    expect(comments.posts[0]?.body).toContain('**Plan**')
    expect(comments.posts[0]?.body).toContain('- [ ] List the vendors')
    expect(comments.posts[0]?.body).toContain('- [ ] Count the teams')
    expect(comments.posts[0]?.body).toContain('Working on it')
    expect(comments.posts[0]?.dedupeOn.startsWith('plan:')).toBe(true)
    expect(targetOf(kv)?.threadId).toBe('thread-1')

    resolveReply({
      respond: true,
      reply: 'Vendors: Acme, Beta. Teams: three. Summary: the budget splits three ways.',
      completedTasks: ['vendors', 'teams', 'summary'],
    })
    await flush()

    expect(comments.edits).toHaveLength(1)
    expect(comments.edits[0]?.body).toContain('- [x] List the vendors')
    expect(comments.edits[0]?.body).toContain('- [x] Count the teams')
    expect(comments.edits[0]?.body).toContain('Vendors: Acme, Beta.')
    expect(comments.edits[0]?.dedupeOn.startsWith('reply:')).toBe(true)
    expect(comments.posts).toHaveLength(1)
    expect(targetOf(kv)?.lastReply).toBe('Vendors: Acme, Beta. Teams: three. Summary: the budget splits three ways.')
  })

  test('a multi-part action that asks for missing context leaves the checklist unchecked', async () => {
    const llm: LlmCapability = {
      complete: async () =>
        JSON.stringify({
          respond: true,
          reply: 'I can help with all three, but I do not see the page content. Could you paste it?',
        }),
      completeWithTools: async () => ({
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'todo_write',
            arguments: {
              steps: [
                { key: 'vendors', kind: 'task', description: 'List the vendors' },
                { key: 'teams', kind: 'task', description: 'Count the teams' },
                { key: 'summary', kind: 'task', description: 'Suggest a one-line summary' },
                { key: 'draft', kind: 'draft_reply', description: 'Draft the response' },
                {
                  key: 'post',
                  kind: 'post_reply',
                  description: 'Post the response',
                  dependsOn: ['draft'],
                },
              ],
            },
          },
        ],
      }),
    }
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(
      event(1, [
        node(
          'updated',
          'Please do these three things: 1) list the vendors, 2) count the teams, 3) suggest a one-line summary.',
        ),
      ]),
      ctx,
    )
    await echo.tick!(ctx)
    await flush()

    expect(comments.edits).toHaveLength(1)
    expect(comments.edits[0]?.body).toContain('- [ ] List the vendors')
    expect(comments.edits[0]?.body).toContain('Could you paste it?')
    const room = kv.room as RoomState
    expect(Object.values(room.steps).some((step) => step.status !== 'done')).toBe(true)
  })

  test('a multi-part action checks only the tasks the reply finished', async () => {
    const llm: LlmCapability = {
      complete: async () =>
        JSON.stringify({
          respond: true,
          reply:
            'Vendors: Acme, Google, Meta, Twitter. Summary: Four vendors are listed for review. I cannot count teams without the teams paragraph.',
          completed: false,
          completedTasks: ['vendors', 'summary'],
        }),
      completeWithTools: async () => ({
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'todo_write',
            arguments: {
              steps: [
                { key: 'vendors', kind: 'task', description: 'List the vendors' },
                { key: 'teams', kind: 'task', description: 'Count the teams' },
                { key: 'summary', kind: 'task', description: 'Suggest a one-line summary' },
                { key: 'draft', kind: 'draft_reply', description: 'Draft the response' },
                {
                  key: 'post',
                  kind: 'post_reply',
                  description: 'Post the response',
                  dependsOn: ['draft'],
                },
              ],
            },
          },
        ],
      }),
    }
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(
      event(1, [
        node(
          'updated',
          'Please do these three things: 1) list the vendors, 2) count the teams, 3) suggest a one-line summary, acme, google, meta, twitter.',
        ),
      ]),
      ctx,
    )
    await echo.tick!(ctx)
    await flush()

    expect(comments.edits).toHaveLength(1)
    expect(comments.edits[0]?.body).toContain('- [x] List the vendors')
    expect(comments.edits[0]?.body).toContain('- [ ] Count the teams')
    expect(comments.edits[0]?.body).toContain('- [x] Suggest a one-line summary')
    const room = kv.room as RoomState
    const intentId = Object.keys(room.intents)[0]!
    expect(room.steps[`${intentId}:1:vendors`]?.status).toBe('done')
    expect(room.steps[`${intentId}:1:teams`]?.status).not.toBe('done')
    expect(room.steps[`${intentId}:1:summary`]?.status).toBe('done')
    expect(room.steps[`${intentId}:1:draft`]?.status).toBe('done')
  })

  test('an enumerated list becomes one visible task per item', async () => {
    const items = ['sleep', 'cook', 'eat', 'zumba', 'movies', 'travel', 'text', 'bike', 'run', 'walk', 'hair']
    const llm: LlmCapability = {
      complete: async () =>
        JSON.stringify({
          respond: true,
          reply: 'All eleven are covered.',
          completedTasks: items,
        }),
      completeWithTools: async () => ({
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'todo_write',
            arguments: {
              steps: items.map((item) => ({
                key: item,
                kind: 'task',
                description: item[0]!.toUpperCase() + item.slice(1),
              })),
            },
          },
        ],
      }),
    }
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(
      event(1, [
        node(
          'updated',
          'Please do ten things, sleep, cook, eat, zumba, movies, travel, text, bike, run, walk, hair',
        ),
      ]),
      ctx,
    )
    backdate(kv, 'nodes/b1:0', 10_000)
    await echo.tick!(ctx)
    await flush()

    expect(comments.posts).toHaveLength(1)
    expect(comments.posts[0]?.body).toContain('- [ ] Sleep')
    expect(comments.posts[0]?.body).toContain('- [ ] Hair')
    expect(comments.edits).toHaveLength(1)
    expect(comments.edits[0]?.body).toContain('- [x] Sleep')
    expect(comments.edits[0]?.body).toContain('- [x] Hair')
    const room = kv.room as RoomState
    const intentId = Object.keys(room.intents)[0]!
    expect(Object.values(room.steps).filter((step) => step.kind === 'task')).toHaveLength(11)
    expect(Object.values(room.steps).every((step) => step.status === 'done')).toBe(true)
  })

  test('a multi-part comment action includes the checked plan in its reply', async () => {
    const llm: LlmCapability = {
      complete: async () =>
        JSON.stringify({
          respond: true,
          reply: 'Acme and Beta; three teams.',
          completedTasks: ['vendors', 'teams'],
        }),
      completeWithTools: async () => ({
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'todo_write',
            arguments: {
              steps: [
                { key: 'vendors', kind: 'task', description: 'List the vendors' },
                { key: 'teams', kind: 'task', description: 'Count the teams' },
                { key: 'draft', kind: 'draft_reply', description: 'Draft the reply' },
                {
                  key: 'post',
                  kind: 'post_reply',
                  description: 'Post the reply',
                  dependsOn: ['draft'],
                },
              ],
            },
          },
        ],
      }),
    }
    const comments = fakeComments()
    const { ctx } = harness({ llm, comments })
    await echo.handle(
      event(1, [commentChange({ body: 'Please do two things: list the vendors and count the teams.' })]),
      ctx,
    )

    expect(comments.replies).toHaveLength(1)
    expect(comments.replies[0]?.body).toContain('**Plan**')
    expect(comments.replies[0]?.body).toContain('- [x] List the vendors')
    expect(comments.replies[0]?.body).toContain('Acme and Beta; three teams.')
  })

  test('a plan that uses edit_reply without a reply is normalized to post_reply', async () => {
    const llm: LlmCapability = {
      complete: async () => JSON.stringify({ respond: true, reply: 'Done.' }),
      completeWithTools: async () => ({
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'todo_write',
            arguments: {
              steps: [{ key: 'edit', kind: 'edit_reply', description: 'Edit a reply that does not exist' }],
            },
          },
        ],
      }),
    }
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(event(1, [node('updated', 'Please tighten this paragraph.')]), ctx)
    await echo.tick!(ctx)
    await flush()

    const room = kv.room as RoomState
    const intentId = Object.keys(room.intents)[0]!
    expect(room.steps[`${intentId}:1:edit`]).toMatchObject({ kind: 'post_reply', status: 'done' })
    expect(comments.posts).toHaveLength(1)
    expect(comments.edits).toEqual([])
  })

  test('a plan that posts when a reply already exists is normalized to edit_reply', async () => {
    const llm: LlmCapability = {
      complete: async ({ prompt }) =>
        JSON.stringify({
          respond: true,
          reply: prompt.includes('add a summary') ? 'Updated summary.' : 'First answer.',
        }),
      completeWithTools: async () => ({
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'todo_write',
            arguments: {
              steps: [
                { key: 'vendors', kind: 'task', description: 'List the vendors' },
                { key: 'draft', kind: 'draft_reply', description: 'Draft the reply' },
                {
                  key: 'post',
                  kind: 'post_reply',
                  description: 'Post the reply',
                  dependsOn: ['draft'],
                },
              ],
            },
          },
        ],
      }),
    }
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(event(1, [node('updated', 'Please tighten this paragraph.')]), ctx)
    await echo.tick!(ctx)
    await flush()
    expect(comments.posts).toHaveLength(1)

    await echo.handle(event(2, [node('updated', 'Please tighten this paragraph and add a summary.')]), ctx)
    await echo.tick!(ctx)
    await flush()

    const room = kv.room as RoomState
    const intentId = Object.keys(room.intents)[0]!
    expect(room.intents[intentId]?.version).toBe(2)
    expect(room.steps[`${intentId}:2:post`]).toMatchObject({ kind: 'edit_reply', status: 'done' })
    expect(comments.edits.some((edit) => edit.dedupeOn.startsWith('plan:'))).toBe(true)
    expect(comments.edits.at(-1)?.dedupeOn.startsWith('reply:')).toBe(true)
    expect(comments.edits.at(-1)?.body).toContain('Updated summary.')
    expect(comments.posts).toHaveLength(1)
  })
})

function manualLlm() {
  let reject!: (error: Error) => void
  const llm: LlmCapability = {
    complete: () =>
      new Promise<string>((_resolve, rejectPromise) => {
        reject = rejectPromise
      }),
  }
  return { llm, reject: (error: Error) => reject(error) }
}

describe('failure fencing and thread lifecycle', () => {
  test('a failure for text that moved on is not charged to the new text', async () => {
    const manual = manualLlm()
    const { ctx } = harness({ llm: manual.llm, comments: fakeComments() })
    await echo.handle(event(1, [node('updated', 'Old question?')]), ctx)
    await echo.tick!(ctx)
    await flush()

    await echo.handle(event(2, [node('updated', 'New question?')]), ctx)
    manual.reject(new Error('gateway down'))
    await flush()

    const saved = await savedTarget(ctx)
    expect(saved).toMatchObject({ text: 'New question?', failures: 0 })
  })

  test('a deleted thread clears reply identity and the next edit posts a new thread', async () => {
    const llm = fakeLlm(() => ({ respond: true, reply: 'Yes.' }))
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm, comments })
    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    await echo.tick!(ctx)
    await flush()

    const first = kv.room as RoomState
    const intentId = Object.keys(first.intents)[0]!
    expect(first.intents[intentId]?.targetScope.threadId).toBe('thread-1')

    await echo.handle(
      event(2, [
        {
          surface: 'comment',
          change: 'deleted',
          threadId: 'thread-1',
          messageId: null,
          blockId: null,
          body: null,
          authorPrincipal: null,
          authorDisplayName: null,
          driver: null,
          actorKind: 'unknown',
          priority: 2,
        },
      ]),
      ctx,
    )

    const afterDelete = kv.room as RoomState
    expect(afterDelete.targets['nodes/b1:0']).toMatchObject({
      threadId: null,
      messageId: null,
      lastReply: null,
    })
    expect(afterDelete.intents[intentId]?.status).toBe('abandoned')

    await echo.handle(event(3, [node('updated', 'Another question?')]), ctx)
    await echo.tick!(ctx)
    await flush()

    expect(comments.posts).toHaveLength(2)
    expect(comments.edits).toHaveLength(0)
    const afterEdit = kv.room as RoomState
    expect(afterEdit.targets['nodes/b1:0']?.threadId).toBe('thread-2')
  })

  test('a tick-only migration uses the context page id', async () => {
    const llm = fakeLlm(() => ({ respond: true, reply: 'Yes.' }))
    const comments = fakeComments()
    const { kv, ctx } = harness({ llm, comments })
    kv['nodes/b1:0'] = {
      blockId: 'b1',
      text: 'Does it work?',
      changedAt: Date.now() - SPECULATIVE_PAUSE_MS - 100,
      evaluatedText: null,
      failures: 0,
      lastAttemptAt: 0,
      threadId: null,
      messageId: null,
      lastReply: null,
      generation: 1,
      assumedIntentVersion: null,
    }

    await echo.tick!(ctx)
    await flush()

    const room = kv.room as RoomState
    expect(room.pageId).toBe('p')
    expect(room.targets['nodes/b1:0']?.pageId).toBe('p')
    expect(comments.posts).toHaveLength(1)
  })
})

describe('context assembly in echo', () => {
  test('body generation gets the page locality, presence, and open thread history', async () => {
    const reads = fakeReads({ page: pageRead(), threads: [threadRead()] })
    const spy = scriptedLlm(() => ({ reply: 'Tightened, with both examples.' }))
    const comments = fakeComments()
    const { kv, ctx } = harness({
      llm: spy.llm,
      comments,
      reads: reads.reads,
      ownPrincipal: 'self',
    })

    await echo.handle(
      event(1, [node('updated', 'Please tighten the budget paragraph but keep the two examples.')]),
      ctx,
    )
    await echo.tick!(ctx)
    await flush()

    const generation = spy.calls.at(-1)!
    expect(generation.system).toContain('untrusted page content')
    expect(generation.prompt).toContain('untrusted page content')
    const envelope = envelopeOf(generation.prompt)
    expect(envelope.context.page.title).toBe('Q4 plan')
    expect(envelope.context.page.block).toMatchObject({
      headingPath: ['Q4 plan', 'Budget'],
      type: 'paragraph',
    })
    expect(envelope.context.page.block?.markdown).toContain('keep the two examples')
    expect(envelope.context.openThreads[0]?.messages.map((message) => message.author)).toEqual([
      'Sam',
      'you',
    ])
    expect(envelope.context.presence).toHaveLength(1)
    expect(reads.counters.page).toBe(1)
    expect(reads.counters.comments).toBe(1)
    expect(comments.posts).toHaveLength(1)
  })

  test('comment generation gets the trigger thread and echo own reply', async () => {
    const reads = fakeReads({ page: pageRead(), threads: [threadRead()] })
    const spy = scriptedLlm(() => ({ reply: 'Yes, keep both and tighten the rest.' }))
    const comments = fakeComments()
    const { ctx } = harness({
      llm: spy.llm,
      comments,
      reads: reads.reads,
      ownPrincipal: 'self',
    })

    await echo.handle(event(1, [commentChange()]), ctx)

    const envelope = envelopeOf(spy.calls.at(-1)?.prompt)
    expect(envelope.context.thread?.id).toBe('t1')
    expect(envelope.context.thread?.messages.map((message) => message.author)).toEqual([
      'Sam',
      'you',
    ])
    expect(envelope.context.thread?.messages[1]?.body).toBe('Yes, keep both.')
    expect(comments.replies).toHaveLength(1)
    expect(reads.counters.page).toBe(1)
    expect(reads.counters.comments).toBe(1)
  })

  test('a read failure degrades the prompt but still answers', async () => {
    const reads = fakeReads({ fail: true })
    const spy = scriptedLlm(() => ({ reply: 'Yes.' }))
    const comments = fakeComments()
    const { ctx, lines } = harness({
      llm: spy.llm,
      comments,
      reads: reads.reads,
      ownPrincipal: 'self',
    })

    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    await echo.tick!(ctx)
    await flush()

    const envelope = envelopeOf(spy.calls.at(-1)?.prompt)
    expect(envelope.context.page.block).toBeNull()
    expect(envelope.context.trigger.text).toBe('Does it work?')
    expect(comments.posts).toHaveLength(1)
    expect(lines.some((line) => line.includes('context reads degraded'))).toBe(true)
    expect(lines.some((line) => line.includes('degraded=true'))).toBe(true)
  })

  test('timeline records the edit, triage, attempt, and reply exactly once', async () => {
    const spy = scriptedLlm(() => ({ reply: 'Yes.' }))
    const { kv, ctx } = harness({ llm: spy.llm, comments: fakeComments() })

    await echo.handle(event(1, [node('updated', 'Does it work?')]), ctx)
    await echo.tick!(ctx)
    await flush()

    const timeline = (kv.room as RoomState).timeline ?? []
    const kinds = timeline.map((entry) => entry.kind)
    expect(kinds.filter((kind) => kind === 'user_edit')).toHaveLength(1)
    expect(kinds.filter((kind) => kind === 'triage')).toHaveLength(1)
    expect(kinds.filter((kind) => kind === 'attempt_started')).toHaveLength(1)
    expect(kinds.filter((kind) => kind === 'reply_written')).toHaveLength(1)
    expect(timeline.find((entry) => entry.kind === 'reply_written')?.summary).toContain('Yes.')
  })

  test('a comment reply records the thread decision in the timeline', async () => {
    const spy = scriptedLlm(() => ({ reply: 'Yes, that is the idea.' }))
    const { kv, ctx } = harness({ llm: spy.llm, comments: fakeComments() })

    await echo.handle(event(1, [commentChange()]), ctx)

    const timeline = (kv.room as RoomState).timeline ?? []
    expect(timeline.some((entry) => entry.kind === 'user_comment')).toBe(true)
    expect(timeline.some((entry) => entry.kind === 'triage')).toBe(true)
    expect(timeline.some((entry) => entry.kind === 'reply_written')).toBe(true)
    expect(timeline.find((entry) => entry.kind === 'user_comment')?.scope).not.toHaveProperty(
      'pageId',
    )
    expect(timeline.find((entry) => entry.kind === 'triage')?.scope).not.toHaveProperty(
      'pageId',
    )
  })
})
