// Posts block-level comments via manage_page_comment. A block target needs no
// base_heads (only passage/selected-text comments do), so this never races a
// concurrently-edited page. idempotency_key is derived from the inputs, so an
// exact retry (e.g. after a crash) replays the original receipt instead of
// posting twice — see worker/mutations.mjs's documentMutation/inspectOperation
// in the Pages host.
import * as v from 'valibot'
import type { PagesClient } from './client.ts'

export type AddBlockCommentInput = {
  pageId: string
  blockId: string
  body: string
  /** Fed into the idempotency key alongside pageId/blockId — typically the text being replied to. */
  dedupeOn: string
}

export type AddBlockCommentResult = { threadId: string; messageId: string }

export type EditCommentInput = {
  pageId: string
  threadId: string
  messageId: string
  body: string
  /** Fed into the idempotency key alongside pageId/threadId/messageId — typically the text that prompted the update. */
  dedupeOn: string
}

// manage_page_comment's response wraps the write result under `result`, with
// `heads`/`comment_heads` alongside it at the top level (confirmed live, not
// just from the tool schema text — see the worktree's test run notes).
const CommentReceipt = v.object({ result: v.object({ thread_id: v.string(), message_id: v.string() }) })

async function idempotencyKey(parts: string[]): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\u0000')))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function addBlockComment(client: PagesClient, input: AddBlockCommentInput): Promise<AddBlockCommentResult> {
  const idempotency_key = await idempotencyKey([input.pageId, input.blockId, input.dedupeOn])
  const raw = await client.call('manage_page_comment', {
    page_id: input.pageId,
    idempotency_key,
    action: 'add',
    block_id: input.blockId,
    body: input.body,
  })
  const receipt = v.parse(CommentReceipt, raw)
  return { threadId: receipt.result.thread_id, messageId: receipt.result.message_id }
}

/**
 * Edits an existing comment message in place. Only the message's own author may do this —
 * confirmed against model/comments.mjs's `requireCommentDecision` check, not just the tool
 * schema text. No base_heads needed, same as `add` for a block target.
 */
export async function editComment(client: PagesClient, input: EditCommentInput): Promise<AddBlockCommentResult> {
  const idempotency_key = await idempotencyKey([input.pageId, input.threadId, input.messageId, input.dedupeOn])
  const raw = await client.call('manage_page_comment', {
    page_id: input.pageId,
    idempotency_key,
    action: 'edit',
    thread_id: input.threadId,
    message_id: input.messageId,
    body: input.body,
  })
  const receipt = v.parse(CommentReceipt, raw)
  return { threadId: receipt.result.thread_id, messageId: receipt.result.message_id }
}
