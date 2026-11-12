// Typed, scoped reads over the Pages read tools. The host uses these to give a
// program real page context without exposing the raw JSON tool surface.
import * as v from 'valibot'
import type {
  CommentReadInput,
  PageBlock,
  PageOutlineEntry,
  PageRead,
  PageReadInput,
  PresenceParticipant,
  PresenceSelection,
  ThreadAuthor,
  ThreadMessage,
  ThreadRead,
} from '@pages-programs/sdk'
import type { PagesClient } from './client.ts'

const Block = v.object({
  id: v.string(),
  markdown: v.string(),
  partial: v.optional(v.boolean()),
  node_range: v.optional(
    v.object({ block_id: v.string(), from: v.number(), to: v.number() }),
  ),
})

const OutlineEntry = v.object({
  block_id: v.string(),
  node_index: v.number(),
  node_id: v.optional(v.nullable(v.string())),
  type: v.string(),
  heading_path: v.optional(v.array(v.string())),
  heading: v.optional(v.string()),
  level: v.optional(v.number()),
  markdown_bytes: v.optional(v.number()),
})

const Selection = v.object({
  block_id: v.string(),
  status: v.string(),
  kind: v.optional(v.nullable(v.string())),
  start_utf16: v.optional(v.nullable(v.number())),
  end_utf16: v.optional(v.nullable(v.number())),
  quote: v.optional(v.nullable(v.string())),
})

const Participant = v.object({
  peer_id: v.string(),
  principal: v.string(),
  displayName: v.optional(v.nullable(v.string())),
  driver: v.optional(v.nullable(v.string())),
  last_seen: v.optional(v.nullable(v.string())),
  selection: v.optional(v.nullable(Selection)),
})

const OutlinePage = v.object({
  entries: v.array(OutlineEntry),
  total: v.optional(v.number()),
  offset: v.optional(v.number()),
  next_offset: v.optional(v.nullable(v.number())),
})

const PageReadResponse = v.object({
  title: v.string(),
  heads: v.array(v.string()),
  comment_heads: v.optional(v.nullable(v.array(v.string()))),
  blocks: v.optional(v.array(Block)),
  outline: v.optional(v.union([v.array(OutlineEntry), OutlinePage])),
  presence: v.optional(
    v.object({ participants: v.optional(v.array(Participant)) }),
  ),
})

const Author = v.object({
  principal: v.optional(v.nullable(v.string())),
  displayName: v.optional(v.nullable(v.string())),
  driver: v.optional(v.nullable(v.string())),
  agent: v.optional(
    v.nullable(
      v.object({
        name: v.optional(v.nullable(v.string())),
        model: v.optional(v.nullable(v.string())),
      }),
    ),
  ),
})

const Message = v.object({
  id: v.string(),
  body: v.optional(v.nullable(v.string())),
  author: v.optional(v.nullable(Author)),
  createdAt: v.optional(v.nullable(v.string())),
  deletedAt: v.optional(v.nullable(v.string())),
})

const SelectionContext = v.object({
  status: v.string(),
  text: v.optional(v.string()),
})

const CommentThread = v.object({
  id: v.string(),
  state: v.optional(v.nullable(v.string())),
  block_id: v.optional(v.nullable(v.string())),
  selectionContext: v.optional(v.nullable(SelectionContext)),
  message_count: v.optional(v.number()),
  messages: v.optional(v.array(Message)),
})

const CommentsResponse = v.object({
  comments: v.optional(v.array(CommentThread)),
})

const kindOf = (selection: { kind?: string | null } | null | undefined) =>
  selection?.kind === 'caret' || selection?.kind === 'selection'
    ? selection.kind
    : null

const mapSelection = (
  selection: v.InferOutput<typeof Selection> | null | undefined,
): PresenceSelection | null =>
  selection
    ? {
        blockId: selection.block_id,
        status: selection.status,
        kind: kindOf(selection),
        startUtf16: selection.start_utf16 ?? null,
        endUtf16: selection.end_utf16 ?? null,
        quote: selection.quote ?? null,
      }
    : null

const mapParticipant = (
  participant: v.InferOutput<typeof Participant>,
): PresenceParticipant => ({
  peerId: participant.peer_id,
  principal: participant.principal,
  displayName: participant.displayName ?? null,
  driver: participant.driver ?? null,
  lastSeen: participant.last_seen ?? null,
  selection: mapSelection(participant.selection),
})

const mapBlock = (block: v.InferOutput<typeof Block>): PageBlock => ({
  id: block.id,
  markdown: block.markdown,
  ...(block.partial !== undefined ? { partial: block.partial } : {}),
  ...(block.node_range
    ? {
        nodeRange: {
          blockId: block.node_range.block_id,
          from: block.node_range.from,
          to: block.node_range.to,
        },
      }
    : {}),
})

const mapOutline = (
  entry: v.InferOutput<typeof OutlineEntry>,
): PageOutlineEntry => ({
  blockId: entry.block_id,
  nodeIndex: entry.node_index,
  nodeId: entry.node_id ?? null,
  type: entry.type,
  headingPath: entry.heading_path ?? [],
  ...(entry.heading !== undefined ? { heading: entry.heading } : {}),
  ...(entry.level !== undefined ? { level: entry.level } : {}),
  markdownBytes: entry.markdown_bytes ?? 0,
})

const mapAuthor = (
  author: v.InferOutput<typeof Author> | null | undefined,
): ThreadAuthor | null =>
  author
    ? {
        principal: author.principal ?? null,
        displayName: author.displayName ?? null,
        driver: author.driver ?? null,
        agent: author.agent
          ? { name: author.agent.name ?? null, model: author.agent.model ?? null }
          : null,
      }
    : null

const mapMessage = (
  message: v.InferOutput<typeof Message>,
  ownPrincipal: string | null,
): ThreadMessage => {
  const author = mapAuthor(message.author)
  return {
    id: message.id,
    body: message.body ?? null,
    author,
    createdAt: message.createdAt ?? null,
    deletedAt: message.deletedAt ?? null,
    isSelf: Boolean(ownPrincipal && author?.principal === ownPrincipal),
  }
}

/**
 * Reads the outline and, optionally, the selected blocks plus current presence.
 * `includeContent: false` is the cheap outline-only form used for page-wide or
 * ambiguous work and as the fallback after a budget failure.
 */
export async function readPage(
  client: PagesClient,
  pageId: string,
  input: PageReadInput = {},
): Promise<PageRead> {
  const args: Record<string, unknown> = {
    page_id: pageId,
    include_content: input.includeContent ?? true,
    comments: 'none',
  }
  if (input.blockIds?.length) args.block_ids = input.blockIds
  if (input.includePresence) args.include_presence = true
  if (input.maxBytes !== undefined) args.max_bytes = input.maxBytes
  const body = v.parse(PageReadResponse, await client.call('read_page', args))
  const outline = Array.isArray(body.outline)
    ? body.outline
    : body.outline?.entries ?? []
  return {
    title: body.title,
    heads: body.heads,
    commentHeads: body.comment_heads ?? null,
    blocks: (body.blocks ?? []).map(mapBlock),
    outline: outline.map(mapOutline),
    presence: (body.presence?.participants ?? []).map(mapParticipant),
  }
}

/**
 * Reads threads scoped to one block or an explicit set of thread ids. Messages
 * authored by `ownPrincipal` are marked `isSelf`; the event spine still filters
 * them, so this is only ever context, never a new trigger.
 */
export async function readComments(
  client: PagesClient,
  pageId: string,
  input: CommentReadInput = {},
  options: { ownPrincipal?: string | null } = {},
): Promise<ThreadRead[]> {
  const ownPrincipal = options.ownPrincipal ?? null
  const args: Record<string, unknown> = {
    page_id: pageId,
    state: input.state ?? 'open',
    include_messages: input.includeMessages ?? true,
  }
  if (input.threadIds?.length) args.thread_ids = input.threadIds
  else if (input.blockId) args.block_id = input.blockId
  if (input.maxBytes !== undefined) args.max_bytes = input.maxBytes
  const body = v.parse(CommentsResponse, await client.call('list_page_comments', args))
  return (body.comments ?? []).map((thread) => {
    const messages = (thread.messages ?? []).map((message) =>
      mapMessage(message, ownPrincipal),
    )
    return {
      id: thread.id,
      state: thread.state ?? null,
      blockId: thread.block_id ?? null,
      selection:
        thread.selectionContext?.status === 'attached' &&
        typeof thread.selectionContext.text === 'string'
          ? { text: thread.selectionContext.text }
          : null,
      messageCount: thread.message_count ?? messages.length,
      messages,
    }
  })
}
