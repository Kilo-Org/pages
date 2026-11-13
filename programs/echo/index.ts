import {
  defineProgram,
  type BodyChange,
  type CommentChange,
  type ProgramContext,
  type SelectionChange,
} from '@pages-programs/sdk'
import {
  activateStep,
  applyTriage,
  attachThreadToIntent,
  clearSelection,
  closeIntentForThread,
  commentHandled,
  commitIsCurrent,
  completePlan,
  emptyRoom,
  findActiveIntentForTarget,
  forgetThread,
  markCommentHandled,
  migrateNodes,
  nextStep,
  noteSelection,
  planIntent,
  recordBodyChange,
  recordCommentEvidence,
  recordTarget,
  removeTarget,
  stepsForVersion,
  type Intent,
  type PlanStep,
  type PlanStepInput,
  type RoomState,
  type TargetState,
} from './room.ts'
import {
  appendTimeline,
  attemptEntry,
  failureEntry,
  intentVersionEntry,
  replyEntry,
  triageEntry,
  userCommentEntry,
  userEditEntry,
} from './archivist.ts'
import {
  assembleContext,
  describeContext,
  renderPrompt,
  type AssembledContext,
  type TriggerContext,
} from './context.ts'
import { gatherContext } from './gather.ts'
import {
  kindFor,
  parseTodoWriteCall,
  parseTriage,
  PLAN_SYSTEM_PROMPT,
  TODO_WRITE_TOOL,
  triageBody,
  triageComment,
  TRIAGE_SYSTEM_PROMPT,
  CONTEXT_TRUST_RULE,
  type Ambiguous,
  type Triage,
} from './triage.ts'

export type TextDelta = { removed: string; added: string }

/** Smallest single replacement that turns `before` into `after`. */
export function textDelta(before: string, after: string): TextDelta {
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  return { removed: before.slice(start, endBefore), added: after.slice(start, endAfter) }
}

const nodeKey = (change: BodyChange) => `nodes/${change.blockId}:${change.nodeId ?? change.nodeIndex ?? 0}`

/**
 * How long text must sit unchanged before we're willing to START a speculative draft.
 * Not "the user is done" — just "worth a guess now." There is no separate commit delay:
 * a draft commits as soon as it resolves and the text it was based on still matches.
 */
const SPECULATIVE_PAUSE_MS = 1_000
/** Backoff after a failed attempt starts at SPECULATIVE_PAUSE_MS and doubles, capped here. */
const MAX_BACKOFF_MS = 5 * 60_000

const ROOM_KEY = 'room'
const ROOM_LOCK = 'room-lock'

function normalizeRoom(room: RoomState, pageId = ''): RoomState {
  const steps = Object.fromEntries(
    Object.entries(room.steps ?? {}).map(([id, step], index) => [
      id,
      {
        ...step,
        key: step.key ?? id.split(':').pop() ?? id,
        kind: step.kind ?? null,
        position: typeof step.position === 'number' ? step.position : index,
      },
    ]),
  )
  return {
    ...room,
    pageId: room.pageId || pageId,
    intentSeq: room.intentSeq ?? 0,
    intents: room.intents ?? {},
    steps,
    targets: room.targets ?? {},
    selections: room.selections ?? {},
    handledComments: room.handledComments ?? {},
    timeline: room.timeline ?? [],
  }
}

/** Reads the room, upgrading PR 3's flat `nodes/*` records once. */
async function loadRoom(ctx: ProgramContext, pageId = ''): Promise<RoomState> {
  const stored = await ctx.state.get<RoomState>(ROOM_KEY)
  if (stored && stored.schemaVersion === 1) return normalizeRoom(stored, pageId)
  const records: Record<string, unknown> = {}
  for (const key of await ctx.state.list('nodes/')) records[key] = await ctx.state.get(key)
  if (Object.keys(records).length === 0) return emptyRoom(pageId || stored?.pageId || '')
  return migrateNodes(records, pageId || stored?.pageId || '')
}

/** Persists a one-time migration so tick does not re-read every legacy key. */
async function ensureRoom(ctx: ProgramContext, pageId = ''): Promise<RoomState> {
  const stored = await ctx.state.get<RoomState>(ROOM_KEY)
  if (stored && stored.schemaVersion === 1) return normalizeRoom(stored, pageId)
  const room = await loadRoom(ctx, pageId)
  await ctx.state.set(ROOM_KEY, room)
  return room
}

/**
 * Serializes room load/mutate/save inside one instance. The lock covers the
 * commit check + write, not the model call, so one slow draft does not block
 * other targets.
 */
async function updateRoom<T>(
  ctx: ProgramContext,
  pageId: string | undefined,
  fn: (room: RoomState) => Promise<{ room: RoomState; value: T }> | { room: RoomState; value: T },
): Promise<T> {
  const previous = ctx.scratch.get<Promise<unknown>>(ROOM_LOCK) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const tail = previous.then(() => gate, () => gate)
  ctx.scratch.set(ROOM_LOCK, tail)
  await previous.catch(() => {})
  try {
    const room = await loadRoom(ctx, pageId)
    const next = await fn(room)
    // Keep the legacy per-node records current while the room is introduced;
    // a rollback to PR 3 then still has reply identity for new writes.
    for (const [key, target] of Object.entries(next.room.targets)) {
      if (room.targets[key] !== target) await ctx.state.set(key, target)
    }
    for (const key of Object.keys(room.targets)) {
      if (!(key in next.room.targets)) await ctx.state.delete(key)
    }
    await ctx.state.set(ROOM_KEY, next.room)
    return next.value
  } finally {
    release()
  }
}

/** Builds the target for `text`, preserving reply identity across edits. */
function withText(
  prior: TargetState | undefined,
  pageId: string,
  change: BodyChange,
  text: string,
): TargetState {
  return {
    key: nodeKey(change),
    pageId,
    blockId: change.blockId,
    text,
    previousText: prior?.text ?? null,
    changedAt: Date.now(),
    evaluatedText: null,
    failures: 0,
    lastAttemptAt: 0,
    threadId: prior?.threadId ?? null,
    messageId: prior?.messageId ?? null,
    lastReply: prior?.lastReply ?? null,
    generation: prior?.generation ?? 0,
    assumedIntentVersion: prior?.assumedIntentVersion ?? null,
  }
}

const systemPrompt = (lines: string[]) => [...lines, CONTEXT_TRUST_RULE].join(' ')

const ANSWER_SYSTEM_PROMPT = systemPrompt([
  'You are answering a question or request on a collaborative page.',
  'The assistant is always watching; infer the need or plan and always respond.',
  'Answer directly in 1-3 sentences, or make a short suggestion. If it is too vague, ask one short clarifying question.',
  'Set "completed" false when you are asking for missing context or could not finish the request; otherwise true.',
  'When Plan tasks are provided, "completedTasks" lists the keys you finished; use [] for none.',
  'Respond with strict JSON only, no prose, no code fences: {"reply": string, "completed": boolean, "completedTasks": string[]}.',
])

const COMMENT_SYSTEM_PROMPT = systemPrompt([
  'You are answering a message in one comment thread on a collaborative page.',
  'The assistant is always watching; infer the need or plan and always respond.',
  'Answer it, make a short suggestion, or ask one short clarifying question if it is too vague.',
  'Set "completed" false when you are asking for missing context or could not finish the request; otherwise true.',
  'When Plan tasks are provided, "completedTasks" lists the keys you finished; use [] for none.',
  'Respond with strict JSON only, no prose, no code fences: {"reply": string, "completed": boolean, "completedTasks": string[]}.',
])

const CORRECTION_SYSTEM_PROMPT = systemPrompt([
  'You are handling a correction to text on a collaborative page.',
  'Use the previous text and the correction to work out what should change.',
  'Always respond: update the reply, acknowledge what still stands, or ask one short specific question.',
  'Set "completed" false when you are asking for missing context or could not finish the change; otherwise true.',
  'When Plan tasks are provided, "completedTasks" lists the keys you finished; use [] for none.',
  'Respond with strict JSON only, no prose, no code fences: {"reply": string, "completed": boolean, "completedTasks": string[]}.',
])

const CLARIFY_SYSTEM_PROMPT = systemPrompt([
  'The request on this page is ambiguous. Ask one short, specific clarifying question.',
  'Respond with strict JSON only, no prose, no code fences: {"reply": string}.',
])

const FOLLOWUP_SYSTEM_PROMPT = systemPrompt([
  'You watch one block of text on a collaborative page. You already replied to it once; the text has changed since.',
  'The change may be a correction, a refinement, unrelated new content, or a new thought to build on.',
  'Always respond. If you update it, write the FULL replacement reply text: it wholly replaces your previous reply, it does not append to it.',
  'If your existing reply still stands, say so briefly or make the smallest useful suggestion.',
  'Set "completed" false when you are asking for missing context or could not finish the change; otherwise true.',
  'When Plan tasks are provided, "completedTasks" lists the keys you finished; use [] for none.',
  'Respond with strict JSON only, no prose, no code fences: {"reply": string, "completed": boolean, "completedTasks": string[]}.',
])

type Decision = { reply: string; completed?: boolean; completedTasks?: string[] }

function parseDecision(raw: string): Decision {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/```$/, '')
    .trim()
  const parsed: unknown = JSON.parse(cleaned)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`malformed decision: ${cleaned.slice(0, 200)}`)
  }
  const { reply, completed, completedTasks } = parsed as {
    reply?: unknown
    completed?: unknown
    completedTasks?: unknown
  }
  if (typeof reply !== 'string' || !reply.trim())
    throw new Error(`malformed decision: ${cleaned.slice(0, 200)}`)
  return {
    reply: reply.trim(),
    ...(typeof completed === 'boolean' ? { completed } : {}),
    ...(Array.isArray(completedTasks) && completedTasks.every((key) => typeof key === 'string')
      ? { completedTasks }
      : {}),
  }
}

type SpeculativeAttempt = { baseText: string; controller: AbortController }

/** Runs the model classifier only when the deterministic signals disagree. */
async function resolveTriage(
  ctx: ProgramContext,
  verdict: Triage | Ambiguous,
  surface: 'body' | 'comment',
  text: string,
  room: RoomState,
  targetKey: string | null,
  signal?: AbortSignal,
  previousText: string | null = null,
): Promise<Triage> {
  if (!('ambiguous' in verdict)) return verdict
  try {
    const assembled = assembleContext({
      purpose: 'triage',
      trigger: {
        surface,
        change: 'updated',
        text,
        previousText,
        threadId: null,
        blockId: null,
        messageId: null,
        author: null,
      },
      room,
      target: targetKey ? room.targets[targetKey] ?? null : null,
      intent: targetKey ? findActiveIntentForTarget(room, targetKey) ?? null : null,
      steps: [],
      page: null,
      threads: [],
      presence: [],
      now: new Date().toISOString(),
      budgetBytes: 8 * 1024,
    })
    ctx.log(`context triage ${surface} ${describeContext(assembled)}`)
    const raw = await ctx.llm!.complete({
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: renderPrompt(assembled),
      ...(signal ? { signal } : {}),
    })
    return parseTriage(raw)
  } catch (error) {
    if (isAbortError(error)) throw error
    return {
      outcome: 'clarify',
      intentId: null,
      confidence: 0,
      reason: 'classification failed',
      source: 'model',
    }
  }
}

/** Cancels and forgets any in-flight speculative work for `key` — a no-op if there is none. */
function abortSpeculative(ctx: ProgramContext, key: string): void {
  const attempt = ctx.scratch.get<SpeculativeAttempt>(key)
  if (attempt) {
    attempt.controller.abort()
    ctx.scratch.delete(key)
  }
}

/** A plan the executor can always run when the model cannot propose one. */
function fallbackPlan(surface: 'body' | 'comment', hasReply: boolean): PlanStepInput[] {
  if (surface === 'body' && hasReply) {
    return [
      { key: 'draft', kind: 'draft_reply', description: 'Draft the revised reply' },
      {
        key: 'edit',
        kind: 'edit_reply',
        description: 'Replace the previous reply',
        dependsOn: ['draft'],
      },
    ]
  }
  return [
    { key: 'draft', kind: 'draft_reply', description: 'Draft the reply' },
    { key: 'post', kind: 'post_reply', description: 'Post the reply', dependsOn: ['draft'] },
  ]
}

/**
 * Asks the model for a plan through the `todo_write` tool. Returns null when
 * the host has no tool support, the call fails, or the proposal is invalid;
 * the caller then uses `fallbackPlan`.
 */
async function proposePlan(
  ctx: ProgramContext,
  input: {
    surface: 'body' | 'comment'
    hasReply: boolean
    context: AssembledContext
  },
  signal?: AbortSignal,
): Promise<PlanStepInput[] | null> {
  if (!ctx.llm?.completeWithTools) return null
  try {
    ctx.log(`context plan ${input.surface} ${describeContext(input.context)}`)
    const result = await ctx.llm.completeWithTools({
      system: PLAN_SYSTEM_PROMPT,
      prompt: renderPrompt(input.context),
      tools: [TODO_WRITE_TOOL],
      toolChoice: 'required',
      ...(signal ? { signal } : {}),
    })
    const call = result.toolCalls.find((candidate) => candidate.name === 'todo_write')
    const parsed = call ? parseTodoWriteCall(call) : null
    if (!parsed) {
      ctx.log('todo_write returned no usable plan; using the fallback plan')
      return null
    }
    const canEdit = input.surface === 'body' && input.hasReply
    return parsed.map((step) => {
      if (step.kind === 'edit_reply' && !canEdit) return { ...step, kind: 'post_reply' as const }
      if (step.kind === 'post_reply' && canEdit) return { ...step, kind: 'edit_reply' as const }
      return step
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    ctx.log(`todo_write failed: ${message}; using the fallback plan`)
    return null
  }
}

/** Plans an action/correction and activates the first step. */
function installPlan(
  room: RoomState,
  intent: Intent,
  steps: PlanStepInput[],
): RoomState {
  const planned = planIntent(room, intent.id, intent.version, steps)
  const step = nextStep(planned, intent.id)
  return step ? activateStep(planned, step.id) : planned
}

const visibleTasks = (room: RoomState, intentId: string): PlanStep[] => {
  const intent = room.intents[intentId]
  return intent
    ? stepsForVersion(room, intentId, intent.version).filter((step) => step.kind === 'task')
    : []
}

/** The task keys the model says it finished, with a conservative fallback. */
function completedTaskKeys(
  tasks: { key: string }[],
  decision: Decision,
): Set<string> {
  const keys = new Set(tasks.map((task) => task.key))
  const explicit = decision.completedTasks?.filter((key) => keys.has(key))
  if (explicit) return new Set(explicit)
  if (decision.completed === false) return new Set()
  if (tasks.length > 0 && /\?\s*$/.test(decision.reply ?? '')) return new Set()
  return keys
}

/** Renders the user-facing checklist, checking only tasks the model finished. */
function checklist(
  tasks: { key: string; description: string }[],
  done: ReadonlySet<string>,
  reply?: string,
): string {
  const lines = tasks.map((task) => `- [${done.has(task.key) ? 'x' : ' '}] ${task.description.trim()}`)
  const plan = `**Plan**\n${lines.join('\n')}`
  return reply ? `${plan}\n\n${reply}` : `${plan}\n\nWorking on it…`
}

/**
 * Shows the unchecked plan while the model drafts. The final commit edits the
 * same message, so a multi-part request has one visible checklist that becomes
 * the checked list plus the answer.
 */
async function showDraft(
  ctx: ProgramContext,
  pageId: string,
  key: string,
  base: TargetState,
  tasks: PlanStep[],
): Promise<void> {
  if (tasks.length === 0) return
  await updateRoom(ctx, pageId, async (room) => {
    const target = room.targets[key]
    if (!target || target.text !== base.text || target.generation !== base.generation) {
      return { room, value: undefined }
    }
    const body = checklist(tasks, new Set())
    if (target.threadId && target.messageId) {
      await ctx.comments!.editMessage({
        threadId: target.threadId,
        messageId: target.messageId,
        body,
        dedupeOn: `plan:${body}`,
      })
      return { room, value: undefined }
    }
    const posted = await ctx.comments!.addBlock({
      blockId: target.blockId,
      body,
      dedupeOn: `plan:${body}`,
    })
    return {
      room: recordTarget(room, {
        ...target,
        threadId: posted.threadId,
        messageId: posted.messageId,
      }),
      value: undefined,
    }
  })
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

async function describe(
  change: BodyChange,
  ctx: ProgramContext,
  pageId: string,
  eventId: string,
  at: string,
): Promise<string | null> {
  if (change.scope === 'block') return `block ${change.blockId.slice(0, 8)} ${change.change}`
  const key = nodeKey(change)
  if (change.change === 'deleted') {
    abortSpeculative(ctx, key)
    await updateRoom(ctx, pageId, (room) => ({ room: removeTarget(room, key), value: undefined }))
    return `deleted ${change.type ?? 'node'}`
  }
  const after = change.markdown ?? ''
  const snapshot = await loadRoom(ctx, pageId)
  const before = snapshot.targets[key]
  if (after !== before?.text) {
    // New text invalidates any speculative draft that was based on the old text.
    abortSpeculative(ctx, key)
    await updateRoom(ctx, pageId, (room) => {
      const prior = room.targets[key]
      const priorIntent = findActiveIntentForTarget(room, key)
      const target = withText(prior, pageId, change, after)
      const delta = textDelta(prior?.text ?? '', after)
      let next = recordBodyChange(room, target, { eventId, at }, at)
      next = appendTimeline(
        next,
        userEditEntry({
          eventId,
          at,
          target,
          before: prior?.text ?? null,
          added: delta.added,
          removed: delta.removed,
        }),
      )
      const currentIntent = findActiveIntentForTarget(next, key)
      if (priorIntent && currentIntent && currentIntent.version > priorIntent.version) {
        next = appendTimeline(
          next,
          intentVersionEntry({
            at,
            intent: currentIntent,
            previousVersion: priorIntent.version,
          }),
        )
      }
      return { room: next, value: undefined }
    })
  }
  // Nothing to diff against until the program has seen this node once.
  if (before === undefined) return `first sight of ${change.type ?? 'node'}: ${JSON.stringify(after)}`
  const { removed, added } = textDelta(before.text, after)
  if (!removed && !added) return null
  const parts = [] as string[]
  if (added) parts.push(`+${JSON.stringify(added)}`)
  if (removed) parts.push(`-${JSON.stringify(removed)}`)
  return `${parts.join(' ')}  → ${JSON.stringify(after)}`
}

/**
 * A cheap "looks finished" signal: text ending in sentence-ending punctuation skips the
 * pause entirely and triggers immediately. This is the actual prediction — not a guess at
 * incomplete text, but recognizing when text already looks complete rather than waiting out
 * a timer regardless. Text without trailing punctuation still falls back to the pause.
 */
const looksComplete = (text: string) => /[?.!][\s*_~`)\]}"'”’]*$/.test(text.trim())

/** Exponential backoff after `failures` consecutive attempts, starting at SPECULATIVE_PAUSE_MS, capped at MAX_BACKOFF_MS. */
const backoffFor = (failures: number) =>
  failures === 0 ? 0 : Math.min(SPECULATIVE_PAUSE_MS * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS)

const workingMessage = (outcome: Triage['outcome']) =>
  outcome === 'correction'
    ? 'Updating my reply…'
    : outcome === 'new_action'
      ? 'Planning this request…'
      : outcome === 'clarify'
        ? 'Working out what you need…'
        : 'Answering this…'

/** How often a long generation renews its progress lease (the host TTL is 60s). */
const PROGRESS_RENEW_MS = 25_000
/** A UX hint must never hold up the model call for longer than this. */
const PROGRESS_START_TIMEOUT_MS = 750

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

type WorkingIndicator = {
  progressId: string
  leaseToken: string
  message: string
  timer: ReturnType<typeof setInterval> | null
}

/**
 * Publishes "this paragraph is being worked on" before the model call. This is
 * the only indicator that shows for a local browser-session login, where the
 * reading caret is suppressed. Never throws: it is a UX hint, not state.
 */
async function beginWorking(ctx: ProgramContext, base: TargetState): Promise<WorkingIndicator | null> {
  if (!ctx.progress) return null
  const message = 'Thinking about this paragraph…'
  try {
    const handle = await ctx.progress.report({
      message,
      blockId: base.blockId,
      matchText: base.text,
    })
    if (!handle.leaseToken) return null
    const working: WorkingIndicator = {
      progressId: handle.progressId,
      leaseToken: handle.leaseToken,
      message,
      timer: null,
    }
    // Keep the lease alive across a slow planner + answer without a second timer story.
    working.timer = setInterval(() => {
      void ctx.progress
        ?.report({
          message: working.message,
          progressId: working.progressId,
          leaseToken: working.leaseToken,
        })
        .catch(() => {})
    }, PROGRESS_RENEW_MS)
    ;(working.timer as unknown as { unref?: () => void }).unref?.()
    return working
  } catch {
    return null
  }
}

/** Updates the indicator text in place; a revision of the same lease, not a new one. */
async function updateWorking(
  ctx: ProgramContext,
  working: WorkingIndicator | null,
  message: string,
): Promise<void> {
  if (!working || working.message === message) return
  working.message = message
  // Fire-and-forget: a UX hint must never hold up the plan or the model call.
  void ctx.progress
    ?.report({
      message,
      progressId: working.progressId,
      leaseToken: working.leaseToken,
    })
    .catch(() => {})
}

async function endWorking(ctx: ProgramContext, working: WorkingIndicator | null): Promise<void> {
  if (!working) return
  if (working.timer) clearInterval(working.timer)
  // Fire-and-forget: the lease expires on its own if this never lands.
  void ctx.progress
    ?.clear({ progressId: working.progressId, leaseToken: working.leaseToken })
    .catch(() => {})
}

/**
 * The speculative attempt: decide, then commit only if the text, generation,
 * and intent version it was based on still match. The commit check runs inside
 * the room lock, immediately before the write.
 */
async function attempt(key: string, base: TargetState, ctx: ProgramContext, signal: AbortSignal): Promise<void> {
  if (!base.text.trim()) return
  // Best-effort UX hints: a reading caret and a "working" indicator can show up
  // well before the model call resolves. Neither may delay or fail the attempt.
  void ctx.presence?.showReading(base.blockId).catch(() => {})
  const pendingWorking = beginWorking(ctx, base)
  const working = await withTimeout(pendingWorking, PROGRESS_START_TIMEOUT_MS)
  if (!working) {
    // A late lease has nobody to clear it, so clear it as soon as it resolves.
    void pendingWorking.then((late) => (late ? endWorking(ctx, late) : undefined)).catch(() => {})
  }
  try {
    const snapshot = await loadRoom(ctx, base.pageId)
    const verdict = triageBody(base.text, snapshot, key)
    const triage = await resolveTriage(
      ctx,
      verdict,
      'body',
      base.text,
      snapshot,
      key,
      signal,
      base.previousText,
    )
    ctx.log(`triage ${base.blockId.slice(0, 8)}: ${triage.outcome} (${triage.source}) ${triage.reason}`)
    await updateWorking(ctx, working, workingMessage(triage.outcome))
    const now = new Date().toISOString()
    const applied = await updateRoom(ctx, base.pageId, (room) => {
      const result = applyTriage(
        room,
        {
          intentId: triage.intentId,
          kind: kindFor(triage.outcome),
          targetScope: { pageId: base.pageId, blockId: base.blockId, nodeKey: key },
          confidence: triage.confidence,
          evidence: { eventId: `${key}:${base.generation}`, at: now },
        },
        now,
        false,
      )
      const intent = result.intent
      const target = result.room.targets[key]
      const withFence =
        intent && target
          ? recordTarget(result.room, { ...target, assumedIntentVersion: intent.version })
          : result.room
      let nextRoom = appendTimeline(
        withFence,
        triageEntry({
          eventId: `${key}:${base.generation}:triage`,
          at: now,
          surface: 'body',
          scope: { blockId: base.blockId, nodeKey: key },
          triage,
        }),
      )
      nextRoom = appendTimeline(
        nextRoom,
        attemptEntry({
          at: now,
          key,
          blockId: base.blockId,
          generation: base.generation,
          intentId: intent?.id ?? null,
          intentVersion: intent?.version ?? null,
          kind: 'attempt_started',
        }),
      )
      return {
        room: nextRoom,
        value: {
          intent,
          steps: intent ? stepsForVersion(nextRoom, intent.id, intent.version) : [],
          priorSteps: intent
            ? stepsForVersion(nextRoom, intent.id, intent.version - 1)
            : [],
        },
      }
    })
    const hasReply = Boolean(base.threadId && base.lastReply)
    const plansIntent =
      applied.intent !== undefined &&
      (triage.outcome === 'new_action' || triage.outcome === 'correction')
    const contextNow = new Date().toISOString()
    const trigger: TriggerContext = {
      surface: 'body',
      change: 'updated',
      text: base.text,
      previousText: base.previousText,
      threadId: base.threadId,
      blockId: base.blockId,
      messageId: base.messageId,
      author: null,
    }
    const gathered = await gatherContext({
      ctx,
      pageId: base.pageId,
      surface: 'body',
      blockId: base.blockId,
      threadId: base.threadId,
      key: `${base.generation}:${base.text.length}:${base.text.slice(0, 80)}`,
      signal,
    })
    if (plansIntent) {
      const current = applied.intent!
      let planned = false
      if (applied.steps.length === 0) {
        const planRoom = await loadRoom(ctx, base.pageId)
        const planIntent = planRoom.intents[current.id] ?? current
        const planAssembled = assembleContext({
          purpose: 'plan',
          trigger,
          room: planRoom,
          target: planRoom.targets[key] ?? null,
          intent: planIntent,
          steps: stepsForVersion(planRoom, planIntent.id, planIntent.version),
          planTasks: applied.priorSteps.map((step) => ({
            key: step.key,
            description: step.description,
            status: step.status,
          })),
          page: gathered.page,
          threads: gathered.threads,
          presence: gathered.page?.presence ?? [],
          ownPrincipal: ctx.ownPrincipal,
          degraded: gathered.degraded,
          now: contextNow,
        })
        const proposal = await proposePlan(
          ctx,
          {
            surface: 'body',
            hasReply,
            context: planAssembled,
          },
          signal,
        )
        planned = await updateRoom(ctx, base.pageId, (room) => {
          const intent = room.intents[current.id]
          if (!intent || intent.version !== current.version) return { room, value: false }
          if (stepsForVersion(room, intent.id, intent.version).length > 0)
            return { room, value: false }
          return {
            room: installPlan(room, intent, proposal ?? fallbackPlan('body', hasReply)),
            value: true,
          }
        })
      }
      if (!planned) {
        await updateRoom(ctx, base.pageId, (room) => {
          const intent = room.intents[current.id]
          if (!intent || intent.version !== current.version) return { room, value: undefined }
          const step = nextStep(room, intent.id)
          return { room: step ? activateStep(room, step.id) : room, value: undefined }
        })
      }
    }

    const contextRoom = await loadRoom(ctx, base.pageId)
    const intent = applied.intent
      ? contextRoom.intents[applied.intent.id] ?? applied.intent
      : null
    const tasks = intent ? visibleTasks(contextRoom, intent.id) : []
    const assembled = assembleContext({
      purpose: triage.outcome === 'clarify' ? 'clarify' : 'reply',
      trigger,
      room: contextRoom,
      target: contextRoom.targets[key] ?? null,
      intent,
      steps: intent ? stepsForVersion(contextRoom, intent.id, intent.version) : [],
      planTasks: tasks.map((task) => ({
        key: task.key,
        description: task.description,
        status: task.status,
      })),
      page: gathered.page,
      threads: gathered.threads,
      presence: gathered.page?.presence ?? [],
      ownPrincipal: ctx.ownPrincipal,
      degraded: gathered.degraded,
      now: contextNow,
    })
    ctx.log(`context body ${base.blockId.slice(0, 8)} ${describeContext(assembled)}`)
    if (tasks.length > 0) {
      await updateWorking(ctx, working, `Working through ${tasks.length} tasks…`)
      await showDraft(ctx, base.pageId, key, base, tasks)
    }

    const system =
      triage.outcome === 'clarify'
        ? CLARIFY_SYSTEM_PROMPT
        : triage.outcome === 'correction'
          ? hasReply
            ? FOLLOWUP_SYSTEM_PROMPT
            : CORRECTION_SYSTEM_PROMPT
          : ANSWER_SYSTEM_PROMPT
    const prompt = renderPrompt(assembled)
    const raw = await ctx.llm!.complete({ system, prompt, signal })
    const decision = parseDecision(raw)
    const outcome = await updateRoom(ctx, base.pageId, async (room) => {
      const fresh = room.targets[key]
      const current = commitIsCurrent(room, key, {
        text: base.text,
        intentVersion: base.assumedIntentVersion,
        generation: base.generation,
      })
      if (!fresh || !current) {
        return {
          room: appendTimeline(
            room,
            attemptEntry({
              at: new Date().toISOString(),
              key,
              blockId: base.blockId,
              generation: base.generation,
              intentId: applied.intent?.id ?? null,
              intentVersion: base.assumedIntentVersion,
              kind: 'attempt_discarded',
            }),
          ),
          value: 'discarded' as const,
        }
      }
      const intentId = applied.intent.id
      const tasks = visibleTasks(room, intentId)
      const doneKeys = completedTaskKeys(tasks, decision)
      let { threadId, messageId, lastReply } = fresh
      const edited = Boolean(threadId && messageId)
      const body = tasks.length > 0 ? checklist(tasks, doneKeys, decision.reply) : decision.reply
      if (threadId && messageId) {
        await ctx.comments!.editMessage({
          threadId,
          messageId,
          body,
          dedupeOn: `reply:${body}`,
        })
        ctx.log(`updated reply in thread ${threadId.slice(0, 8)}: ${JSON.stringify(decision.reply)}`)
      } else {
        const posted = await ctx.comments!.addBlock({
          blockId: fresh.blockId,
          body,
          dedupeOn: fresh.text,
        })
        threadId = posted.threadId
        messageId = posted.messageId
        ctx.log(`replied in thread ${threadId.slice(0, 8)}: ${JSON.stringify(decision.reply)}`)
      }
      lastReply = decision.reply
      let nextRoom = recordTarget(room, {
        ...fresh,
        evaluatedText: fresh.text,
        failures: 0,
        lastAttemptAt: Date.now(),
        threadId,
        messageId,
        lastReply,
      })
      if (intentId && threadId) nextRoom = attachThreadToIntent(nextRoom, intentId, threadId)
      if (plansIntent && intentId) {
        nextRoom = completePlan(nextRoom, intentId, doneKeys)
      }
      nextRoom = appendTimeline(
        nextRoom,
        replyEntry({
          at: new Date().toISOString(),
          key,
          surface: 'body',
          blockId: fresh.blockId,
          generation: fresh.generation,
          intentId,
          intentVersion: fresh.assumedIntentVersion,
          threadId,
          messageId,
          body,
          edited,
        }),
      )
      return { room: nextRoom, value: 'written' as const }
    })
    if (outcome === 'discarded') {
      ctx.log(`draft for ${base.blockId.slice(0, 8)} discarded: text or intent moved on before it was ready`)
    }
  } catch (error) {
    if (isAbortError(error)) return // intentional cancel — not a failure, nothing to record
    const snapshot = await loadRoom(ctx, base.pageId)
    const fresh = snapshot.targets[key] ?? base
    const failures = fresh.failures + 1
    const message = error instanceof Error ? error.message : String(error)
    ctx.log(`decide/reply failed (attempt ${failures}), backing off ${backoffFor(failures)}ms: ${message}`)
    // Don't mark evaluated — retry later, at an increasing delay, instead of giving up or hot-looping.
    // A failure for text that has already moved on must not be charged to the new text.
    const recorded = await updateRoom(ctx, base.pageId, (room) => {
      const target = room.targets[key]
      if (!target) return { room, value: false }
      if (target.text !== base.text || target.generation !== base.generation)
        return { room, value: false }
      const next = recordTarget(room, {
        ...target,
        failures: target.failures + 1,
        lastAttemptAt: Date.now(),
      })
      return {
        room: appendTimeline(
          next,
          failureEntry({
            at: new Date().toISOString(),
            key,
            surface: 'body',
            blockId: target.blockId,
            threadId: target.threadId,
            generation: target.generation,
            failures: target.failures + 1,
            message,
          }),
        ),
        value: true,
      }
    })
    if (!recorded) ctx.log(`failure for ${base.blockId.slice(0, 8)} discarded: text moved on`)
  } finally {
    await endWorking(ctx, working)
  }
}

/** Comment changes are discrete: triage and answer immediately, no debounce. */
async function handleComment(
  change: CommentChange,
  ctx: ProgramContext,
  pageId: string,
  eventId: string,
  at: string,
): Promise<void> {
  if (change.change === 'deleted') {
    await updateRoom(ctx, pageId, (room) => ({
      room: closeIntentForThread(room, change.threadId),
      value: undefined,
    }))
    return
  }
  if (!change.messageId) return
  if (!change.body?.trim()) return
  const handleKey = `${change.messageId}:${change.body ?? ''}`
  const snapshot = await loadRoom(ctx, pageId)
  if (commentHandled(snapshot, change.threadId, handleKey)) return

  const verdict = triageComment(change, snapshot)
  const triage = await resolveTriage(
    ctx,
    verdict,
    'comment',
    change.body ?? '',
    snapshot,
    null,
  )
  const where = change.threadId.slice(0, 8)
  ctx.log(`triage comment ${where}: ${triage.outcome} (${triage.source}) ${triage.reason}`)

  const plansIntent = triage.outcome === 'new_action' || triage.outcome === 'correction'
  const prior = triage.intentId ? snapshot.intents[triage.intentId] : undefined
  const timelineScope = {
    ...(change.blockId ? { blockId: change.blockId } : {}),
    threadId: change.threadId,
  }
  const triageInput = {
    intentId: triage.intentId,
    kind: kindFor(triage.outcome),
    targetScope: { pageId, ...timelineScope },
    confidence: triage.confidence,
    evidence: { eventId, at, messageId: change.messageId! },
  }
  const gathered = await gatherContext({
    ctx,
    pageId,
    surface: 'comment',
    blockId: change.blockId,
    threadId: change.threadId,
    key: handleKey,
  })
  const trigger: TriggerContext = {
    surface: 'comment',
    change: change.change,
    text: change.body ?? '',
    previousText: null,
    threadId: change.threadId,
    blockId: change.blockId,
    messageId: change.messageId,
    author: change.authorDisplayName ?? change.driver,
  }
  const priorSteps = prior ? stepsForVersion(snapshot, prior.id, prior.version) : []
  const proposal = plansIntent
    ? await proposePlan(ctx, {
        surface: 'comment',
        hasReply: false,
        context: assembleContext({
          purpose: 'plan',
          trigger,
          room: snapshot,
          target: null,
          intent: prior ?? null,
          intentKind: kindFor(triage.outcome),
          steps: priorSteps,
          planTasks: priorSteps.map((step) => ({
            key: step.key,
            description: step.description,
            status: step.status,
          })),
          page: gathered.page,
          threads: gathered.threads,
          presence: gathered.page?.presence ?? [],
          ownPrincipal: ctx.ownPrincipal,
          degraded: gathered.degraded,
          now: at,
        }),
      })
    : null

  const commentTasks = (proposal ?? []).filter((step) => step.kind === 'task')
  const assembled = assembleContext({
    purpose: triage.outcome === 'clarify' ? 'clarify' : 'reply',
    trigger,
    room: snapshot,
    target: null,
    intent: prior ?? null,
    intentKind: kindFor(triage.outcome),
    steps: prior ? stepsForVersion(snapshot, prior.id, prior.version) : [],
    planTasks: commentTasks.map((task) => ({
      key: task.key,
      description: task.description,
      status: 'pending',
    })),
    page: gathered.page,
    threads: gathered.threads,
    presence: gathered.page?.presence ?? [],
    ownPrincipal: ctx.ownPrincipal,
    degraded: gathered.degraded,
    now: at,
  })
  ctx.log(`context comment ${where} ${describeContext(assembled)}`)
  const raw = await ctx.llm!.complete({
    system: triage.outcome === 'clarify' ? CLARIFY_SYSTEM_PROMPT : COMMENT_SYSTEM_PROMPT,
    prompt: renderPrompt(assembled),
  })
  const decision = parseDecision(raw)

  const result = await updateRoom(ctx, pageId, async (room) => {
    if (commentHandled(room, change.threadId, handleKey))
      return { room, value: 'duplicate' as const }
    const applied = applyTriage(room, triageInput, at, true)
    const priorVersion = applied.intent
      ? room.intents[applied.intent.id]?.version ?? 0
      : 0
    let next = appendTimeline(
      applied.room,
      triageEntry({
        eventId: `${eventId}:${change.messageId ?? change.threadId}`,
        at,
        surface: 'comment',
        scope: timelineScope,
        triage,
      }),
    )
    const intent = applied.intent
    if (intent && priorVersion > 0 && intent.version > priorVersion) {
      next = appendTimeline(
        next,
        intentVersionEntry({
          at,
          intent,
          previousVersion: priorVersion,
        }),
      )
    }
    if (plansIntent && intent) {
      next = planIntent(
        next,
        intent.id,
        intent.version,
        proposal ?? fallbackPlan('comment', false),
      )
      const step = nextStep(next, intent.id)
      if (step) next = activateStep(next, step.id)
    }
    const tasks = (proposal ?? []).filter((step) => step.kind === 'task')
    const doneKeys = completedTaskKeys(tasks, decision)
    const body =
      tasks.length > 0 ? checklist(tasks, doneKeys, decision.reply) : decision.reply
    const posted = await ctx.comments!.replyToThread({
      threadId: change.threadId,
      body,
      dedupeOn: handleKey,
    })
    next = markCommentHandled(next, change.threadId, handleKey)
    if (intent) {
      next = attachThreadToIntent(next, intent.id, change.threadId)
      if (plansIntent) next = completePlan(next, intent.id, doneKeys)
    }
    next = appendTimeline(
      next,
      replyEntry({
        at: new Date().toISOString(),
        key: handleKey,
        surface: 'comment',
        blockId: change.blockId,
        generation: 0,
        intentId: intent?.id ?? null,
        intentVersion: intent?.version ?? null,
        threadId: change.threadId,
        messageId: posted.messageId,
        body,
        edited: false,
      }),
    )
    return { room: next, value: 'posted' as const }
  })
  if (result === 'posted')
    ctx.log(`replied in thread ${where}: ${JSON.stringify(decision.reply)}`)
}

function describeComment(change: CommentChange): string {
  const by = change.driver ?? change.authorPrincipal ?? 'unknown'
  const where = change.threadId.slice(0, 8)
  if (change.change === 'deleted') return `comment ${where} deleted`
  return `comment ${where} ${change.change} by ${by}: ${JSON.stringify(change.body ?? '')}`
}

function describeSelection(change: SelectionChange): string {
  const by = change.driver ?? change.principal
  const text = change.quote ? `: ${JSON.stringify(change.quote)}` : ''
  return `selection ${change.blockId.slice(0, 8)} ${change.change} (${change.kind ?? 'selection'}) by ${by}${text}`
}

export { attempt, looksComplete, SPECULATIVE_PAUSE_MS }

export default defineProgram({
  manifest: { name: 'echo', triggers: ['page.changed'] },
  key: (event) => event.pageId,
  async handle(event, ctx) {
    if (event.titleChanged) ctx.log(`title → ${JSON.stringify(event.title)}`)
    for (const change of event.changes) {
      if (change.surface === 'comment') {
        await updateRoom(ctx, event.pageId, (room) => {
          const deleted = change.change === 'deleted'
          const next = deleted
            ? forgetThread(room, change.threadId)
            : recordCommentEvidence(room, change, event.id, event.at)
          return {
            room: appendTimeline(
              next,
              userCommentEntry({ eventId: event.id, at: event.at, change, deleted }),
            ),
            value: undefined,
          }
        })
        ctx.log(describeComment(change))
        if (ctx.llm && ctx.comments) await handleComment(change, ctx, event.pageId, event.id, event.at)
        continue
      }
      if (change.surface === 'selection') {
        await updateRoom(ctx, event.pageId, (room) => ({
          room:
            change.change === 'cleared'
              ? clearSelection(room, change.peerId)
              : noteSelection(room, change),
          value: undefined,
        }))
        ctx.log(describeSelection(change))
        continue
      }
      const line = await describe(change, ctx, event.pageId, event.id, event.at)
      if (line) ctx.log(line)
    }
  },
  async tick(ctx) {
    if (!ctx.llm || !ctx.comments) return // no model/write capability configured — nothing to do
    const room = await ensureRoom(ctx, ctx.pageId ?? '')
    const now = Date.now()
    for (const [key, record] of Object.entries(room.targets)) {
      const inFlight = ctx.scratch.get<SpeculativeAttempt>(key)
      if (inFlight) {
        if (inFlight.baseText !== record.text) abortSpeculative(ctx, key)
        continue // either still running on matching text, or just aborted — try fresh next tick
      }

      if (record.evaluatedText === record.text) continue
      if (!record.text.trim()) continue
      if (!looksComplete(record.text) && now - record.changedAt < SPECULATIVE_PAUSE_MS) continue
      if (record.lastAttemptAt && now - record.lastAttemptAt < backoffFor(record.failures)) continue

      const controller = new AbortController()
      ctx.scratch.set<SpeculativeAttempt>(key, { baseText: record.text, controller })
      // Fire-and-forget: tick() doesn't await this, so one slow draft never blocks polling
      // or other nodes. attempt() cleans up its own scratch entry and state on completion.
      void attempt(key, record, ctx, controller.signal).finally(() => {
        const current = ctx.scratch.get<SpeculativeAttempt>(key)
        if (current?.controller === controller) ctx.scratch.delete(key)
      })
    }
  },
})
