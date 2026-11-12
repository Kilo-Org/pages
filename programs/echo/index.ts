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
  cancelPlan,
  clearSelection,
  closeIntentForThread,
  commentHandled,
  commitIsCurrent,
  completePlan,
  emptyRoom,
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
  kindFor,
  parseTodoWriteCall,
  parseTriage,
  PLAN_SYSTEM_PROMPT,
  TODO_WRITE_TOOL,
  triageBody,
  triageComment,
  triagePrompt,
  TRIAGE_SYSTEM_PROMPT,
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
/** Below this many trimmed characters, don't bother asking the model. */
const MIN_CHARS = 3
/** Backoff after a failed attempt starts at SPECULATIVE_PAUSE_MS and doubles, capped here. */
const MAX_BACKOFF_MS = 5 * 60_000

const ROOM_KEY = 'room'
const ROOM_LOCK = 'room-lock'

/** Reads the room, upgrading PR 3's flat `nodes/*` records once. */
async function loadRoom(ctx: ProgramContext, pageId = ''): Promise<RoomState> {
  const stored = await ctx.state.get<RoomState>(ROOM_KEY)
  if (stored && stored.schemaVersion === 1) {
    const steps = Object.fromEntries(
      Object.entries(stored.steps ?? {}).map(([id, step], index) => [
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
      ...stored,
      intents: stored.intents ?? {},
      steps,
      targets: stored.targets ?? {},
      selections: stored.selections ?? {},
      handledComments: stored.handledComments ?? {},
    }
  }
  const records: Record<string, unknown> = {}
  for (const key of await ctx.state.list('nodes/')) records[key] = await ctx.state.get(key)
  if (Object.keys(records).length === 0) return emptyRoom(pageId || stored?.pageId || '')
  return migrateNodes(records, pageId || stored?.pageId || '')
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

const ANSWER_SYSTEM_PROMPT = [
  'You are answering a question or request on a collaborative page.',
  'Triage already decided the text needs a reply, so do not stay silent.',
  'Answer it directly in 1-3 sentences. If it is too vague to answer, ask one short clarifying question.',
  'Set "completed" false when you are asking for missing context or could not finish the request; otherwise true.',
  'When Plan tasks are provided, "completedTasks" lists the keys you finished; use [] for none.',
  'Respond with strict JSON only, no prose, no code fences: {"respond": true, "reply": string, "completed": boolean, "completedTasks": string[]}.',
].join(' ')

const COMMENT_SYSTEM_PROMPT = [
  'You are answering a message in one comment thread on a collaborative page.',
  'Triage already decided the message needs a reply, so do not stay silent.',
  'Answer it, or ask one short clarifying question if it is too vague.',
  'Set "completed" false when you are asking for missing context or could not finish the request; otherwise true.',
  'When Plan tasks are provided, "completedTasks" lists the keys you finished; use [] for none.',
  'Respond with strict JSON only, no prose, no code fences: {"respond": true, "reply": string, "completed": boolean, "completedTasks": string[]}.',
].join(' ')

const CORRECTION_SYSTEM_PROMPT = [
  'You are handling a correction to text on a collaborative page.',
  'Use the previous text and the correction to work out what should change.',
  'If the correction is still too vague to act on, ask one short, specific question.',
  'Set "completed" false when you are asking for missing context or could not finish the change; otherwise true.',
  'When Plan tasks are provided, "completedTasks" lists the keys you finished; use [] for none.',
  'Respond with strict JSON only, no prose, no code fences: {"respond": true, "reply": string, "completed": boolean, "completedTasks": string[]}.',
].join(' ')

const CLARIFY_SYSTEM_PROMPT = [
  'The request on this page is ambiguous. Ask one short, specific clarifying question.',
  'Respond with strict JSON only, no prose, no code fences: {"respond": true, "reply": string}.',
].join(' ')

const FOLLOWUP_SYSTEM_PROMPT = [
  'You watch one block of text on a collaborative page. You already replied to it once; the text has changed since.',
  'The change may be a correction, a refinement, unrelated new content, or nothing worth updating your reply for.',
  'If you update it, write the FULL replacement reply text: it wholly replaces your previous reply, it does not append to it.',
  'Stay silent (respond: false) if your existing reply still stands and nothing material changed.',
  'Set "completed" false when you are asking for missing context or could not finish the change; otherwise true.',
  'When Plan tasks are provided, "completedTasks" lists the keys you finished; use [] for none.',
  'Respond with strict JSON only, no prose, no code fences: {"respond": boolean, "reply": string or null, "completed": boolean, "completedTasks": string[]}.',
].join(' ')

type Decision = { respond: boolean; reply?: string; completed?: boolean; completedTasks?: string[] }

function parseDecision(raw: string): Decision {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/```$/, '')
    .trim()
  const parsed: unknown = JSON.parse(cleaned)
  if (typeof parsed !== 'object' || parsed === null || !('respond' in parsed)) {
    throw new Error(`malformed decision: ${cleaned.slice(0, 200)}`)
  }
  const { respond, reply, completed, completedTasks } = parsed as {
    respond: unknown
    reply?: unknown
    completed?: unknown
    completedTasks?: unknown
  }
  if (typeof respond !== 'boolean') throw new Error(`malformed decision: ${cleaned.slice(0, 200)}`)
  return {
    respond,
    reply: typeof reply === 'string' && reply.trim() ? reply.trim() : undefined,
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
): Promise<Triage> {
  if (!('ambiguous' in verdict)) return verdict
  try {
    const raw = await ctx.llm!.complete({
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: triagePrompt(surface, text, room, targetKey),
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
    outcome: 'new_action' | 'correction'
    request: string
    previousText: string | null
    previousReply: string | null
    hasReply: boolean
    existingSteps: PlanStep[]
  },
  signal?: AbortSignal,
): Promise<PlanStepInput[] | null> {
  if (!ctx.llm?.completeWithTools) return null
  try {
    const result = await ctx.llm.completeWithTools({
      system: PLAN_SYSTEM_PROMPT,
      prompt: JSON.stringify({
        surface: input.surface,
        outcome: input.outcome,
        request: input.request,
        previousText: input.previousText,
        previousReply: input.previousReply,
        canEditReply: input.surface === 'body' && input.hasReply,
        existingSteps: input.existingSteps.map((step) => ({
          kind: step.kind,
          description: step.description,
          status: step.status,
        })),
      }),
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
      const target = withText(prior, pageId, change, after)
      return {
        room: recordBodyChange(room, target, { eventId, at }, at),
        value: undefined,
      }
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

/**
 * The speculative attempt: decide, then commit only if the text, generation,
 * and intent version it was based on still match. The commit check runs inside
 * the room lock, immediately before the write.
 */
async function attempt(key: string, base: TargetState, ctx: ProgramContext, signal: AbortSignal): Promise<void> {
  // Best-effort UX hint: a reading caret can show up well before the model call
  // resolves. Never let this delay or fail the actual attempt.
  void ctx.presence?.showReading(base.blockId).catch(() => {})
  try {
    const snapshot = await loadRoom(ctx, base.pageId)
    const verdict = triageBody(base.text, snapshot, key)
    const triage = await resolveTriage(ctx, verdict, 'body', base.text, snapshot, key, signal)
    if (triage.outcome !== 'ignore')
      ctx.log(`triage ${base.blockId.slice(0, 8)}: ${triage.outcome} (${triage.source}) ${triage.reason}`)
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
      return {
        room: withFence,
        value: {
          intent,
          steps: intent ? stepsForVersion(withFence, intent.id, intent.version) : [],
          priorSteps: intent
            ? stepsForVersion(withFence, intent.id, intent.version - 1)
            : [],
        },
      }
    })
    if (triage.outcome === 'ignore') {
      await updateRoom(ctx, base.pageId, (room) => {
        const target = room.targets[key]
        if (!target) return { room, value: undefined }
        return {
          room: recordTarget(room, {
            ...target,
            evaluatedText: target.text,
            failures: 0,
            lastAttemptAt: Date.now(),
          }),
          value: undefined,
        }
      })
      ctx.log(`ignored ${base.blockId.slice(0, 8)}: ${triage.reason}`)
      return
    }
    const hasReply = Boolean(base.threadId && base.lastReply)
    const plansIntent =
      applied.intent !== undefined &&
      (triage.outcome === 'new_action' || triage.outcome === 'correction')
    let taskContext: string | null = null
    if (plansIntent) {
      const current = applied.intent!
      let planned = false
      if (applied.steps.length === 0) {
        const proposal = await proposePlan(
          ctx,
          {
            surface: 'body',
            outcome: triage.outcome as 'new_action' | 'correction',
            request: base.text,
            previousText: base.previousText,
            previousReply: base.lastReply,
            hasReply,
            existingSteps: applied.priorSteps,
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
      const planRoom = await loadRoom(ctx, base.pageId)
      const tasks = visibleTasks(planRoom, current.id)
      taskContext = tasks.length
        ? `Plan tasks (keys):\n${tasks.map((task) => `${task.key}: ${task.description}`).join('\n')}`
        : null
      if (tasks.length > 0) await showDraft(ctx, base.pageId, key, base, tasks)
    }
    const system =
      triage.outcome === 'clarify'
        ? CLARIFY_SYSTEM_PROMPT
        : triage.outcome === 'correction'
          ? hasReply
            ? FOLLOWUP_SYSTEM_PROMPT
            : CORRECTION_SYSTEM_PROMPT
          : ANSWER_SYSTEM_PROMPT
    const promptParts: string[] = []
    if (taskContext) promptParts.push(taskContext)
    if (triage.outcome === 'correction' && base.previousText)
      promptParts.push(`Previous text: ${JSON.stringify(base.previousText)}`)
    if (hasReply) promptParts.push(`Previous reply: ${JSON.stringify(base.lastReply)}`)
    const prompt =
      promptParts.length > 0
        ? `${promptParts.join('\n\n')}\n\nCurrent text: ${JSON.stringify(base.text)}`
        : base.text
    const raw = await ctx.llm!.complete({ system, prompt, signal })
    const decision = parseDecision(raw)
    if (!decision.respond || !decision.reply)
      ctx.log(`declined ${base.blockId.slice(0, 8)}: triage ${triage.outcome}`)
    const outcome = await updateRoom(ctx, base.pageId, async (room) => {
      const fresh = room.targets[key]
      const current = commitIsCurrent(room, key, {
        text: base.text,
        intentVersion: base.assumedIntentVersion,
        generation: base.generation,
      })
      if (!fresh || !current) return { room, value: 'discarded' as const }
      const intentId = applied.intent?.id
      const tasks = intentId ? visibleTasks(room, intentId) : []
      const doneKeys = completedTaskKeys(tasks, decision)
      let { threadId, messageId, lastReply } = fresh
      if (decision.respond && decision.reply) {
        const body =
          tasks.length > 0 ? checklist(tasks, doneKeys, decision.reply) : decision.reply
        if (threadId && messageId) {
          await ctx.comments!.editMessage({
            threadId,
            messageId,
            body,
            dedupeOn: `reply:${body}`,
          })
          ctx.log(`updated reply in thread ${threadId.slice(0, 8)}: ${JSON.stringify(decision.reply)}`)
        } else {
          const posted = await ctx.comments!.addBlock({ blockId: fresh.blockId, body, dedupeOn: fresh.text })
          threadId = posted.threadId
          messageId = posted.messageId
          ctx.log(`replied in thread ${threadId.slice(0, 8)}: ${JSON.stringify(decision.reply)}`)
        }
        lastReply = decision.reply
      }
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
      if (plansIntent && intentId && decision.respond && decision.reply) {
        nextRoom = completePlan(nextRoom, intentId, doneKeys)
      }
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
    await updateRoom(ctx, base.pageId, (room) => {
      const target = room.targets[key]
      if (!target) return { room, value: undefined }
      return {
        room: recordTarget(room, { ...target, failures, lastAttemptAt: Date.now() }),
        value: undefined,
      }
    })
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
  if (triage.outcome !== 'ignore')
    ctx.log(`triage comment ${where}: ${triage.outcome} (${triage.source}) ${triage.reason}`)

  if (triage.outcome === 'ignore') {
    await updateRoom(ctx, pageId, (room) => ({
      room: markCommentHandled(room, change.threadId, handleKey),
      value: undefined,
    }))
    ctx.log(`ignored comment ${where}: ${triage.reason}`)
    return
  }

  const plansIntent = triage.outcome === 'new_action' || triage.outcome === 'correction'
  const prior = triage.intentId ? snapshot.intents[triage.intentId] : undefined
  const proposal = plansIntent
    ? await proposePlan(ctx, {
        surface: 'comment',
        outcome: triage.outcome as 'new_action' | 'correction',
        request: change.body ?? '',
        previousText: null,
        previousReply: null,
        hasReply: false,
        existingSteps: prior ? stepsForVersion(snapshot, prior.id, prior.version) : [],
      })
    : null
  const scope = {
    pageId,
    ...(change.blockId ? { blockId: change.blockId } : {}),
    threadId: change.threadId,
  }
  const triageInput = {
    intentId: triage.intentId,
    kind: kindFor(triage.outcome),
    targetScope: scope,
    confidence: triage.confidence,
    evidence: { eventId, at, messageId: change.messageId! },
  }

  const commentTasks = (proposal ?? []).filter((step) => step.kind === 'task')
  const taskLines = commentTasks
    .map((task) => `${task.key}: ${task.description}`)
    .join('\n')
  const raw = await ctx.llm!.complete({
    system: triage.outcome === 'clarify' ? CLARIFY_SYSTEM_PROMPT : COMMENT_SYSTEM_PROMPT,
    prompt: `Thread ${change.threadId}\nComment: ${change.body ?? ''}${taskLines ? `\n\nPlan tasks (keys):\n${taskLines}` : ''}`,
  })
  const decision = parseDecision(raw)
  if (!decision.respond || !decision.reply) {
    await updateRoom(ctx, pageId, (room) => {
      const applied = applyTriage(room, triageInput, at, true)
      let settled = markCommentHandled(applied.room, change.threadId, handleKey)
      if (plansIntent && applied.intent) {
        settled = planIntent(
          settled,
          applied.intent.id,
          applied.intent.version,
          proposal ?? fallbackPlan('comment', false),
        )
        settled = cancelPlan(settled, applied.intent.id)
      }
      return { room: settled, value: undefined }
    })
    ctx.log(`declined comment ${where}: triage ${triage.outcome}`)
    return
  }

  const result = await updateRoom(ctx, pageId, async (room) => {
    if (commentHandled(room, change.threadId, handleKey))
      return { room, value: 'duplicate' as const }
    const applied = applyTriage(room, triageInput, at, true)
    let next = applied.room
    const intent = applied.intent
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
      tasks.length > 0 ? checklist(tasks, doneKeys, decision.reply!) : decision.reply!
    await ctx.comments!.replyToThread({
      threadId: change.threadId,
      body,
      dedupeOn: handleKey,
    })
    next = markCommentHandled(next, change.threadId, handleKey)
    if (intent) {
      next = attachThreadToIntent(next, intent.id, change.threadId)
      if (plansIntent) next = completePlan(next, intent.id, doneKeys)
    }
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
        await updateRoom(ctx, event.pageId, (room) => ({
          room: recordCommentEvidence(room, change, event.id, event.at),
          value: undefined,
        }))
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
    const room = await loadRoom(ctx)
    const now = Date.now()
    for (const [key, record] of Object.entries(room.targets)) {
      const inFlight = ctx.scratch.get<SpeculativeAttempt>(key)
      if (inFlight) {
        if (inFlight.baseText !== record.text) abortSpeculative(ctx, key)
        continue // either still running on matching text, or just aborted — try fresh next tick
      }

      if (record.evaluatedText === record.text) continue
      if (record.text.trim().length < MIN_CHARS) continue
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
