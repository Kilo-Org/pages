import { describe, expect, test } from 'bun:test'
import {
  appendTimeline,
  attemptEntry,
  excerpt,
  failureEntry,
  intentVersionEntry,
  recentTimeline,
  replyEntry,
  summarizeTimeline,
  TIMELINE_LIMIT,
  triageEntry,
  userCommentEntry,
  userEditEntry,
} from './archivist.ts'
import { emptyRoom, type Intent, type TargetState, type TimelineEntry } from './room.ts'

const at = '2026-11-12T22:00:00.000Z'

const target = (overrides: Partial<TargetState> = {}): TargetState => ({
  key: 'nodes/b1:0',
  pageId: 'p',
  blockId: 'b1',
  text: 'Please tighten this.',
  previousText: null,
  changedAt: 0,
  evaluatedText: null,
  failures: 0,
  lastAttemptAt: 0,
  threadId: null,
  messageId: null,
  lastReply: null,
  generation: 1,
  assumedIntentVersion: 1,
  ...overrides,
})

const intent = (overrides: Partial<Intent> = {}): Intent => ({
  id: 'i1',
  kind: 'action',
  status: 'active',
  version: 2,
  targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' },
  outputKind: 'comment',
  confidence: 0.8,
  evidence: [],
  createdAt: at,
  updatedAt: at,
  ...overrides,
})

const entry = (id: string, summary: string, atValue = at): TimelineEntry => ({
  id,
  at: atValue,
  kind: 'user_edit',
  surface: 'body',
  scope: { blockId: 'b1' },
  summary,
})

describe('appendTimeline', () => {
  test('appends and dedupes by stable id', () => {
    const room = emptyRoom('p')
    const once = appendTimeline(room, entry('e1', 'first'))
    const twice = appendTimeline(once, entry('e1', 'first'))
    expect(once.timeline).toHaveLength(1)
    expect(twice).toBe(once)
  })

  test('caps the timeline at TIMELINE_LIMIT, dropping the oldest', () => {
    let room = emptyRoom('p')
    for (let i = 0; i < TIMELINE_LIMIT + 5; i++) {
      room = appendTimeline(room, entry(`e${i}`, `entry ${i}`))
    }
    expect(room.timeline).toHaveLength(TIMELINE_LIMIT)
    expect(room.timeline?.[0]?.id).toBe('e5')
    expect(room.timeline?.at(-1)?.id).toBe(`e${TIMELINE_LIMIT + 4}`)
  })
})

describe('recentTimeline', () => {
  test('ranks exact thread and node scopes above block and page rows', () => {
    let room = emptyRoom('p')
    room = appendTimeline(room, {
      ...entry('page', 'page row'),
      scope: {},
    })
    room = appendTimeline(room, {
      ...entry('block', 'block row'),
      scope: { blockId: 'b1' },
    })
    room = appendTimeline(room, {
      ...entry('node', 'node row'),
      scope: { blockId: 'b1', nodeKey: 'nodes/b1:0' },
    })
    room = appendTimeline(room, {
      ...entry('thread', 'thread row'),
      scope: { threadId: 't1' },
    })
    expect(recentTimeline(room, { blockId: 'b1', nodeKey: 'nodes/b1:0' }, 2).map((e) => e.id)).toEqual([
      'node',
      'block',
    ])
    expect(recentTimeline(room, { threadId: 't1' }, 1)[0]?.id).toBe('thread')
  })

  test('returns newest first within a scope', () => {
    let room = emptyRoom('p')
    room = appendTimeline(room, entry('old', 'old', '2026-11-12T21:00:00.000Z'))
    room = appendTimeline(room, entry('new', 'new', '2026-11-12T22:00:00.000Z'))
    expect(recentTimeline(room, { blockId: 'b1' }).map((e) => e.id)).toEqual(['new', 'old'])
  })
})

describe('summarizeTimeline', () => {
  test('folds entries oldest first and respects a byte cap', () => {
    const entries = [
      entry('b', 'second', '2026-11-12T22:01:00.000Z'),
      entry('a', 'first', '2026-11-12T22:00:00.000Z'),
    ]
    expect(summarizeTimeline(entries)).toBe('first; second')
    expect(summarizeTimeline(entries, 8)).toBe('first')
    expect(summarizeTimeline(entries, 0)).toBe('')
  })
})

describe('entry builders', () => {
  test('excerpt is single-line and code-point safe', () => {
    expect(excerpt('  a\n\nb  ')).toBe('a b')
    expect(excerpt('😀😀😀', 2)).toBe('😀…')
  })

  test('userEditEntry stores only excerpts and a stable id', () => {
    const built = userEditEntry({
      eventId: 'e1',
      at,
      target: target(),
      before: 'old',
      added: 'x'.repeat(300),
      removed: 'y'.repeat(300),
    })
    expect(built.id).toBe('e1:user_edit:nodes/b1:0')
    expect(built.summary.length).toBeLessThanOrEqual(200)
    expect(built.data?.added?.length).toBeLessThanOrEqual(120)
    expect(built.data?.removed?.length).toBeLessThanOrEqual(120)
  })

  test('triage and intent entries carry the decision, not the prompt', () => {
    const triage = triageEntry({
      eventId: 'e1',
      at,
      surface: 'body',
      scope: { blockId: 'b1', nodeKey: 'nodes/b1:0' },
      triage: {
        outcome: 'new_action',
        intentId: 'i1',
        confidence: 0.8,
        reason: 'request language',
        source: 'rules',
      },
    })
    expect(triage.data).toMatchObject({ outcome: 'new_action', source: 'rules' })
    expect(triage.id).toBe('e1:triage:nodes/b1:0')

    const version = intentVersionEntry({ at, intent: intent(), previousVersion: 1 })
    expect(version.summary).toContain('v1 -> v2')
    expect(version.id).toBe('i1:v2:intent_version')
  })

  test('reply and failure entries stay compact', () => {
    const reply = replyEntry({
      at,
      key: 'nodes/b1:0',
      surface: 'body',
      blockId: 'b1',
      generation: 1,
      intentId: 'i1',
      intentVersion: 1,
      threadId: 't1',
      messageId: 'm1',
      body: 'z'.repeat(400),
      edited: true,
    })
    expect(reply.kind).toBe('reply_updated')
    expect(reply.summary.length).toBeLessThanOrEqual(200)
    expect(reply.scope).toMatchObject({ blockId: 'b1', threadId: 't1', nodeKey: 'nodes/b1:0' })

    const failure = failureEntry({
      at,
      key: 'nodes/b1:0',
      surface: 'body',
      blockId: 'b1',
      threadId: null,
      generation: 1,
      failures: 2,
      message: 'gateway down',
    })
    expect(failure.kind).toBe('failure')
    expect(failure.summary).toContain('gateway down')
  })

  test('attempt entries distinguish started and discarded', () => {
    expect(
      attemptEntry({
        at,
        key: 'nodes/b1:0',
        blockId: 'b1',
        generation: 1,
        intentId: 'i1',
        intentVersion: 1,
        kind: 'attempt_started',
      }).kind,
    ).toBe('attempt_started')
    expect(
      attemptEntry({
        at,
        key: 'nodes/b1:0',
        blockId: 'b1',
        generation: 1,
        intentId: 'i1',
        intentVersion: 1,
        kind: 'attempt_discarded',
      }).id,
    ).toBe('nodes/b1:0:1:1:attempt_discarded')
  })

  test('comment entries keep the thread reference and omit the full body', () => {
    const built = userCommentEntry({
      eventId: 'e1',
      at,
      change: {
        surface: 'comment',
        change: 'inserted',
        threadId: 't1',
        messageId: 'm1',
        blockId: 'b1',
        body: 'q'.repeat(400),
        authorPrincipal: 'person',
        authorDisplayName: 'Sam',
        driver: 'Browser',
        actorKind: 'person',
        priority: 1,
      },
    })
    expect(built.scope).toEqual({ threadId: 't1', blockId: 'b1' })
    expect(built.summary.length).toBeLessThanOrEqual(200)
  })
})
