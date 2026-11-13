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

/** Steps the executor can actually perform. A free-text plan is not executable. */
export type StepKind = 'task' | 'draft_reply' | 'post_reply' | 'edit_reply'

export const STEP_KINDS: readonly StepKind[] = [
  'task',
  'draft_reply',
  'post_reply',
  'edit_reply',
]

export type PlanStepInput = {
  key: string
  kind: StepKind
  description: string
  dependsOn?: string[]
}

export type PlanStep = {
  id: string
  /** Plan-local key from the proposal, stable across versions. */
  key: string
  intentId: string
  intentVersion: number
  status: StepStatus
  kind: StepKind | null
  description: string
  /** Ordering within a version; lower runs first. */
  position: number
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
  /** The node text this change replaced, for correction prompts. */
  previousText: string | null
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

/** Compact, append-only activity. This is the archivist's warm tier: what
 * happened, not a second copy of the page and not a transcript. */
export type TimelineEntryKind =
  | 'user_edit'
  | 'user_comment'
  | 'triage'
  | 'intent_version'
  | 'attempt_started'
  | 'attempt_discarded'
  | 'reply_written'
  | 'reply_updated'
  | 'failure'

export type TimelineScope = {
  blockId?: string
  nodeKey?: string
  threadId?: string
}

export type TimelineEntry = {
  /** Stable across redeliveries: a repeated event cannot append a second row. */
  id: string
  at: string
  kind: TimelineEntryKind
  surface: 'body' | 'comment' | 'room'
  scope: TimelineScope
  intentId?: string
  messageId?: string
  /** Deterministic, compact, at most TIMELINE_SUMMARY_MAX characters. */
  summary: string
  data?: {
    added?: string
    removed?: string
    outcome?: string
    reason?: string
    intentVersion?: number
    source?: 'rules' | 'model'
  }
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
  /** threadId -> last message echo handled, so a redelivered event cannot double-reply. */
  handledComments: Record<string, string>
  /** Optional so a saved room written before the archivist remains readable. */
  timeline?: TimelineEntry[]
}

export const emptyRoom = (pageId = ''): RoomState => ({
  schemaVersion: 1,
  pageId,
  intentSeq: 0,
  intents: {},
  steps: {},
  targets: {},
  selections: {},
  handledComments: {},
  timeline: [],
})

const scopeKey = (scope: TargetScope) =>
  scope.threadId ?? scope.nodeKey ?? scope.blockId ?? 'page'

const stepId = (intentId: string, version: number, key: string) =>
  `${intentId}:${version}:${key}`

const PLAN_KEY = /^[A-Za-z0-9_-]{1,40}$/

/** Returns a human-readable problem, or null when the proposed plan is usable. */
export function validatePlanSteps(steps: PlanStepInput[]): string | null {
  if (steps.length < 1) return 'plan needs at least one step'
  if (steps.length > 30) return 'plan supports at most thirty steps'
  const keys = new Set<string>()
  for (const step of steps) {
    if (!PLAN_KEY.test(step.key)) return `invalid step key ${JSON.stringify(step.key)}`
    if (keys.has(step.key)) return `duplicate step key ${step.key}`
    keys.add(step.key)
    if (!STEP_KINDS.includes(step.kind)) return `invalid step kind ${String(step.kind)}`
    if (!step.description.trim()) return `step ${step.key} needs a description`
    if (step.description.length > 200) return `step ${step.key} description is too long`
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.key) return `step ${step.key} cannot depend on itself`
      if (!keys.has(dependency)) return `step ${step.key} depends on missing ${dependency}`
    }
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (key: string, path: string[]): string | null => {
    const current = state.get(key)
    if (current === 'done') return null
    if (current === 'visiting') return `plan has a cycle: ${[...path, key].join(' -> ')}`
    state.set(key, 'visiting')
    const step = steps.find((candidate) => candidate.key === key)!
    for (const dependency of step.dependsOn ?? []) {
      const problem = visit(dependency, [...path, key])
      if (problem) return problem
    }
    state.set(key, 'done')
    return null
  }
  for (const step of steps) {
    const problem = visit(step.key, [])
    if (problem) return problem
  }
  return null
}

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

export type TriageApplication = { room: RoomState; intent: Intent }

/**
 * Applies a triage decision to the room. Body changes already bumped their
 * intent in recordBodyChange; comment changes pass `bump: true`.
 * Planning is a separate transition: chat and clarify deliberately get no steps.
 */
export function applyTriage(
  room: RoomState,
  input: {
    intentId: string | null
    kind: IntentKind
    targetScope: TargetScope
    confidence: number
    evidence: EvidenceRef
  },
  now: string,
  bump: boolean,
): TriageApplication {
  const intent =
    (input.intentId && room.intents[input.intentId]) ||
    (input.targetScope.threadId && findIntentForThread(room, input.targetScope.threadId)) ||
    (input.targetScope.nodeKey && findActiveIntentForTarget(room, input.targetScope.nodeKey)) ||
    (input.targetScope.threadId &&
      input.targetScope.blockId &&
      findIntentForBlock(room, input.targetScope.blockId)) ||
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
    return { room: admitted.room, intent: admitted.intent }
  }
  const based = bump
    ? cancelStaleSteps(bumpIntentVersion(room, intent.id, input.evidence, now), intent.id)
    : room
  const current = based.intents[intent.id] ?? intent
  const evidence = bump
    ? current.evidence
    : current.evidence.some((ref) => ref.eventId === input.evidence.eventId)
      ? current.evidence
      : [...current.evidence, input.evidence]
  const updated = copyIntents(based, {
    ...based.intents,
    [intent.id]: {
      ...current,
      kind: input.kind,
      confidence: input.confidence,
      evidence,
      updatedAt: now,
    },
  })
  return { room: updated, intent: updated.intents[intent.id]! }
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

/** Steps for one intent version, in execution order. */
export function stepsForVersion(
  room: RoomState,
  intentId: string,
  version: number,
): PlanStep[] {
  return Object.values(room.steps)
    .filter((step) => step.intentId === intentId && step.intentVersion === version)
    .sort((a, b) => a.position - b.position)
}

/** The executor's next unit of work: an active step, or the first pending step whose dependencies are done. */
export function nextStep(room: RoomState, intentId: string): PlanStep | undefined {
  const intent = room.intents[intentId]
  if (!intent) return undefined
  const steps = stepsForVersion(room, intentId, intent.version)
  const active = steps.find((step) => step.status === 'active')
  if (active) return active
  return steps.find(
    (step) =>
      step.status === 'pending' &&
      step.dependsOn.every((dependency) => room.steps[dependency]?.status === 'done'),
  )
}

/**
 * Creates the ordered plan for one intent version. A version that already has
 * executed work is left alone, so a retry cannot overwrite progress.
 */
export function planIntent(
  room: RoomState,
  intentId: string,
  version: number,
  steps: PlanStepInput[],
): RoomState {
  const intent = room.intents[intentId]
  if (!intent || intent.version !== version) return room
  if (validatePlanSteps(steps)) return room
  const existing = stepsForVersion(room, intentId, version)
  if (existing.some((step) => step.status === 'active' || step.status === 'done')) return room
  const ids = new Map(steps.map((step) => [step.key, stepId(intentId, version, step.key)]))
  const planned: PlanStep[] = steps.map((step, position) => ({
    id: ids.get(step.key)!,
    key: step.key,
    intentId,
    intentVersion: version,
    status: 'pending',
    kind: step.kind,
    description: step.description,
    position,
    owner: null,
    dependsOn: (step.dependsOn ?? []).map((key) => ids.get(key)!),
    assumedRevision: null,
  }))
  const kept = Object.fromEntries(
    Object.entries(room.steps).filter(
      ([, step]) => !(step.intentId === intentId && step.intentVersion === version),
    ),
  )
  const created = Object.fromEntries(planned.map((step) => [step.id, step]))
  return { ...room, steps: { ...kept, ...created } }
}

export function activateStep(room: RoomState, id: string): RoomState {
  const step = room.steps[id]
  if (!step || step.status !== 'pending') return room
  const intent = room.intents[step.intentId]
  if (!intent || intent.version !== step.intentVersion) return room
  return { ...room, steps: { ...room.steps, [id]: { ...step, status: 'active' } } }
}

export function completeStep(room: RoomState, id: string): RoomState {
  const step = room.steps[id]
  if (!step || (step.status !== 'pending' && step.status !== 'active')) return room
  const intent = room.intents[step.intentId]
  if (!intent || intent.version !== step.intentVersion) return room
  return { ...room, steps: { ...room.steps, [id]: { ...step, status: 'done' } } }
}

/** A failed step becomes pending again so the next attempt can retry it. */
export function failStep(room: RoomState, id: string): RoomState {
  const step = room.steps[id]
  if (!step || (step.status !== 'pending' && step.status !== 'active')) return room
  return { ...room, steps: { ...room.steps, [id]: { ...step, status: 'pending' } } }
}

/**
 * Completes the current plan after one executor pass. When `doneTaskKeys` is
 * given, task steps outside that set stay pending; execution steps always finish.
 */
export function completePlan(
  room: RoomState,
  intentId: string,
  doneTaskKeys?: ReadonlySet<string>,
): RoomState {
  const intent = room.intents[intentId]
  if (!intent) return room
  let next = room
  for (const step of stepsForVersion(room, intentId, intent.version)) {
    if (step.status !== 'pending' && step.status !== 'active') continue
    if (step.kind === 'task' && doneTaskKeys && !doneTaskKeys.has(step.key)) continue
    next = completeStep(next, step.id)
  }
  return next
}

export function cancelPlan(room: RoomState, intentId: string): RoomState {
  const intent = room.intents[intentId]
  if (!intent) return room
  let next = room
  for (const step of stepsForVersion(room, intentId, intent.version)) {
    if (step.status === 'pending' || step.status === 'active') {
      next = { ...next, steps: { ...next.steps, [step.id]: { ...step, status: 'cancelled' } } }
    }
  }
  return next
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
  // Triage decides whether this change is an action, correction, chat or
  // clarification, and creates the intent. Here we only carry the fence forward.
  if (!existing) {
    return noteUserChange(
      recordTarget(room, { ...nextTarget, assumedIntentVersion: null }),
      target.key,
      null,
    )
  }
  const bumped = cancelStaleSteps(bumpIntentVersion(room, existing.id, evidence, now), existing.id)
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
      previousText:
        typeof record.previousText === 'string' ? record.previousText : null,
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
