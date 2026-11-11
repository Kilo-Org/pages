import { describe, expect, test } from 'bun:test'
import {
  admitIntent,
  applyTriage,
  bumpIntentVersion,
  cancelStaleSteps,
  clearSelection,
  commitIsCurrent,
  emptyRoom,
  ensureStep,
  findActiveIntentForTarget,
  findCurrentStep,
  markStepActive,
  markStepDone,
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
  test('admitIntent creates an active version 1 intent with a deterministic id', () => {
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
    expect(intent).toMatchObject({ id: 'nodes/b1:0:action', version: 1, status: 'active' })
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
    const next = noteUserChange(room, 'nodes/b1:0', admitted.intent.id, at)
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

  test('recordBodyChange carries the fence and bumps an existing intent', () => {
    const first = recordBodyChange(emptyRoom('p'), target(), { eventId: 'e1', at }, at)
    expect(findActiveIntentForTarget(first, 'nodes/b1:0')).toBeUndefined()
    expect(first.targets['nodes/b1:0']).toMatchObject({
      generation: 1,
      assumedIntentVersion: null,
    })

    const admitted = admitIntent(
      first,
      {
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' },
        outputKind: 'comment',
        confidence: 1,
        evidence: [{ eventId: 'e1', at }],
      },
      at,
    )
    const fenced = recordTarget(admitted.room, {
      ...first.targets['nodes/b1:0']!,
      assumedIntentVersion: admitted.intent.version,
    })
    const second = recordBodyChange(
      fenced,
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

  test('removeTarget abandons its intent', () => {
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
    const room = recordTarget(admitted.room, target())
    const next = removeTarget(room, 'nodes/b1:0')
    expect(next.targets['nodes/b1:0']).toBeUndefined()
    expect(next.intents[admitted.intent.id]?.status).toBe('abandoned')
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

  test('noteSelection records scope evidence and clearSelection removes it', () => {
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
    expect(clearSelection(next, 'peer-1').selections['peer-1']).toBeUndefined()
  })
})

describe('plan steps', () => {
  const scope = { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' }

  test('applyTriage admits an intent and its one current-version step, pending', () => {
    const room = applyTriage(
      emptyRoom('p'),
      { intentId: null, kind: 'action', targetScope: scope, confidence: 0.9, evidence: { eventId: 'e1', at } },
      at,
      false,
    )
    const intentId = Object.keys(room.intents)[0]!
    expect(room.steps[`${intentId}:1`]).toMatchObject({
      intentId,
      intentVersion: 1,
      status: 'pending',
      description: 'produce a reply addressing the request',
    })
  })

  test('applyTriage with bump: true cancels the prior stale step and admits a fresh one', () => {
    const admitted = applyTriage(
      emptyRoom('p'),
      { intentId: null, kind: 'action', targetScope: scope, confidence: 0.9, evidence: { eventId: 'e1', at } },
      at,
      false,
    )
    const intentId = Object.keys(admitted.intents)[0]!
    const bumped = applyTriage(
      admitted,
      { intentId, kind: 'correction', targetScope: scope, confidence: 0.8, evidence: { eventId: 'e2', at } },
      at,
      true,
    )
    expect(bumped.intents[intentId]?.version).toBe(2)
    expect(bumped.steps[`${intentId}:1`]?.status).toBe('cancelled')
    expect(bumped.steps[`${intentId}:2`]).toMatchObject({
      status: 'pending',
      description: 'revise the reply for the corrected request',
    })
  })

  test('ensureStep relabels the current step in place instead of resetting its status', () => {
    const admitted = applyTriage(
      emptyRoom('p'),
      { intentId: null, kind: 'action', targetScope: scope, confidence: 0.9, evidence: { eventId: 'e1', at } },
      at,
      false,
    )
    const intentId = Object.keys(admitted.intents)[0]!
    const active = markStepActive(admitted, intentId)
    const relabeled = ensureStep(active, intentId, 'answer the question')
    expect(relabeled.steps[`${intentId}:1`]).toMatchObject({
      status: 'active',
      description: 'answer the question',
    })
  })

  test('markStepActive/markStepDone are no-ops without a current step', () => {
    const room = emptyRoom('p')
    expect(markStepActive(room, 'missing')).toBe(room)
    expect(markStepDone(room, 'missing')).toBe(room)
    expect(findCurrentStep(room, 'missing')).toBeUndefined()
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
