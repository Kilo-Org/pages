// The archivist's warm tier: a bounded, append-only record of what happened on
// a page. Entries are deterministic summaries and references, never a copy of
// the page, a transcript, or model reasoning.
import type { CommentChange } from '@pages-programs/sdk'
import type {
  Intent,
  RoomState,
  TargetState,
  TimelineEntry,
  TimelineScope,
} from './room.ts'
import type { Triage } from './triage.ts'

export const TIMELINE_LIMIT = 200
export const TIMELINE_SUMMARY_MAX = 200
export const TIMELINE_EXCERPT_MAX = 120

const encoder = new TextEncoder()

export const byteLength = (value: string): number => encoder.encode(value).byteLength

/** Deterministic, single-line, code-point-safe excerpt. */
export function excerpt(text: string, max = TIMELINE_EXCERPT_MAX): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(collapsed)
  return chars.length <= max ? collapsed : `${chars.slice(0, max - 1).join('')}…`
}

/** Idempotent append with a hard cap. A repeated event id never duplicates a row. */
export function appendTimeline(room: RoomState, entry: TimelineEntry): RoomState {
  const timeline = room.timeline ?? []
  if (timeline.some((candidate) => candidate.id === entry.id)) return room
  return { ...room, timeline: [...timeline, entry].slice(-TIMELINE_LIMIT) }
}

const scopeRank = (entry: TimelineEntry, scope: TimelineScope): number => {
  if (scope.threadId && entry.scope.threadId === scope.threadId) return 3
  if (scope.nodeKey && entry.scope.nodeKey === scope.nodeKey) return 2
  if (scope.blockId && entry.scope.blockId === scope.blockId) return 1
  return 0
}

/** Most relevant and newest first: exact thread/node/block matches before page-wide rows. */
export function recentTimeline(
  room: RoomState,
  scope: TimelineScope,
  limit = 12,
): TimelineEntry[] {
  return [...(room.timeline ?? [])]
    .sort(
      (a, b) =>
        scopeRank(b, scope) - scopeRank(a, scope) ||
        b.at.localeCompare(a.at) ||
        b.id.localeCompare(a.id),
    )
    .slice(0, Math.max(0, limit))
}

/** Folds older entries into one line, oldest first, without a model call. */
export function summarizeTimeline(entries: TimelineEntry[], maxBytes = 2048): string {
  const parts: string[] = []
  let used = 0
  for (const entry of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    const piece = parts.length ? `; ${entry.summary}` : entry.summary
    const size = byteLength(piece)
    if (used + size > maxBytes) break
    parts.push(entry.summary)
    used += size
  }
  return parts.join('; ')
}

export function userEditEntry(input: {
  eventId: string
  at: string
  target: TargetState
  before: string | null
  added: string
  removed: string
}): TimelineEntry {
  const parts: string[] = []
  if (input.added) parts.push(`+${JSON.stringify(excerpt(input.added))}`)
  if (input.removed) parts.push(`-${JSON.stringify(excerpt(input.removed))}`)
  const detail = parts.length ? parts.join(' ') : input.before === null ? 'first sight' : 'no text change'
  return {
    id: `${input.eventId}:user_edit:${input.target.key}`,
    at: input.at,
    kind: 'user_edit',
    surface: 'body',
    scope: { blockId: input.target.blockId, nodeKey: input.target.key },
    summary: excerpt(`edited text ${detail}`, TIMELINE_SUMMARY_MAX),
    data: {
      ...(input.added ? { added: excerpt(input.added) } : {}),
      ...(input.removed ? { removed: excerpt(input.removed) } : {}),
    },
  }
}

export function userCommentEntry(input: {
  eventId: string
  at: string
  change: CommentChange
  deleted?: boolean
}): TimelineEntry {
  const { change } = input
  return {
    id: `${input.eventId}:user_comment:${change.messageId ?? change.threadId}`,
    at: input.at,
    kind: 'user_comment',
    surface: 'comment',
    scope: {
      threadId: change.threadId,
      ...(change.blockId ? { blockId: change.blockId } : {}),
    },
    ...(change.messageId ? { messageId: change.messageId } : {}),
    summary: input.deleted
      ? `comment thread ${change.threadId.slice(0, 8)} closed`
      : `commented: ${JSON.stringify(excerpt(change.body ?? '', TIMELINE_EXCERPT_MAX))}`,
  }
}

export function triageEntry(input: {
  eventId: string
  at: string
  surface: 'body' | 'comment'
  scope: TimelineScope
  triage: Triage
}): TimelineEntry {
  const scopeKey =
    input.scope.threadId ?? input.scope.nodeKey ?? input.scope.blockId ?? 'page'
  return {
    id: `${input.eventId}:triage:${scopeKey}`,
    at: input.at,
    kind: 'triage',
    surface: input.surface,
    scope: input.scope,
    ...(input.triage.intentId ? { intentId: input.triage.intentId } : {}),
    summary: excerpt(
      `triage ${input.triage.outcome} (${input.triage.source}): ${input.triage.reason}`,
      TIMELINE_SUMMARY_MAX,
    ),
    data: {
      outcome: input.triage.outcome,
      reason: input.triage.reason,
      source: input.triage.source,
    },
  }
}

export function intentVersionEntry(input: {
  at: string
  intent: Intent
  previousVersion: number
}): TimelineEntry {
  return {
    id: `${input.intent.id}:v${input.intent.version}:intent_version`,
    at: input.at,
    kind: 'intent_version',
    surface: 'room',
    scope: {
      ...(input.intent.targetScope.blockId ? { blockId: input.intent.targetScope.blockId } : {}),
      ...(input.intent.targetScope.nodeKey ? { nodeKey: input.intent.targetScope.nodeKey } : {}),
      ...(input.intent.targetScope.threadId ? { threadId: input.intent.targetScope.threadId } : {}),
    },
    intentId: input.intent.id,
    summary: excerpt(
      `intent ${input.intent.kind} v${input.previousVersion} -> v${input.intent.version}`,
      TIMELINE_SUMMARY_MAX,
    ),
    data: { intentVersion: input.intent.version },
  }
}

export function attemptEntry(input: {
  at: string
  key: string
  blockId: string
  generation: number
  intentId: string | null
  intentVersion: number | null
  kind: 'attempt_started' | 'attempt_discarded'
}): TimelineEntry {
  return {
    id: `${input.key}:${input.generation}:${input.intentVersion ?? 'none'}:${input.kind}`,
    at: input.at,
    kind: input.kind,
    surface: 'body',
    scope: { blockId: input.blockId, nodeKey: input.key },
    ...(input.intentId ? { intentId: input.intentId } : {}),
    summary:
      input.kind === 'attempt_started'
        ? `started a draft${input.intentVersion === null ? '' : ` (v${input.intentVersion})`}`
        : 'discarded a stale draft',
  }
}

export function replyEntry(input: {
  at: string
  key: string
  surface: 'body' | 'comment'
  blockId: string | null
  generation: number
  intentId: string | null
  intentVersion: number | null
  threadId: string | null
  messageId: string | null
  body: string
  edited: boolean
}): TimelineEntry {
  const kind = input.edited ? 'reply_updated' : 'reply_written'
  return {
    id: `${input.key}:${input.generation}:${input.intentVersion ?? 'none'}:${kind}`,
    at: input.at,
    kind,
    surface: input.surface,
    scope: {
      ...(input.blockId ? { blockId: input.blockId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.surface === 'body' ? { nodeKey: input.key } : {}),
    },
    ...(input.intentId ? { intentId: input.intentId } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    summary: excerpt(
      `${input.edited ? 'updated' : 'wrote'} reply: ${JSON.stringify(input.body)}`,
      TIMELINE_SUMMARY_MAX,
    ),
  }
}

export function failureEntry(input: {
  at: string
  key: string
  surface: 'body' | 'comment'
  blockId: string
  threadId: string | null
  generation: number
  failures: number
  message: string
}): TimelineEntry {
  return {
    id: `${input.key}:${input.generation}:failure:${input.failures}`,
    at: input.at,
    kind: 'failure',
    surface: input.surface,
    scope: {
      blockId: input.blockId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.surface === 'body' ? { nodeKey: input.key } : {}),
    },
    summary: excerpt(`failed: ${input.message}`, TIMELINE_SUMMARY_MAX),
    data: { reason: input.message },
  }
}
