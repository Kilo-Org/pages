import { describe, expect, test } from 'bun:test'
import { admitIntent, emptyRoom } from './room.ts'
import {
  kindFor,
  parseTriage,
  triageBody,
  triageComment,
  TRIAGE_SYSTEM_PROMPT,
} from './triage.ts'

const at = '2026-11-10T00:00:00.000Z'
const key = 'nodes/b1:0'

const roomWithTargetIntent = () =>
  admitIntent(
    emptyRoom('p'),
    {
      kind: 'action',
      targetScope: { pageId: 'p', blockId: 'b1', nodeKey: key },
      outputKind: 'comment',
      confidence: 1,
      evidence: [],
    },
    at,
  ).room

const comment = (overrides: Record<string, unknown> = {}) => ({
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

const outcome = (value: ReturnType<typeof triageBody>) =>
  'ambiguous' in value ? 'ambiguous' : value.outcome

describe('triageBody', () => {
  const cases: [string, string, string | null][] = [
    ['Please tighten this paragraph.', 'new_action', null],
    ['Does this work?', 'chat', null],
    ['What does this mean?', 'chat', null],
    ['still thinking out loud', 'ignore', null],
    ['Maybe we should revise the intro.', 'ambiguous', null],
    ['This section is fine.', 'ignore', null],
  ]

  for (const [text, expected, intentId] of cases) {
    test(`${JSON.stringify(text)} -> ${expected}`, () => {
      const verdict = triageBody(text, emptyRoom('p'), key)
      expect(outcome(verdict)).toBe(expected)
      expect('ambiguous' in verdict ? null : verdict.intentId).toBe(intentId)
    })
  }

  test('a change on an active target is a correction, and carries the intent id', () => {
    const room = roomWithTargetIntent()
    const verdict = triageBody('This section is fine.', room, key)
    expect(outcome(verdict)).toBe('correction')
    expect('ambiguous' in verdict ? null : verdict.intentId).toBe(
      Object.keys(room.intents)[0]!,
    )
  })

  test('explicit correction language wins over the overlap rule', () => {
    const room = roomWithTargetIntent()
    const verdict = triageBody('Actually make it shorter.', room, key)
    expect(outcome(verdict)).toBe('correction')
  })
})

describe('triageComment', () => {
  test('a question in a new thread is chat', () => {
    expect(outcome(triageComment(comment(), emptyRoom('p')))).toBe('chat')
  })

  test('a request in a new thread is a new action', () => {
    expect(outcome(triageComment(comment({ body: 'Please add a summary.' }), emptyRoom('p')))).toBe(
      'new_action',
    )
  })

  test('deleted threads are ignored', () => {
    expect(outcome(triageComment(comment({ change: 'deleted' }), emptyRoom('p')))).toBe('ignore')
  })

  test('a statement reply on an intent thread is a correction', () => {
    const admitted = admitIntent(
      emptyRoom('p'),
      {
        kind: 'chat',
        targetScope: { pageId: 'p', blockId: 'b1', threadId: 't1' },
        outputKind: 'comment',
        confidence: 1,
        evidence: [],
      },
      at,
    )
    const verdict = triageComment(comment({ body: 'This paragraph is fine.' }), admitted.room)
    expect(outcome(verdict)).toBe('correction')
    expect('ambiguous' in verdict ? null : verdict.intentId).toBe(admitted.intent.id)
  })

  test('short comments and hedged requests', () => {
    expect(outcome(triageComment(comment({ body: 'ok' }), emptyRoom('p')))).toBe('ignore')
    expect(
      outcome(triageComment(comment({ body: 'Maybe we should rework the intro.' }), emptyRoom('p'))),
    ).toBe('ambiguous')
  })
})

describe('kinds and parsing', () => {
  test('outcomes map to intent kinds', () => {
    expect(kindFor('new_action')).toBe('action')
    expect(kindFor('correction')).toBe('correction')
    expect(kindFor('chat')).toBe('chat')
    expect(kindFor('clarify')).toBe('clarify')
    expect(kindFor('ignore')).toBeNull()
  })

  test('parseTriage accepts strict JSON and strips fences', () => {
    const parsed = parseTriage('```json\n{"outcome":"correction","confidence":0.8}\n```')
    expect(parsed).toMatchObject({
      outcome: 'correction',
      confidence: 0.8,
      source: 'model',
    })
  })

  test('parseTriage rejects malformed output', () => {
    expect(() => parseTriage('{oops')).toThrow()
    expect(() => parseTriage('{"outcome":"dance"}')).toThrow()
  })

  test('the classification prompt names every outcome', () => {
    for (const word of ['new_action', 'correction', 'chat', 'clarify', 'ignore'])
      expect(TRIAGE_SYSTEM_PROMPT).toContain(word)
  })
})
