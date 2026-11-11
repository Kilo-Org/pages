import { describe, expect, test } from 'bun:test'
import {
  admitIntent,
  attachThreadToIntent,
  bumpIntentVersion,
  cancelStaleSteps,
  clearSelection,
  closeIntentForTarget,
  forgetThread,
  commitIsCurrent,
  emptyRoom,
  findActiveIntentForTarget,
  migrateNodes,
  noteSelection,
  noteUserChange,
  recordBodyChange,
  recordCommentEvidence,
  recordTarget,
  removeTarget,
  type PlanStep,
  type RoomState,
  type TargetState,
} from './room.ts'

const at = '2026-11-10T00:00:00.000Z'

const target = (overrides: Partial<TargetState> = {}): TargetState => ({
  key: 'nodes/b1:0',
  pageId: 'p',
  blockId: 'b1',
  text: 'Hello',
  changedAt: 1,
  evaluatedText: null,
  failures: 0,
  lastAttemptAt: 0,
  threadId: null,
  messageId: null,
  lastReply: null,
  generation: 0,
  assumedIntentVersion: null,
  ...overrides,
})

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: 's1',
  intentId: 'intent',
  intentVersion: 1,
  status: 'pending',
  description: 'answer',
  owner: null,
  dependsOn: [],
  assumedRevision: null,
  ...overrides,
})

describe('intents', () => {
  test('admitIntent creates an active version 1 intent with a sequential id', () => {
    const { room, intent } = admitIntent(
      emptyRoom('p'),
      {
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' },
        outputKind: 'comment',
        confidence: 1,
        evidence: [{ eventId: 'e1', at }],
      },
      at,
    )
    expect(intent).toMatchObject({ id: 'nodes/b1:0:action:1', version: 1, status: 'active' })
    expect(room.intentSeq).toBe(1)
    expect(room.intents[intent.id]).toEqual(intent)
    expect(findActiveIntentForTarget(room, 'nodes/b1:0')?.id).toBe(intent.id)
  })

  test('bumpIntentVersion increments, appends evidence, and marks older steps stale', () => {
    const base = admitIntent(
      emptyRoom('p'),
      {
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' },
        outputKind: 'comment',
        confidence: 1,
        evidence: [{ eventId: 'e1', at }],
      },
      at,
    )
    const withSteps: RoomState = {
      ...base.room,
      steps: {
        old: step({ intentId: base.intent.id }),
        current: step({ id: 's2', intentId: base.intent.id, intentVersion: 2 }),
        other: step({ id: 's3', intentId: 'other' }),
      },
    }
    const next = bumpIntentVersion(withSteps, base.intent.id, { eventId: 'e2', at }, at)
    expect(next.intents[base.intent.id]?.version).toBe(2)
    expect(next.intents[base.intent.id]?.evidence).toHaveLength(2)
    expect(next.steps.old?.status).toBe('stale')
    expect(next.steps.current?.status).toBe('pending')
    expect(next.steps.other?.status).toBe('pending')
  })

  test('cancelStaleSteps only cancels unowned stale steps, idempotently', () => {
    const room: RoomState = {
      ...emptyRoom('p'),
      steps: {
        unowned: step({ status: 'stale' }),
        owned: step({ id: 's2', status: 'stale', owner: 'worker' }),
        active: step({ id: 's3', status: 'active' }),
      },
    }
    const once = cancelStaleSteps(room, 'intent')
    expect(once.steps.unowned?.status).toBe('cancelled')
    expect(once.steps.owned?.status).toBe('stale')
    expect(once.steps.active?.status).toBe('active')
    expect(cancelStaleSteps(once, 'intent')).toBe(once)
  })

  test('an unknown intent id is a no-op', () => {
    const room = emptyRoom('p')
    expect(bumpIntentVersion(room, 'missing', { eventId: 'e', at }, at)).toBe(room)
  })
})

describe('targets and the commit fence', () => {
  test('noteUserChange bumps generation and adopts the intent version', () => {
    const admitted = admitIntent(
      emptyRoom('p'),
      {
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' },
        outputKind: 'comment',
        confidence: 1,
        evidence: [{ eventId: 'e1', at }],
      },
      at,
    )
    const room = recordTarget(admitted.room, target({ generation: 3 }))
    const next = noteUserChange(room, 'nodes/b1:0', admitted.intent.id)
    expect(next.targets['nodes/b1:0']).toMatchObject({
      generation: 4,
      assumedIntentVersion: 1,
    })
  })

  test('commitIsCurrent rejects moved text, a newer generation, or a newer intent version', () => {
    const room = recordTarget(
      emptyRoom('p'),
      target({ generation: 2, assumedIntentVersion: 1 }),
    )
    expect(
      commitIsCurrent(room, 'nodes/b1:0', {
        text: 'Hello',
        generation: 2,
        intentVersion: 1,
      }),
    ).toBe(true)
    expect(
      commitIsCurrent(room, 'nodes/b1:0', {
        text: 'Other',
        generation: 2,
        intentVersion: 1,
      }),
    ).toBe(false)
    expect(
      commitIsCurrent(room, 'nodes/b1:0', {
        text: 'Hello',
        generation: 3,
        intentVersion: 1,
      }),
    ).toBe(false)
    expect(
      commitIsCurrent(room, 'nodes/b1:0', {
        text: 'Hello',
        generation: 2,
        intentVersion: 2,
      }),
    ).toBe(false)
  })

  test('recordBodyChange creates then bumps the target intent', () => {
    const first = recordBodyChange(emptyRoom('p'), target(), { eventId: 'e1', at }, at)
    const intent = findActiveIntentForTarget(first, 'nodes/b1:0')
    expect(intent?.version).toBe(1)
    expect(first.targets['nodes/b1:0']).toMatchObject({
      generation: 1,
      assumedIntentVersion: 1,
    })

    const second = recordBodyChange(
      first,
      target({ text: 'Hello again' }),
      { eventId: 'e2', at },
      at,
    )
    expect(findActiveIntentForTarget(second, 'nodes/b1:0')?.version).toBe(2)
    expect(second.targets['nodes/b1:0']).toMatchObject({
      text: 'Hello again',
      generation: 2,
      assumedIntentVersion: 2,
    })
  })

  test('a new admission after abandonment keeps both intents', () => {
    const first = admitIntent(
      emptyRoom('p'),
      {
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' },
        outputKind: 'comment',
        confidence: 1,
        evidence: [],
      },
      at,
    )
    const abandoned = closeIntentForTarget(first.room, 'nodes/b1:0')
    const second = admitIntent(
      abandoned,
      {
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' },
        outputKind: 'comment',
        confidence: 1,
        evidence: [],
      },
      at,
    )
    expect(first.intent.id).not.toBe(second.intent.id)
    expect(second.room.intents[first.intent.id]?.status).toBe('abandoned')
    expect(second.room.intents[second.intent.id]).toMatchObject({ version: 1, status: 'active' })
  })

  test('forgetThread clears reply identity and abandons the thread intent', () => {
    const admitted = admitIntent(
      emptyRoom('p'),
      {
        kind: 'action',
        targetScope: {
          pageId: 'p',
          blockId: 'b1',
          nodeKey: 'nodes/b1:0',
          threadId: 't1',
        },
        outputKind: 'comment',
        confidence: 1,
        evidence: [],
      },
      at,
    )
    const room = recordTarget(
      admitted.room,
      target({ threadId: 't1', messageId: 'm1', lastReply: 'old', evaluatedText: 'Hello' }),
    )
    const next = forgetThread(room, 't1')
    expect(next.targets['nodes/b1:0']).toMatchObject({
      threadId: null,
      messageId: null,
      lastReply: null,
      evaluatedText: 'Hello',
    })
    expect(next.intents[admitted.intent.id]?.status).toBe('abandoned')
  })

  test('attachThreadToIntent fills the scope once', () => {
    const admitted = admitIntent(
      emptyRoom('p'),
      {
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' },
        outputKind: 'comment',
        confidence: 1,
        evidence: [],
      },
      at,
    )
    const attached = attachThreadToIntent(admitted.room, admitted.intent.id, 't1')
    expect(attached.intents[admitted.intent.id]?.targetScope.threadId).toBe('t1')
    expect(attachThreadToIntent(attached, admitted.intent.id, 't1')).toBe(attached)
  })

  test('removeTarget abandons its intent', () => {
    const room = recordBodyChange(emptyRoom('p'), target(), { eventId: 'e1', at }, at)
    const intent = findActiveIntentForTarget(room, 'nodes/b1:0')!
    const next = removeTarget(room, 'nodes/b1:0')
    expect(next.targets['nodes/b1:0']).toBeUndefined()
    expect(next.intents[intent.id]?.status).toBe('abandoned')
  })
})

describe('comments and selections as evidence', () => {
  const withIntent = () => {
    const admitted = admitIntent(
      emptyRoom('p'),
      {
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' },
        outputKind: 'comment',
        confidence: 1,
        evidence: [],
      },
      at,
    )
    return { room: admitted.room, id: admitted.intent.id }
  }

  test('a comment on the intent block adds evidence once', () => {
    const { room, id } = withIntent()
    const change = {
      surface: 'comment' as const,
      change: 'inserted',
      threadId: 't1',
      messageId: 'm1',
      blockId: 'b1',
      body: 'hi',
      authorPrincipal: 'person-1',
      authorDisplayName: 'Person',
      driver: 'Browser',
      actorKind: 'person' as const,
      priority: 1 as const,
    }
    const once = recordCommentEvidence(room, change, 'e1', at)
    expect(once.intents[id]?.evidence).toHaveLength(1)
    expect(recordCommentEvidence(once, change, 'e1', at)).toBe(once)
  })

  test('a comment with no matching intent changes nothing', () => {
    const room = emptyRoom('p')
    const change = {
      surface: 'comment' as const,
      change: 'inserted',
      threadId: 't9',
      messageId: 'm1',
      blockId: 'b9',
      body: 'hi',
      authorPrincipal: 'person-1',
      authorDisplayName: 'Person',
      driver: 'Browser',
      actorKind: 'person' as const,
      priority: 1 as const,
    }
    expect(recordCommentEvidence(room, change, 'e1', at)).toBe(room)
  })

  test('noteSelection keeps one evidence ref per peer and clear removes it', () => {
    const { room, id } = withIntent()
    const change = {
      surface: 'selection' as const,
      change: 'selected' as const,
      peerId: 'peer-1',
      principal: 'person-1',
      displayName: 'Person',
      driver: 'Browser',
      blockId: 'b1',
      kind: 'selection' as const,
      startUtf16: 0,
      endUtf16: 3,
      quote: 'abc',
      observedAt: at,
      actorKind: 'person' as const,
      priority: 2 as const,
    }
    const next = noteSelection(room, change)
    expect(next.selections['peer-1']).toMatchObject({ blockId: 'b1', quote: 'abc' })
    expect(next.intents[id]?.evidence).toHaveLength(1)
    expect(next.intents[id]?.version).toBe(1)

    const moved = noteSelection(next, {
      ...change,
      change: 'updated',
      startUtf16: 4,
      endUtf16: 7,
      quote: 'def',
      observedAt: '2026-11-10T00:00:01.000Z',
    })
    expect(moved.selections['peer-1']).toMatchObject({ quote: 'def' })
    expect(moved.intents[id]?.evidence).toHaveLength(1)

    const cleared = clearSelection(moved, 'peer-1')
    expect(cleared.selections['peer-1']).toBeUndefined()
    expect(cleared.intents[id]?.evidence).toHaveLength(0)
  })

  test('moving a selection to another block moves its evidence', () => {
    const first = admitIntent(
      emptyRoom('p'),
      {
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' },
        outputKind: 'comment',
        confidence: 1,
        evidence: [],
      },
      at,
    )
    const room = admitIntent(
      first.room,
      {
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b2', nodeKey: 'nodes/b2:0' },
        outputKind: 'comment',
        confidence: 1,
        evidence: [],
      },
      at,
    ).room
    const change = {
      surface: 'selection' as const,
      change: 'selected' as const,
      peerId: 'peer-1',
      principal: 'person-1',
      displayName: 'Person',
      driver: 'Browser',
      blockId: 'b1',
      kind: 'selection' as const,
      startUtf16: 0,
      endUtf16: 1,
      quote: 'a',
      observedAt: at,
      actorKind: 'person' as const,
      priority: 2 as const,
    }
    const onB1 = noteSelection(room, change)
    const onB2 = noteSelection(onB1, { ...change, blockId: 'b2', quote: 'b' })
    expect(onB2.intents[first.intent.id]?.evidence).toHaveLength(0)
    expect(onB2.intents[Object.keys(onB2.intents).find((id) => id !== first.intent.id)!]?.evidence).toHaveLength(1)
  })
})

describe('migration', () => {
  test('preserves reply identity and ignores stale plain-string values', () => {
    const room = migrateNodes(
      {
        'nodes/b1:0': {
          blockId: 'b1',
          text: 'Hello',
          changedAt: 5,
          evaluatedText: 'Hello',
          failures: 1,
          lastAttemptAt: 6,
          threadId: 't1',
          messageId: 'm1',
          lastReply: 'Hi',
        },
        'nodes/b2:0': 'old string',
      },
      'p',
    )
    expect(room.targets['nodes/b1:0']).toMatchObject({
      text: 'Hello',
      threadId: 't1',
      messageId: 'm1',
      lastReply: 'Hi',
      generation: 0,
      assumedIntentVersion: null,
    })
    expect(room.targets['nodes/b2:0']).toBeUndefined()
  })
})
