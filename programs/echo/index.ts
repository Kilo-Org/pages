import {
  defineProgram,
  type BodyChange,
  type CommentChange,
  type ProgramContext,
  type SelectionChange,
} from '@pages-programs/sdk'
import {
  attachThreadToIntent,
  clearSelection,
  commitIsCurrent,
  emptyRoom,
  findActiveIntentForTarget,
  forgetThread,
  migrateNodes,
  noteSelection,
  recordBodyChange,
  recordCommentEvidence,
  recordTarget,
  removeTarget,
  type RoomState,
  type TargetState,
} from './room.ts'

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

function normalizeRoom(room: RoomState, pageId = ''): RoomState {
  return {
    ...room,
    pageId: room.pageId || pageId,
    intentSeq: room.intentSeq ?? 0,
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

const SYSTEM_PROMPT = [
  'You watch one block of text on a collaborative page. The author just paused.',
  'Reply only if the text is a direct question, request, or unresolved TODO that calls for an answer.',
  'Stay silent for statements, headings, code, or anything not addressed to a reader.',
  'Respond with strict JSON only, no prose, no code fences: {"respond": boolean, "reply": string or null}.',
  'When respond is true, reply is a short, direct answer (1-3 sentences). When false, reply is null.',
].join(' ')

const FOLLOWUP_SYSTEM_PROMPT = [
  'You watch one block of text on a collaborative page. You already replied to it once; the text has changed since.',
  'The change may be a correction, a refinement, unrelated new content, or nothing worth updating your reply for.',
  'If you update it, write the FULL replacement reply text: it wholly replaces your previous reply, it does not append to it.',
  'Stay silent (respond: false) if your existing reply still stands and nothing material changed.',
  'Respond with strict JSON only, no prose, no code fences: {"respond": boolean, "reply": string or null}.',
].join(' ')

type Decision = { respond: boolean; reply?: string }

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
  const { respond, reply } = parsed as { respond: unknown; reply?: unknown }
  if (typeof respond !== 'boolean') throw new Error(`malformed decision: ${cleaned.slice(0, 200)}`)
  return { respond, reply: typeof reply === 'string' && reply.trim() ? reply.trim() : undefined }
}

type SpeculativeAttempt = { baseText: string; controller: AbortController }

/** Cancels and forgets any in-flight speculative work for `key` — a no-op if there is none. */
function abortSpeculative(ctx: ProgramContext, key: string): void {
  const attempt = ctx.scratch.get<SpeculativeAttempt>(key)
  if (attempt) {
    attempt.controller.abort()
    ctx.scratch.delete(key)
  }
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
const looksComplete = (text: string) => /[?.!]\s*$/.test(text.trim())

/** Exponential backoff after `failures` consecutive attempts, starting at SPECULATIVE_PAUSE_MS, capped at MAX_BACKOFF_MS. */
const backoffFor = (failures: number) =>
  failures === 0 ? 0 : Math.min(SPECULATIVE_PAUSE_MS * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS)

/**
 * The speculative attempt: decide, then commit only if the text, generation,
 * and intent version it was based on still match. The commit check runs inside
 * the room lock, immediately before the write.
 */
async function attempt(key: string, base: TargetState, ctx: ProgramContext, signal: AbortSignal): Promise<void> {
  const system = base.threadId ? FOLLOWUP_SYSTEM_PROMPT : SYSTEM_PROMPT
  const prompt = base.threadId ? `Previous reply: ${JSON.stringify(base.lastReply)}\n\nCurrent text: ${base.text}` : base.text
  try {
    const raw = await ctx.llm!.complete({ system, prompt, signal })
    const decision = parseDecision(raw)
    const outcome = await updateRoom(ctx, base.pageId, async (room) => {
      const fresh = room.targets[key]
      const current = commitIsCurrent(room, key, {
        text: base.text,
        intentVersion: base.assumedIntentVersion,
        generation: base.generation,
      })
      if (!fresh || !current) return { room, value: 'discarded' as const }
      let { threadId, messageId, lastReply } = fresh
      if (decision.respond && decision.reply) {
        if (threadId && messageId) {
          await ctx.comments!.editMessage({ threadId, messageId, body: decision.reply, dedupeOn: fresh.text })
          ctx.log(`updated reply in thread ${threadId.slice(0, 8)}: ${JSON.stringify(decision.reply)}`)
        } else {
          const posted = await ctx.comments!.addBlock({ blockId: fresh.blockId, body: decision.reply, dedupeOn: fresh.text })
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
      if (threadId) {
        const intent = findActiveIntentForTarget(nextRoom, key)
        if (intent) nextRoom = attachThreadToIntent(nextRoom, intent.id, threadId)
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
    // A failure for text that has already moved on must not be charged to the new text.
    const recorded = await updateRoom(ctx, base.pageId, (room) => {
      const target = room.targets[key]
      if (!target) return { room, value: false }
      if (target.text !== base.text || target.generation !== base.generation)
        return { room, value: false }
      return {
        room: recordTarget(room, {
          ...target,
          failures: target.failures + 1,
          lastAttemptAt: Date.now(),
        }),
        value: true,
      }
    })
    if (!recorded) ctx.log(`failure for ${base.blockId.slice(0, 8)} discarded: text moved on`)
  }
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
          room:
            change.change === 'deleted'
              ? forgetThread(room, change.threadId)
              : recordCommentEvidence(room, change, event.id, event.at),
          value: undefined,
        }))
        ctx.log(describeComment(change))
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
