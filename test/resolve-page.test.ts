import { describe, expect, test } from 'bun:test'
import { bearerAuth, createPagesClient } from '../src/pages-client.ts'
import { resolvePage } from '../src/host/resolve-page.ts'

function clientReplying(body: unknown) {
  const calls: unknown[] = []
  const client = createPagesClient({
    origin: 'http://pages.test',
    auth: bearerAuth('t'),
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(body))
    }) as typeof fetch,
  })
  return { client, calls }
}

describe('resolvePage', () => {
  test('an explicit id is used without asking the server', async () => {
    const { client, calls } = clientReplying({})
    expect(await resolvePage(client, 'abc')).toEqual({ pageId: 'abc', title: null, discovered: false })
    expect(calls).toEqual([])
  })

  test('otherwise the most recently edited page is discovered', async () => {
    const { client, calls } = clientReplying({ pages: [{ page_id: 'p1', title: 'Notes' }] })
    expect(await resolvePage(client, undefined)).toEqual({ pageId: 'p1', title: 'Notes', discovered: true })
    expect(calls).toEqual([{ operation: 'list_pages', arguments: { limit: 1, sort: 'activity' } }])
  })

  test('an account with no pages gets an actionable error', async () => {
    const { client } = clientReplying({ pages: [] })
    expect(resolvePage(client, undefined)).rejects.toThrow('no pages yet')
  })
})
