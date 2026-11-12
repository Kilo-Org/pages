import { describe, expect, test } from 'bun:test'
import {
  activateStep,
  admitIntent,
  applyTriage,
  bumpIntentVersion,
  cancelPlan,
  cancelStaleSteps,
  clearSelection,
  commitIsCurrent,
  completePlan,
  completeStep,
  emptyRoom,
  failStep,
  findActiveIntentForTarget,
  migrateNodes,
  nextStep,
  noteSelection,
  noteUserChange,
  planIntent,
  recordBodyChange,
  recordCommentEvidence,
  recordTarget,
  removeTarget,
  stepsForVersion,
  validatePlanSteps,
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
  previousText: null,
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
  key: 's1',
  intentId: 'intent',
  intentVersion: 1,
  status: 'pending',
  kind: 'draft_reply',
  description: 'answer',
  position: 0,
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

  test('applyTriage admits an intent without inventing a plan', () => {
    const applied = applyTriage(
      emptyRoom('p'),
      { intentId: null, kind: 'action', targetScope: scope, confidence: 0.9, evidence: { eventId: 'e1', at } },
      at,
      false,
    )
    expect(applied.intent?.kind).toBe('action')
    expect(applied.room.steps).toEqual({})
  })

  test('applyTriage with bump: true cancels the prior stale step without creating a new one', () => {
    const admitted = applyTriage(
      emptyRoom('p'),
      { intentId: null, kind: 'action', targetScope: scope, confidence: 0.9, evidence: { eventId: 'e1', at } },
      at,
      false,
    )
    const intentId = admitted.intent!.id
    const planned = planIntent(admitted.room, intentId, 1, [
      { key: 'draft', kind: 'draft_reply', description: 'Draft' },
    ])
    const active = activateStep(planned, stepsForVersion(planned, intentId, 1)[0]!.id)
    const bumped = applyTriage(
      active,
      { intentId, kind: 'correction', targetScope: scope, confidence: 0.8, evidence: { eventId: 'e2', at } },
      at,
      true,
    )
    expect(bumped.room.intents[intentId]?.version).toBe(2)
    expect(stepsForVersion(bumped.room, intentId, 1)[0]?.status).toBe('cancelled')
    expect(stepsForVersion(bumped.room, intentId, 2)).toEqual([])
  })

  test('a new body node does not reuse a different node intent in the same block', () => {
    const first = applyTriage(
      emptyRoom('p'),
      {
        intentId: null,
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:0' },
        confidence: 1,
        evidence: { eventId: 'e1', at },
      },
      at,
      false,
    )
    const second = applyTriage(
      first.room,
      {
        intentId: null,
        kind: 'action',
        targetScope: { pageId: 'p', blockId: 'b1', nodeKey: 'nodes/b1:1' },
        confidence: 1,
        evidence: { eventId: 'e2', at },
      },
      at,
      false,
    )
    expect(second.intent?.targetScope.nodeKey).toBe('nodes/b1:1')
    expect(Object.keys(second.room.intents)).toHaveLength(2)
  })

  test('planIntent creates ordered steps with dependencies and nextStep picks the first', () => {
    const admitted = applyTriage(
      emptyRoom('p'),
      { intentId: null, kind: 'action', targetScope: scope, confidence: 0.9, evidence: { eventId: 'e1', at } },
      at,
      false,
    )
    const intentId = admitted.intent!.id
    const room = planIntent(admitted.room, intentId, 1, [
      { key: 'draft', kind: 'draft_reply', description: 'Draft' },
      { key: 'post', kind: 'post_reply', description: 'Post', dependsOn: ['draft'] },
    ])
    const steps = stepsForVersion(room, intentId, 1)
    expect(steps.map((s) => s.id)).toEqual([`${intentId}:1:draft`, `${intentId}:1:post`])
    expect(steps[1]?.dependsOn).toEqual([`${intentId}:1:draft`])
    expect(nextStep(room, intentId)?.id).toBe(`${intentId}:1:draft`)

    const first = activateStep(room, `${intentId}:1:draft`)
    expect(nextStep(first, intentId)?.id).toBe(`${intentId}:1:draft`)
    const done = completeStep(first, `${intentId}:1:draft`)
    expect(nextStep(done, intentId)?.id).toBe(`${intentId}:1:post`)
  })

  test('plan validation rejects duplicates, missing dependencies, cycles, and oversized plans', () => {
    expect(
      validatePlanSteps([
        { key: 'a', kind: 'draft_reply', description: 'A' },
        { key: 'a', kind: 'post_reply', description: 'B' },
      ]),
    ).toContain('duplicate')
    expect(
      validatePlanSteps([{ key: 'a', kind: 'draft_reply', description: 'A', dependsOn: ['x'] }]),
    ).toContain('missing')
    expect(
      validatePlanSteps([
        { key: 'a', kind: 'draft_reply', description: 'A', dependsOn: ['b'] },
        { key: 'b', kind: 'post_reply', description: 'B', dependsOn: ['a'] },
      ]),
    ).toContain('cycle')
    expect(
      validatePlanSteps(
        Array.from({ length: 31 }, (_, i) => ({
          key: `s${i}`,
          kind: 'draft_reply' as const,
          description: 'x',
        })),
      ),
    ).toContain('thirty')
  })

  test('planIntent rejects a stale version and does not overwrite executed work', () => {
    const admitted = applyTriage(
      emptyRoom('p'),
      { intentId: null, kind: 'action', targetScope: scope, confidence: 0.9, evidence: { eventId: 'e1', at } },
      at,
      false,
    )
    const intentId = admitted.intent!.id
    expect(planIntent(admitted.room, intentId, 2, [{ key: 'x', kind: 'draft_reply', description: 'x' }])).toBe(
      admitted.room,
    )
    const planned = planIntent(admitted.room, intentId, 1, [
      { key: 'draft', kind: 'draft_reply', description: 'Draft' },
    ])
    const done = completeStep(planned, `${intentId}:1:draft`)
    expect(
      planIntent(done, intentId, 1, [{ key: 'other', kind: 'post_reply', description: 'Other' }]),
    ).toBe(done)
  })

  test('a stale step cannot be completed, failed work retries, and cancelPlan settles it', () => {
    const admitted = applyTriage(
      emptyRoom('p'),
      { intentId: null, kind: 'action', targetScope: scope, confidence: 0.9, evidence: { eventId: 'e1', at } },
      at,
      false,
    )
    const intentId = admitted.intent!.id
    const planned = planIntent(admitted.room, intentId, 1, [
      { key: 'draft', kind: 'draft_reply', description: 'Draft' },
    ])
    const active = activateStep(planned, `${intentId}:1:draft`)
    expect(failStep(active, `${intentId}:1:draft`).steps[`${intentId}:1:draft`]?.status).toBe('pending')
    expect(completePlan(active, intentId).steps[`${intentId}:1:draft`]?.status).toBe('done')
    expect(cancelPlan(active, intentId).steps[`${intentId}:1:draft`]?.status).toBe('cancelled')
    const bumped = bumpIntentVersion(active, intentId, { eventId: 'e2', at }, at)
    expect(completeStep(bumped, `${intentId}:1:draft`)).toBe(bumped)
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
