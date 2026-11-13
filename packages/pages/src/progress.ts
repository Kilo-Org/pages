// Publishes a short-lived "working on this" indicator via
// report_page_progress. Unlike the reading caret (reading-presence.ts), this
// works for every credential kind, including a local browser-session login, so
// it is the indicator a developer actually sees in local Pages.
//
// Progress is a UX signal, never correctness-bearing state: no idempotency
// key, no persistence, and callers treat any rejection as safe to ignore.
import * as v from 'valibot'
import type { PagesClient } from './client.ts'

export type ReportProgressInput = {
  pageId: string
  /** Plain text, 1-240 characters; never markdown. */
  message: string
  /** When both are given, the indicator anchors to that passage. */
  blockId?: string
  matchText?: string
  /** Renew an existing lease instead of starting a new one. */
  progressId?: string
  leaseToken?: string
}

export type ProgressHandle = { progressId: string; leaseToken: string | null }

const ProgressReceipt = v.object({
  progress_id: v.string(),
  lease_token: v.optional(v.string()),
})

const ReadReceipt = v.object({ heads: v.array(v.string()) })

/** A message-only report needs no read and therefore no expected heads. */
function reportArgs(input: ReportProgressInput): Record<string, unknown> {
  const args: Record<string, unknown> = {
    page_id: input.pageId,
    message: input.message,
  }
  if (input.progressId && input.leaseToken) {
    args.progress_id = input.progressId
    args.lease_token = input.leaseToken
  }
  return args
}

/**
 * Starts or renews a progress lease. An anchored report needs the heads of a
 * scoped read and a uniquely matching passage; if either is unavailable the
 * report falls back to a message-only indicator rather than failing.
 */
export async function reportProgress(
  client: PagesClient,
  input: ReportProgressInput,
): Promise<ProgressHandle> {
  const base = reportArgs(input)
  if (input.blockId && input.matchText && !input.progressId) {
    try {
      const read = await client.call('read_page', {
        page_id: input.pageId,
        block_ids: [input.blockId],
        comments: 'none',
      })
      const { heads } = v.parse(ReadReceipt, read)
      const anchored = await client.call('report_page_progress', {
        ...base,
        targets: [{ block_id: input.blockId, match_text: input.matchText }],
        expected_heads: heads,
      })
      return parseHandle(anchored)
    } catch {
      // A moved revision, a duplicated passage, or an older worker: fall through
      // to the message-only indicator instead of staying invisible.
    }
  }
  return parseHandle(await client.call('report_page_progress', base))
}

function parseHandle(raw: unknown): ProgressHandle {
  const receipt = v.parse(ProgressReceipt, raw)
  return { progressId: receipt.progress_id, leaseToken: receipt.lease_token ?? null }
}

/** Clears a lease. Best-effort: an expired lease is already gone. */
export async function clearProgress(
  client: PagesClient,
  input: { pageId: string; progressId: string; leaseToken: string },
): Promise<void> {
  await client.call('report_page_progress', {
    page_id: input.pageId,
    progress_id: input.progressId,
    lease_token: input.leaseToken,
    clear: true,
  })
}