// Publishes a short-lived "reading" agent caret on a block, via a scoped
// read_page — no dedicated presence-write endpoint exists or is needed. The
// host already derives agent presence from authorized calls it sees
// (model/agent-presence.mjs's readTargets): a read_page scoped by block_ids
// (not a whole-page or outline read, and not include_content:false) shows a
// reading marker on that passage for ~10s. This only shows up for API
// credentials (an API key or MCP OAuth) — a browser-session login publishes
// nothing, since a person's own editor already shows their caret.
import type { PagesClient } from './client.ts'

export type ShowReadingInput = { pageId: string; blockId: string }

/**
 * Best-effort: the caller should treat a rejection as safe to ignore. This
 * exists purely as a UX signal ("something is looking at this"), not a
 * correctness-bearing write, so it never carries an idempotency key and its
 * result is never consumed.
 */
export async function showReadingPresence(client: PagesClient, input: ShowReadingInput): Promise<void> {
  await client.call('read_page', {
    page_id: input.pageId,
    block_ids: [input.blockId],
    comments: 'none',
  })
}
