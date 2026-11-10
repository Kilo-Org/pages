// Echo's durable room: what was asked for, what work exists for it, and the
// per-target bookkeeping the executor needs. Pure data plus pure transitions.
//
// Execution still uses the same ctx.state storage. PR 4 keeps one `room` value;
// old `nodes/*` keys are migrated once and left in place for rollback.
import type { CommentChange, SelectionChange } from '@pages-programs/sdk'

export type IntentKind = 'action' | 'correction' | 'chat' | 'clarify'
export type IntentStatus = 'open' | 'active' | 'done' | 'abandoned'
export type OutputKind = 'edit' | 'comment' | 'progress' | 'question'

export type EvidenceRef = {
  eventId: string
  at: string
  messageId?: string
}

export type TargetScope = {
  pageId: string
  blockId?: string
  nodeKey?: string
  threadId?: string
}

export type Intent = {
  id: string
  kind: IntentKind
  status: IntentStatus
  version: number
  targetScope: TargetScope
  outputKind: OutputKind
  confidence: number
  evidence: EvidenceRef[]
  createdAt: string
  updatedAt: string
}

export type StepStatus = 'pending' | 'active' | 'done' | 'stale' | 'cancelled'

export type PlanStep = {
  id: string
  intentId: string
  intentVersion: number
  status: StepStatus
  description: string
  owner: string | null
  dependsOn: string[]
  assumedRevision: string | null
}

/** What the executor needs for one node. The intent is the request; this is
 * the output bookkeeping (reply identity, dedupe text, backoff). */
export type TargetState = {
  key: string
  pageId: string
  blockId: string
  text: string
  changedAt: number
  evaluatedText: string | null
  failures: number
  lastAttemptAt: number
  threadId: string | null
  messageId: string | null
  lastReply: string | null
  /** Bumped by any new user change; stale drafts fail the commit fence. */
  generation: number
  /** Intent version the current draft/reply serves. */
  assumedIntentVersion: number | null
}

export type SelectionEvidence = {
  peerId: string
  principal: string
  blockId: string
  kind: 'caret' | 'selection' | null
  startUtf16: number | null
  endUtf16: number | null
  quote: string | null
  observedAt: string
}

export type RoomState = {
  schemaVersion: 1
  pageId: string
  intents: Record<string, Intent>
  steps: Record<string, PlanStep>
  targets: Record<string, TargetState>
  selections: Record<string, SelectionEvidence>
  /** threadId -> last message echo handled, so a redelivered event cannot double-reply. */
  handledComments: Record<string, string>
}

export const emptyRoom = (pageId = ''): RoomState => ({
  schemaVersion: 1,
  pageId,
  intents: {},
  steps: {},
  targets: {},
  selections: {},
  handledComments: {},
})

const scopeKey = (scope: TargetScope) =>
  scope.threadId ?? scope.nodeKey ?? scope.blockId ?? 'page'

const copyTargets = (room: RoomState, targets: Record<string, TargetState>): RoomState => ({
  ...room,
  targets,
})

const copyIntents = (room: RoomState, intents: Record<string, Intent>): RoomState => ({
  ...room,
  intents,
})

export function findActiveIntentForTarget(room: RoomState, targetKey: string): Intent | undefined {
  return Object.values(room.intents).find(
    (intent) =>
      intent.status === 'active' && intent.targetScope.nodeKey === targetKey,
  )
}

export function findIntentForThread(room: RoomState, threadId: string): Intent | undefined {
  return Object.values(room.intents).find(
    (intent) => intent.status === 'active' && intent.targetScope.threadId === threadId,
  )
}

export function findIntentForBlock(room: RoomState, blockId: string): Intent | undefined {
  return Object.values(room.intents).find(
    (intent) => intent.status === 'active' && intent.targetScope.blockId === blockId,
  )
}

export function attachThreadToIntent(
  room: RoomState,
  intentId: string,
  threadId: string,
): RoomState {
  const intent = room.intents[intentId]
  if (!intent) return room
  return copyIntents(room, {
    ...room.intents,
    [intentId]: { ...intent, targetScope: { ...intent.targetScope, threadId } },
  })
}

export function closeIntentForThread(room: RoomState, threadId: string): RoomState {
  const intent = findIntentForThread(room, threadId)
  if (!intent) return room
  return copyIntents(room, {
    ...room.intents,
    [intent.id]: { ...intent, status: 'abandoned' },
  })
}

export function commentHandled(room: RoomState, threadId: string, messageId: string): boolean {
  return room.handledComments[threadId] === messageId
}

export function markCommentHandled(
  room: RoomState,
  threadId: string,
  messageId: string,
): RoomState {
  return {
    ...room,
    handledComments: { ...room.handledComments, [threadId]: messageId },
  }
}

/**
 * Applies a triage decision to the room. Body changes already bumped their
 * intent in recordBodyChange; comment changes pass `bump: true`.
 */
export function applyTriage(
  room: RoomState,
  input: {
    intentId: string | null
    kind: IntentKind | null
    targetScope: TargetScope
    confidence: number
    evidence: EvidenceRef
  },
  now: string,
  bump: boolean,
): RoomState {
  if (input.kind === null) return room
  const intent =
    (input.intentId && room.intents[input.intentId]) ||
    (input.targetScope.threadId && findIntentForThread(room, input.targetScope.threadId)) ||
    (input.targetScope.nodeKey && findActiveIntentForTarget(room, input.targetScope.nodeKey)) ||
    (input.targetScope.blockId && findIntentForBlock(room, input.targetScope.blockId)) ||
    undefined
  if (!intent) {
    const admitted = admitIntent(
      room,
      {
        kind: input.kind,
        targetScope: input.targetScope,
        outputKind: 'comment',
        confidence: input.confidence,
        evidence: [input.evidence],
      },
      now,
    )
    return admitted.room
  }
  const based = bump ? bumpIntentVersion(room, intent.id, input.evidence, now) : room
  const current = based.intents[intent.id] ?? intent
  const evidence = bump
    ? current.evidence
    : current.evidence.some((ref) => ref.eventId === input.evidence.eventId)
      ? current.evidence
      : [...current.evidence, input.evidence]
  return copyIntents(based, {
    ...based.intents,
    [intent.id]: {
      ...current,
      kind: input.kind,
      confidence: input.confidence,
      evidence,
      updatedAt: now,
    },
  })
}

export function admitIntent(
  room: RoomState,
  input: {
    id?: string
    kind: IntentKind
    targetScope: TargetScope
    outputKind: OutputKind
    confidence: number
    evidence: EvidenceRef[]
  },
  now: string,
): { room: RoomState; intent: Intent } {
  const id = input.id ?? `${scopeKey(input.targetScope)}:${input.kind}`
  const intent: Intent = {
    id,
    kind: input.kind,
    status: 'active',
    version: 1,
    targetScope: input.targetScope,
    outputKind: input.outputKind,
    confidence: input.confidence,
    evidence: [...input.evidence],
    createdAt: now,
    updatedAt: now,
  }
  return {
    room: copyIntents(room, { ...room.intents, [id]: intent }),
    intent,
  }
}

export function bumpIntentVersion(
  room: RoomState,
  intentId: string,
  evidence: EvidenceRef,
  now: string,
): RoomState {
  const intent = room.intents[intentId]
  if (!intent) return room
  const version = intent.version + 1
  const intents = {
    ...room.intents,
    [intentId]: {
      ...intent,
      version,
      evidence: [...intent.evidence, evidence],
      updatedAt: now,
    },
  }
  const steps = Object.fromEntries(
    Object.entries(room.steps).map(([id, step]) => [
      id,
      step.intentId === intentId && step.intentVersion < version
        ? { ...step, status: 'stale' as const }
        : step,
    ]),
  )
  return { ...room, intents, steps }
}

export function cancelStaleSteps(room: RoomState, intentId: string): RoomState {
  let changed = false
  const steps = Object.fromEntries(
    Object.entries(room.steps).map(([id, step]) => {
      if (
        step.intentId === intentId &&
        step.status === 'stale' &&
        (step.owner === null || step.owner === undefined)
      ) {
        changed = true
        return [id, { ...step, status: 'cancelled' as const }]
      }
      return [id, step]
    }),
  )
  return changed ? { ...room, steps } : room
}

export function noteUserChange(
  room: RoomState,
  targetKey: string,
  intentId: string | null,
  now: string,
): RoomState {
  const target = room.targets[targetKey]
  const intent = intentId ? room.intents[intentId] : undefined
  if (!target) return room
  return copyTargets(room, {
    ...room.targets,
    [targetKey]: {
      ...target,
      generation: target.generation + 1,
      assumedIntentVersion: intent?.version ?? target.assumedIntentVersion,
    },
  })
}

export function commitIsCurrent(
  room: RoomState,
  targetKey: string,
  expected: {
    text: string
    intentVersion: number | null
    generation: number
  },
): boolean {
  const target = room.targets[targetKey]
  if (!target) return false
  return (
    target.text === expected.text &&
    target.generation === expected.generation &&
    (expected.intentVersion === null ||
      target.assumedIntentVersion === expected.intentVersion)
  )
}

export function recordTarget(room: RoomState, target: TargetState): RoomState {
  return copyTargets(room, { ...room.targets, [target.key]: target })
}

export function removeTarget(room: RoomState, targetKey: string): RoomState {
  if (!room.targets[targetKey]) return room
  const targets = { ...room.targets }
  delete targets[targetKey]
  return copyTargets(closeIntentForTarget(room, targetKey), targets)
}

export function closeIntentForTarget(room: RoomState, targetKey: string): RoomState {
  const intent = findActiveIntentForTarget(room, targetKey)
  if (!intent) return room
  return copyIntents(room, {
    ...room.intents,
    [intent.id]: { ...intent, status: 'abandoned' },
  })
}

/**
 * A body change bumps the target generation and either creates the target's
 * intent or bumps its version, marking older plan steps stale. PR 5 replaces
 * the always-correction decision with triage; the storage shape does not change.
 */
export function recordBodyChange(
  room: RoomState,
  target: TargetState,
  evidence: EvidenceRef,
  now: string,
): RoomState {
  const prior = room.targets[target.key]
  const generation = (prior?.generation ?? 0) + 1
  const existing = findActiveIntentForTarget(room, target.key)
  // Triage decides whether this change is an action, correction, chat or
  // ignore, and creates the intent. Here we only carry the fence forward.
  if (!existing) {
    return recordTarget(room, {
      ...target,
      generation,
      assumedIntentVersion: null,
    })
  }
  const bumped = bumpIntentVersion(room, existing.id, evidence, now)
  const cancelled = cancelStaleSteps(bumped, existing.id)
  return recordTarget(cancelled, {
    ...target,
    generation,
    assumedIntentVersion: cancelled.intents[existing.id]?.version ?? existing.version + 1,
  })
}

/** Comment changes are evidence for an intent, not new intent creation. */
export function recordCommentEvidence(
  room: RoomState,
  change: CommentChange,
  eventId: string,
  now: string,
): RoomState {
  if (!change.threadId && !change.blockId) return room
  const intent =
    (change.threadId && findIntentForThread(room, change.threadId)) ||
    (change.blockId && findIntentForBlock(room, change.blockId)) ||
    undefined
  if (!intent) return room
  const evidence: EvidenceRef = {
    eventId,
    at: now,
    ...(change.messageId ? { messageId: change.messageId } : {}),
  }
  if (intent.evidence.some((ref) => ref.eventId === eventId && ref.messageId === evidence.messageId))
    return room
  return copyIntents(room, {
    ...room.intents,
    [intent.id]: {
      ...intent,
      evidence: [...intent.evidence, evidence],
      updatedAt: now,
    },
  })
}

export function noteSelection(room: RoomState, change: SelectionChange): RoomState {
  const evidence: SelectionEvidence = {
    peerId: change.peerId,
    principal: change.principal,
    blockId: change.blockId,
    kind: change.kind,
    startUtf16: change.startUtf16,
    endUtf16: change.endUtf16,
    quote: change.quote,
    observedAt: change.observedAt,
  }
  const intent = findIntentForBlock(room, change.blockId)
  const intents = intent
    ? {
        ...room.intents,
        [intent.id]: {
          ...intent,
          evidence: [
            ...intent.evidence,
            { eventId: `selection:${change.peerId}:${change.observedAt}`, at: change.observedAt },
          ],
          updatedAt: change.observedAt,
        },
      }
    : room.intents
  return {
    ...room,
    intents,
    selections: { ...room.selections, [change.peerId]: evidence },
  }
}

export function clearSelection(room: RoomState, peerId: string): RoomState {
  if (!room.selections[peerId]) return room
  const selections = { ...room.selections }
  delete selections[peerId]
  return { ...room, selections }
}

/** One-time upgrade from PR 3's flat per-target records. Leaves `nodes/*` in
 * place so a rollback still has reply identity. */
export function migrateNodes(
  records: Record<string, unknown>,
  pageId: string,
): RoomState {
  const room = emptyRoom(pageId)
  const targets: Record<string, TargetState> = {}
  for (const [key, value] of Object.entries(records)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    if (typeof record.text !== 'string') continue
    const blockId =
      typeof record.blockId === 'string'
        ? record.blockId
        : key.startsWith('nodes/')
          ? key.slice('nodes/'.length).split(':')[0] ?? key
          : key
    targets[key] = {
      key,
      pageId,
      blockId,
      text: record.text,
      changedAt: typeof record.changedAt === 'number' ? record.changedAt : 0,
      evaluatedText:
        typeof record.evaluatedText === 'string' ? record.evaluatedText : null,
      failures: typeof record.failures === 'number' ? record.failures : 0,
      lastAttemptAt: typeof record.lastAttemptAt === 'number' ? record.lastAttemptAt : 0,
      threadId: typeof record.threadId === 'string' ? record.threadId : null,
      messageId: typeof record.messageId === 'string' ? record.messageId : null,
      lastReply: typeof record.lastReply === 'string' ? record.lastReply : null,
      generation: typeof record.generation === 'number' ? record.generation : 0,
      assumedIntentVersion:
        typeof record.assumedIntentVersion === 'number'
          ? record.assumedIntentVersion
          : null,
    }
  }
  return { ...room, targets }
}
