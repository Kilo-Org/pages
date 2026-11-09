import * as v from 'valibot'
import type { PagesClient } from '../pages-client.ts'

const ListPages = v.object({
  pages: v.array(v.object({ page_id: v.string(), title: v.string() })),
})

export type ResolvedPage = { pageId: string; title: string | null; discovered: boolean }

/** An explicit page id wins; otherwise watch the account's most recently edited page. */
export async function resolvePage(client: PagesClient, explicit: string | undefined): Promise<ResolvedPage> {
  if (explicit) return { pageId: explicit, title: null, discovered: false }
  const { pages } = v.parse(ListPages, await client.call('list_pages', { limit: 1, sort: 'activity' }))
  const page = pages[0]
  if (!page) {
    throw new Error('This account has no pages yet. Create one in Pages, or pass --page <id> / set PAGES_PAGE_ID.')
  }
  return { pageId: page.page_id, title: page.title, discovered: true }
}
