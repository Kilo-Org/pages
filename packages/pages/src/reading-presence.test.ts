import { describe, expect, test } from 'bun:test'
import { bearerAuth, createPagesClient } from './client.ts'
import { showReadingPresence } from './reading-presence.ts'

function fakePages(reply: { status?: number; body: unknown }) {
  const calls: { operation: string; args: Record<string, unknown> }[] = []
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { operation, arguments: args } = JSON.parse(String(init?.body))
    calls.push({ operation, args })
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }) as typeof fetch
  const client = createPagesClient({ origin: 'http://pages.test', auth: bearerAuth('t'), fetch: fakeFetch })
  return { client, calls }
}

describe('showReadingPresence', () => {
  test('reads the one block by id, scoped (not a whole-page read)', async () => {
    const { client, calls } = fakePages({ body: { blocks: [] } })
    await showReadingPresence(client, { pageId: 'p', blockId: 'b1' })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.operation).toBe('read_page')
    expect(call.args).toMatchObject({ page_id: 'p', block_ids: ['b1'], comments: 'none' })
    // A reading marker only shows when content actually comes back — see
    // model/agent-presence.mjs's readTargets, which bails on include_content:false.
    expect(call.args.include_content).toBeUndefined()
  })

  test('propagates a failure instead of swallowing it — the caller decides whether to ignore it', async () => {
    const { client } = fakePages({ status: 404, body: { code: 'not_found', error: 'no such page' } })
    await expect(showReadingPresence(client, { pageId: 'missing', blockId: 'b1' })).rejects.toThrow()
  })
})
