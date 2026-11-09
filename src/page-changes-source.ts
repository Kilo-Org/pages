// Turns read_page_changes polling into page.changed events.
//
// Pages has no event feed yet, and read_page_changes is a net diff, not a log:
// a burst of keystrokes between two polls arrives as one event. The shape of
// the event is what a real feed would deliver, so programs don't care.
import * as v from 'valibot'
import { PagesError, type PagesClient } from './pages-client.ts'
import type { NodeChange, PageChangedEvent } from './program.ts'

export type PageCursor = { heads: string[]; title: string | null }

const Heads = v.pipe(v.array(v.string()), v.minLength(1))

const ReadPage = v.object({ title: v.string(), heads: Heads })

const Change = v.object({
  block_id: v.string(),
  scope: v.string(),
  change: v.string(),
  node_index: v.optional(v.number()),
  node_id: v.optional(v.nullable(v.string())),
  type: v.optional(v.string()),
  markdown: v.optional(v.string()),
})

const ReadChanges = v.object({
  heads: Heads,
  title_changed: v.boolean(),
  changes: v.array(Change),
})

const RESYNC_CODES = new Set(['resync_required', 'invalid_change_selector', 'changes_budget_exceeded'])

export async function openCursor(client: PagesClient, pageId: string): Promise<PageCursor> {
  const page = v.parse(
    ReadPage,
    await client.call('read_page', { page_id: pageId, include_content: false, comments: 'none' }),
  )
  return { heads: page.heads, title: page.title }
}

export type PollResult = { cursor: PageCursor; event: PageChangedEvent | null; resynced: boolean }

export async function pollPage(
  client: PagesClient,
  pageId: string,
  cursor: PageCursor,
  now: () => Date = () => new Date(),
): Promise<PollResult> {
  let raw: unknown
  try {
    raw = await client.call('read_page_changes', {
      page_id: pageId,
      since_heads: cursor.heads,
      comments: 'none',
    })
  } catch (error) {
    if (error instanceof PagesError && RESYNC_CODES.has(error.code)) {
      return { cursor: await openCursor(client, pageId), event: null, resynced: true }
    }
    throw error
  }

  const result = v.parse(ReadChanges, raw)
  if (sameHeads(result.heads, cursor.heads)) return { cursor, event: null, resynced: false }

  const changes: NodeChange[] = result.changes.map((change) => ({
    scope: change.scope === 'node' ? ('node' as const) : ('block' as const),
    blockId: change.block_id,
    change: change.change,
    nodeIndex: change.node_index ?? null,
    nodeId: change.node_id ?? null,
    type: change.type ?? null,
    markdown: change.markdown ?? null,
  }))

  const title = result.title_changed ? (await openCursor(client, pageId)).title : cursor.title
  const event: PageChangedEvent = {
    id: `${pageId}@${result.heads.join('+')}`,
    type: 'page.changed',
    at: now().toISOString(),
    pageId,
    title,
    titleChanged: result.title_changed,
    fromHeads: cursor.heads,
    toHeads: result.heads,
    changes,
  }
  return { cursor: { heads: result.heads, title }, event, resynced: false }
}

function sameHeads(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join()
}
