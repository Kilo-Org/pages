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
  /** Monotonic local id source; intent ids stay unique after an intent is abandoned. */
  intentSeq: number
  intents: Record<string, Intent>
  steps: Record<string, PlanStep>
  targets: Record<string, TargetState>
  selections: Record<string, SelectionEvidence>
}

export const emptyRoom = (pageId = ''): RoomState => ({
  schemaVersion: 1,
  pageId,
  intentSeq: 0,
  intents: {},
  steps: {},
  targets: {},
  selections: {},
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
  const intentSeq = room.intentSeq + 1
  const id = input.id ?? `${scopeKey(input.targetScope)}:${input.kind}:${intentSeq}`
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
    room: { ...copyIntents(room, { ...room.intents, [id]: intent }), intentSeq },
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

export function closeIntentForThread(room: RoomState, threadId: string): RoomState {
  const intent = findIntentForThread(room, threadId)
  if (!intent) return room
  return copyIntents(room, {
    ...room.intents,
    [intent.id]: { ...intent, status: 'abandoned' },
  })
}

/** Links a body intent to the thread its first reply created. */
export function attachThreadToIntent(
  room: RoomState,
  intentId: string,
  threadId: string,
): RoomState {
  const intent = room.intents[intentId]
  if (!intent || intent.targetScope.threadId === threadId) return room
  return copyIntents(room, {
    ...room.intents,
    [intentId]: {
      ...intent,
      targetScope: { ...intent.targetScope, threadId },
    },
  })
}

/**
 * A deleted thread must not leave a target pointing at it: the next attempt
 * would call edit_message forever. Keep the target's evaluated text so echo
 * does not immediately re-post; the next edit will create a new thread.
 */
export function forgetThread(room: RoomState, threadId: string): RoomState {
  let next = room
  let changed = false
  const targets = Object.fromEntries(
    Object.entries(room.targets).map(([key, target]) => {
      if (target.threadId !== threadId) return [key, target]
      changed = true
      const intent = findActiveIntentForTarget(room, key)
      if (intent) {
        next = copyIntents(next, {
          ...next.intents,
          [intent.id]: { ...intent, status: 'abandoned' },
        })
      }
      return [key, { ...target, threadId: null, messageId: null, lastReply: null }]
    }),
  )
  if (changed) next = copyTargets(next, targets)
  return closeIntentForThread(next, threadId)
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
  // noteUserChange increments the room's generation; make the incoming target
  // carry that baseline even when a caller built it without the prior value.
  const nextTarget = prior ? { ...target, generation: prior.generation } : target
  const existing = findActiveIntentForTarget(room, target.key)
  if (!existing) {
    const admitted = admitIntent(
      room,
      {
        kind: 'action',
        targetScope: { pageId: target.pageId, blockId: target.blockId, nodeKey: target.key },
        outputKind: 'comment',
        confidence: 1,
        evidence: [evidence],
      },
      now,
    )
    return noteUserChange(recordTarget(admitted.room, nextTarget), target.key, admitted.intent.id)
  }
  const bumped = bumpIntentVersion(room, existing.id, evidence, now)
  return noteUserChange(recordTarget(bumped, nextTarget), target.key, existing.id)
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

const selectionEvidenceId = (peerId: string) => `selection:${peerId}`

/** Removes a peer's selection evidence from every intent. */
function withoutSelectionEvidence(room: RoomState, peerId: string): Record<string, Intent> {
  const evidenceId = selectionEvidenceId(peerId)
  return Object.fromEntries(
    Object.entries(room.intents).map(([id, intent]) => [
      id,
      intent.evidence.some((ref) => ref.eventId === evidenceId)
        ? { ...intent, evidence: intent.evidence.filter((ref) => ref.eventId !== evidenceId) }
        : intent,
    ]),
  )
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
  // Keep at most one selection evidence ref per peer, even as it moves across
  // blocks or is reported many times.
  const intents = withoutSelectionEvidence(room, change.peerId)
  const intent = findIntentForBlock({ ...room, intents }, change.blockId)
  if (intent) {
    intents[intent.id] = {
      ...intent,
      evidence: [
        ...intent.evidence,
        { eventId: selectionEvidenceId(change.peerId), at: change.observedAt },
      ],
      updatedAt: change.observedAt,
    }
  }
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
  return {
    ...room,
    intents: withoutSelectionEvidence(room, peerId),
    selections,
  }
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
