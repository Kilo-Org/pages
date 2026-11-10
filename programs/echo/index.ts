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

/** How long a node's text must sit unchanged before we consider replying to it. */
const QUIET_MS = 8_000
/** Below this many trimmed characters, don't bother asking the model. */
const MIN_CHARS = 3
/** Backoff after a failed attempt starts at QUIET_MS and doubles, capped here. */
const MAX_BACKOFF_MS = 5 * 60_000

type NodeRecord = {
  blockId: string
  text: string
  changedAt: number
  /** The exact text we last asked the model about — null means "not evaluated yet". */
  evaluatedText: string | null
  /** Consecutive decide/reply failures for the current `text`. Resets on success or on a new edit. */
  failures: number
  /** When we last attempted this `text`, for backoff gating. 0 means never attempted. */
  lastAttemptAt: number
}

const newRecord = (blockId: string, text: string): NodeRecord => ({
  blockId,
  text,
  changedAt: Date.now(),
  evaluatedText: null,
  failures: 0,
  lastAttemptAt: 0,
})

const SYSTEM_PROMPT = [
  'You watch one block of text on a collaborative page. The author just stopped typing.',
  'Reply only if the text is a direct question, request, or unresolved TODO that calls for an answer.',
  'Stay silent for statements, headings, code, or anything not addressed to a reader.',
  'Respond with strict JSON only, no prose, no code fences: {"respond": boolean, "reply": string or null}.',
  'When respond is true, reply is a short, direct answer (1-3 sentences). When false, reply is null.',
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

async function describe(change: NodeChange, ctx: ProgramContext): Promise<string | null> {
  if (change.scope === 'block') return `block ${change.blockId.slice(0, 8)} ${change.change}`
  const key = nodeKey(change)
  if (change.change === 'deleted') {
    await ctx.state.delete(key)
    return `deleted ${change.type ?? 'node'}`
  }
  const after = change.markdown ?? ''
  // A stale pre-upgrade state file holds a plain string here instead of a NodeRecord. Treat
  // anything that isn't one as "never seen" rather than crash on `.text` of a string/number.
  const beforeRaw = await ctx.state.get<NodeRecord | unknown>(key)
  const before = beforeRaw && typeof beforeRaw === 'object' ? (beforeRaw as NodeRecord) : undefined
  if (after !== before?.text) {
    await ctx.state.set<NodeRecord>(key, newRecord(change.blockId, after))
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

/** Exponential backoff after `failures` consecutive attempts, starting at QUIET_MS, capped at MAX_BACKOFF_MS. */
const backoffFor = (failures: number) => (failures === 0 ? 0 : Math.min(QUIET_MS * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS))

async function evaluate(key: string, record: NodeRecord, ctx: ProgramContext): Promise<void> {
  try {
    const raw = await ctx.llm!.complete({ system: SYSTEM_PROMPT, prompt: record.text })
    const decision = parseDecision(raw)
    if (decision.respond && decision.reply) {
      const { threadId } = await ctx.comments!.addBlock({ blockId: record.blockId, body: decision.reply, dedupeOn: record.text })
      ctx.log(`replied in thread ${threadId.slice(0, 8)}: ${JSON.stringify(decision.reply)}`)
    }
    await ctx.state.set<NodeRecord>(key, { ...record, evaluatedText: record.text, failures: 0, lastAttemptAt: Date.now() })
  } catch (error) {
    const failures = record.failures + 1
    const message = error instanceof Error ? error.message : String(error)
    ctx.log(`decide/reply failed (attempt ${failures}), backing off ${backoffFor(failures)}ms: ${message}`)
    // Don't mark evaluated — retry later, at an increasing delay, instead of giving up or hot-looping.
    await ctx.state.set<NodeRecord>(key, { ...record, failures, lastAttemptAt: Date.now() })
  }
}

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
      if (record.evaluatedText === record.text) continue
      if (record.text.trim().length < MIN_CHARS) continue
      if (now - record.changedAt < QUIET_MS) continue
      if (record.lastAttemptAt && now - record.lastAttemptAt < backoffFor(record.failures)) continue
      await evaluate(key, record, ctx)
    }
  },
})
