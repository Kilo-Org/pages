// Turns Pages polling into one `page.changed` event stream.
//
// Pages has no event feed yet: read_page_changes is a net diff and presence is
// an ephemeral snapshot. The event shape is what a real feed would deliver, so
// programs don't care where it came from.
import * as v from 'valibot'
import { PagesError, type PagesClient } from './client.ts'
import { actorKindFor, userPriority } from './actors.ts'
import {
  emptySelectionCursor,
  pollSelections,
  type SelectionCursor,
} from './presence-source.ts'
import type {
  BodyChange,
  CommentChange,
  PageChange,
  PageChangedEvent,
  SelectionChange,
} from '@pages-programs/sdk'

export type PageCursor = {
  heads: string[]
  /** null for a cursor saved before comment deltas existed. */
  commentHeads: string[] | null
  title: string | null
  selection: SelectionCursor
}

export type PollOptions = {
  now?: () => Date
  /** The host's own principal. Without it, comments and presence are skipped. */
  ownPrincipal?: string | null
  log?: (message: string) => void
}

const Heads = v.pipe(v.array(v.string()), v.minLength(1))

const ReadPage = v.object({
  title: v.string(),
  heads: Heads,
  comment_heads: v.optional(v.array(v.string())),
})

const Change = v.object({
  block_id: v.string(),
  scope: v.string(),
  change: v.string(),
  node_index: v.optional(v.number()),
  node_id: v.optional(v.nullable(v.string())),
  type: v.optional(v.string()),
  markdown: v.optional(v.string()),
})

const Author = v.object({
  principal: v.string(),
  displayName: v.optional(v.nullable(v.string())),
  driver: v.optional(v.nullable(v.string())),
})

const Message = v.object({
  id: v.string(),
  body: v.optional(v.nullable(v.string())),
  author: v.optional(v.nullable(Author)),
  deletedAt: v.optional(v.nullable(v.string())),
})

const CommentThread = v.object({
  thread_id: v.string(),
  change: v.string(),
  id: v.optional(v.string()),
  block_id: v.optional(v.nullable(v.string())),
  messages: v.optional(v.array(Message)),
})

const ReadChanges = v.object({
  heads: Heads,
  comment_heads: v.optional(v.array(v.string())),
  title_changed: v.boolean(),
  changes: v.array(Change),
  comments: v.optional(v.array(CommentThread)),
  comments_snapshot: v.optional(v.boolean()),
})

const RESYNC_CODES = new Set(['resync_required', 'invalid_change_selector', 'changes_budget_exceeded'])

function normalizeCursor(cursor: PageCursor): PageCursor {
  return {
    heads: cursor.heads,
    commentHeads: cursor.commentHeads ?? null,
    title: cursor.title ?? null,
    selection: cursor.selection ?? emptySelectionCursor(),
  }
}

export async function openCursor(client: PagesClient, pageId: string): Promise<PageCursor> {
  const page = v.parse(
    ReadPage,
    await client.call('read_page', { page_id: pageId, include_content: false, comments: 'none' }),
  )
  return {
    heads: page.heads,
    commentHeads: page.comment_heads ?? null,
    title: page.title,
    selection: emptySelectionCursor(),
  }
}

export type PollResult = { cursor: PageCursor; event: PageChangedEvent | null; resynced: boolean }

const sorted = (heads: string[]) => [...heads].sort()

function bodyChange(change: v.InferOutput<typeof Change>): BodyChange {
  return {
    surface: 'body',
    scope: change.scope === 'node' ? 'node' : 'block',
    blockId: change.block_id,
    change: change.change,
    nodeIndex: change.node_index ?? null,
    nodeId: change.node_id ?? null,
    type: change.type ?? null,
    markdown: change.markdown ?? null,
    actorKind: 'unknown',
    priority: 2,
  }
}

function commentChanges(
  threads: v.InferOutput<typeof CommentThread>[],
  ownPrincipal: string | null,
): CommentChange[] {
  const changes: CommentChange[] = []
  for (const thread of threads) {
    if (thread.change === 'snapshot') continue
    if (thread.change === 'deleted') {
      changes.push({
        surface: 'comment',
        change: 'deleted',
        threadId: thread.thread_id,
        messageId: null,
        blockId: null,
        body: null,
        authorPrincipal: null,
        authorDisplayName: null,
        driver: null,
        actorKind: 'unknown',
        priority: 2,
      })
      continue
    }
    for (const message of thread.messages ?? []) {
      const principal = message.author?.principal ?? null
      if (ownPrincipal && principal === ownPrincipal) continue
      const driver = message.author?.driver ?? null
      const actorKind = actorKindFor(principal, driver, ownPrincipal)
      changes.push({
        surface: 'comment',
        change: thread.change,
        threadId: thread.thread_id,
        messageId: message.id,
        blockId: thread.block_id ?? null,
        body: message.body ?? null,
        authorPrincipal: principal,
        authorDisplayName: message.author?.displayName ?? null,
        driver,
        actorKind,
        priority: userPriority(actorKind),
      })
    }
  }
  return changes
}

export async function pollPage(
  client: PagesClient,
  pageId: string,
  cursor: PageCursor,
  options: PollOptions = {},
): Promise<PollResult> {
  const current = normalizeCursor(cursor)
  const now = options.now ?? (() => new Date())
  const ownPrincipal = options.ownPrincipal ?? null
  const watchingComments = ownPrincipal !== null

  let raw: unknown
  try {
    raw = await client.call('read_page_changes', {
      page_id: pageId,
      since_heads: current.heads,
      ...(watchingComments && current.commentHeads
        ? { since_comment_heads: current.commentHeads }
        : {}),
      comments: watchingComments ? 'all' : 'none',
    })
  } catch (error) {
    if (error instanceof PagesError && RESYNC_CODES.has(error.code)) {
      const fresh = await openCursor(client, pageId)
      return { cursor: { ...fresh, selection: current.selection }, event: null, resynced: true }
    }
    throw error
  }

  const result = v.parse(ReadChanges, raw)
  const pageHeadsChanged = !sameHeads(result.heads, current.heads)
  const nextCommentHeads = result.comment_heads ?? current.commentHeads
  // Without a baseline (first poll after upgrading a saved cursor), treat this
  // read as the baseline instead of replaying every existing comment.
  const commentBaselineKnown = current.commentHeads !== null
  const commentDelta =
    watchingComments && commentBaselineKnown && !result.comments_snapshot
      ? commentChanges(result.comments ?? [], ownPrincipal)
      : []
  const commentHeadsChanged =
    watchingComments &&
    commentBaselineKnown &&
    nextCommentHeads !== null &&
    !sameHeads(nextCommentHeads, current.commentHeads ?? [])

  let selection = current.selection
  let selectionDelta: SelectionChange[] = []
  if (watchingComments) {
    try {
      const presence = await pollSelections(client, pageId, current.selection, ownPrincipal, now)
      selection = presence.cursor
      selectionDelta = presence.changes
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.log?.(`presence read failed: ${message}`)
    }
  }

  const changes: PageChange[] = [
    ...result.changes.map(bodyChange),
    ...commentDelta,
    ...selectionDelta,
  ]
  const hasProgress = pageHeadsChanged || commentHeadsChanged || selectionDelta.length > 0
  if (!hasProgress) {
    return {
      cursor: {
        heads: result.heads,
        commentHeads: nextCommentHeads,
        title: current.title,
        selection,
      },
      event: null,
      resynced: false,
    }
  }

  const title = result.title_changed ? (await openCursor(client, pageId)).title : current.title
  const event: PageChangedEvent = {
    id: `${pageId}@${sorted(result.heads).join('+')}+c:${sorted(nextCommentHeads ?? []).join('+')}+s:${selection.epoch}`,
    type: 'page.changed',
    at: now().toISOString(),
    pageId,
    title,
    titleChanged: result.title_changed,
    fromHeads: current.heads,
    toHeads: result.heads,
    fromCommentHeads: current.commentHeads,
    toCommentHeads: nextCommentHeads,
    selectionEpoch: selection.epoch,
    changes,
  }
  return {
    cursor: { heads: result.heads, commentHeads: nextCommentHeads, title, selection },
    event,
    resynced: false,
  }
}

function sameHeads(a: string[], b: string[]): boolean {
  const left = sorted(a)
  const right = sorted(b)
  return left.length === right.length && left.every((head, i) => head === right[i])
}
