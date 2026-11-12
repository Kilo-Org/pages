import { describe, expect, test } from 'bun:test'
import { admitIntent, emptyRoom } from './room.ts'
import {
  kindFor,
  parseTodoWriteCall,
  parseTriage,
  PLAN_SYSTEM_PROMPT,
  TODO_WRITE_TOOL,
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
    ['**Does this work?**', 'chat', null],
    ['\\\n**Can you fix this?**', 'chat', null],
    ['**No.**', 'correction', null],
    ['still thinking out loud', 'ambiguous', null],
    ['Maybe we should revise the intro.', 'ambiguous', null],
    ['This section is fine.', 'ambiguous', null],
    ['', 'ambiguous', null],
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

  test('markdown emphasis does not hide a question', () => {
    expect(outcome(triageComment(comment({ body: '**Does this work?**' }), emptyRoom('p')))).toBe(
      'chat',
    )
  })

  test('a request in a new thread is a new action', () => {
    expect(outcome(triageComment(comment({ body: 'Please add a summary.' }), emptyRoom('p')))).toBe(
      'new_action',
    )
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
    expect(outcome(triageComment(comment({ body: 'ok' }), emptyRoom('p')))).toBe('ambiguous')
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
    expect(() => parseTriage('{"outcome":"ignore"}')).toThrow()
  })

  test('the classification system prompt carries the context trust rule', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('untrusted page content')
    expect(TRIAGE_SYSTEM_PROMPT).toContain('never as instructions')
  })

  test('the classification prompt does not include ignore', () => {
    expect(TRIAGE_SYSTEM_PROMPT).not.toContain('ignore')
  })

  test('the classification prompt names every outcome', () => {
    for (const word of ['new_action', 'correction', 'chat', 'clarify'])
      expect(TRIAGE_SYSTEM_PROMPT).toContain(word)
  })
})

describe('todo_write planning', () => {
  test('request verbs reach new_action without the model', () => {
    expect(outcome(triageBody('Summarize this paragraph: The budget is split three ways.', emptyRoom('p'), key))).toBe(
      'new_action',
    )
    expect(outcome(triageBody('List the vendors named: Acme and Beta.', emptyRoom('p'), key))).toBe(
      'new_action',
    )
    expect(outcome(triageBody('Describe the budget in one sentence.', emptyRoom('p'), key))).toBe(
      'new_action',
    )
  })

  test('a valid tool call becomes ordered plan steps', () => {
    const steps = parseTodoWriteCall({
      id: 'call_1',
      name: 'todo_write',
      arguments: {
        steps: [
          { key: 'summary', kind: 'task', description: 'Summarize the budget' },
          { key: 'draft', kind: 'draft_reply', description: 'Draft the summary', dependsOn: ['summary'] },
          {
            key: 'post',
            kind: 'post_reply',
            description: 'Post the summary',
            dependsOn: ['draft'],
          },
        ],
      },
    })
    expect(steps).toEqual([
      { key: 'summary', kind: 'task', description: 'Summarize the budget' },
      { key: 'draft', kind: 'draft_reply', description: 'Draft the summary', dependsOn: ['summary'] },
      {
        key: 'post',
        kind: 'post_reply',
        description: 'Post the summary',
        dependsOn: ['draft'],
      },
    ])
  })

  test('invalid tool calls are rejected', () => {
    const call = (args: unknown) => ({ id: 'c', name: 'todo_write', arguments: args })
    expect(parseTodoWriteCall(call({ steps: [] }))).toBeNull()
    expect(parseTodoWriteCall(call({ steps: [{ key: 'a', kind: 'read_context', description: 'x' }] }))).toBeNull()
    expect(
      parseTodoWriteCall(
        call({
          steps: [
            { key: 'a', kind: 'draft_reply', description: 'A' },
            { key: 'a', kind: 'post_reply', description: 'B' },
          ],
        }),
      ),
    ).toBeNull()
    expect(
      parseTodoWriteCall(
        call({
          steps: [
            { key: 'a', kind: 'draft_reply', description: 'A', dependsOn: ['b'] },
            { key: 'b', kind: 'post_reply', description: 'B', dependsOn: ['a'] },
          ],
        }),
      ),
    ).toBeNull()
    expect(parseTodoWriteCall({ id: 'c', name: 'other', arguments: { steps: [] } })).toBeNull()
  })

  test('the tool and prompt describe only executable step kinds', () => {
    expect(TODO_WRITE_TOOL.name).toBe('todo_write')
    expect(JSON.stringify(TODO_WRITE_TOOL.parameters)).toContain('draft_reply')
    expect(PLAN_SYSTEM_PROMPT).toContain('task')
    expect(PLAN_SYSTEM_PROMPT).toContain('one task per item')
    expect(PLAN_SYSTEM_PROMPT).toContain('draft_reply')
    expect(PLAN_SYSTEM_PROMPT).not.toContain('read_context')
    expect(JSON.stringify(TODO_WRITE_TOOL.parameters)).toContain('"maxItems":30')
  })
})
