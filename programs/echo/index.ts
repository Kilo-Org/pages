import { defineProgram, type NodeChange, type ProgramContext } from '@pages-programs/sdk'

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

const nodeKey = (change: NodeChange) => `nodes/${change.blockId}:${change.nodeId ?? change.nodeIndex ?? 0}`

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

type NodeRecord = {
  blockId: string
  text: string
  changedAt: number
  /** The exact text we last completed an attempt for — null means "not evaluated yet". */
  evaluatedText: string | null
  /** Consecutive decide/reply failures for the current `text`. Resets on success or on a new edit. */
  failures: number
  /** When we last attempted this `text`, for backoff gating. 0 means never attempted. */
  lastAttemptAt: number
  /** Set once echo has replied to this node — further updates edit this same message. */
  threadId: string | null
  messageId: string | null
  /** The reply text currently posted, fed back into the prompt so a correction is coherent. */
  lastReply: string | null
}

/** Builds the record for `text`, preserving reply identity across edits (`prior`'s thread/message/reply). */
function withText(prior: NodeRecord | undefined, blockId: string, text: string): NodeRecord {
  return {
    blockId,
    text,
    changedAt: Date.now(),
    evaluatedText: null,
    failures: 0,
    lastAttemptAt: 0,
    threadId: prior?.threadId ?? null,
    messageId: prior?.messageId ?? null,
    lastReply: prior?.lastReply ?? null,
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

async function describe(change: NodeChange, ctx: ProgramContext): Promise<string | null> {
  if (change.scope === 'block') return `block ${change.blockId.slice(0, 8)} ${change.change}`
  const key = nodeKey(change)
  if (change.change === 'deleted') {
    await ctx.state.delete(key)
    abortSpeculative(ctx, key)
    return `deleted ${change.type ?? 'node'}`
  }
  const after = change.markdown ?? ''
  // A stale pre-upgrade state file holds a plain string here instead of a NodeRecord. Treat
  // anything that isn't one as "never seen" rather than crash on `.text` of a string/number.
  const beforeRaw = await ctx.state.get<NodeRecord | unknown>(key)
  const before = beforeRaw && typeof beforeRaw === 'object' ? (beforeRaw as NodeRecord) : undefined
  if (after !== before?.text) {
    // New text invalidates any speculative draft that was based on the old text.
    abortSpeculative(ctx, key)
    await ctx.state.set<NodeRecord>(key, withText(before, change.blockId, after))
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
 * The speculative attempt: decide, then commit only if the text it was based on still matches —
 * that re-read is the actual correctness guarantee; the abort signal above is just the
 * performance optimization that avoids paying for (and waiting on) drafts that get thrown away.
 */
async function attempt(key: string, base: NodeRecord, ctx: ProgramContext, signal: AbortSignal): Promise<void> {
  const system = base.threadId ? FOLLOWUP_SYSTEM_PROMPT : SYSTEM_PROMPT
  const prompt = base.threadId ? `Previous reply: ${JSON.stringify(base.lastReply)}\n\nCurrent text: ${base.text}` : base.text
  try {
    const raw = await ctx.llm!.complete({ system, prompt, signal })
    const decision = parseDecision(raw)
    const fresh = await ctx.state.get<NodeRecord>(key)
    if (!fresh || fresh.text !== base.text) {
      ctx.log(`draft for ${base.blockId.slice(0, 8)} discarded: text moved on before it was ready`)
      return
    }
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
    await ctx.state.set<NodeRecord>(key, { ...fresh, evaluatedText: fresh.text, failures: 0, lastAttemptAt: Date.now(), threadId, messageId, lastReply })
  } catch (error) {
    if (isAbortError(error)) return // intentional cancel — not a failure, nothing to record
    const fresh = (await ctx.state.get<NodeRecord>(key)) ?? base
    const failures = fresh.failures + 1
    const message = error instanceof Error ? error.message : String(error)
    ctx.log(`decide/reply failed (attempt ${failures}), backing off ${backoffFor(failures)}ms: ${message}`)
    // Don't mark evaluated — retry later, at an increasing delay, instead of giving up or hot-looping.
    await ctx.state.set<NodeRecord>(key, { ...fresh, failures, lastAttemptAt: Date.now() })
  }
}

export { attempt, looksComplete, SPECULATIVE_PAUSE_MS }

export default defineProgram({
  manifest: { name: 'echo', triggers: ['page.changed'] },
  key: (event) => event.pageId,
  async handle(event, ctx) {
    if (event.titleChanged) ctx.log(`title → ${JSON.stringify(event.title)}`)
    for (const change of event.changes) {
      const line = await describe(change, ctx)
      if (line) ctx.log(line)
    }
  },
  async tick(ctx) {
    if (!ctx.llm || !ctx.comments) return // no model/write capability configured — nothing to do
    const now = Date.now()
    for (const key of await ctx.state.list('nodes/')) {
      const record = await ctx.state.get<NodeRecord>(key)
      if (!record || typeof record !== 'object') continue

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
