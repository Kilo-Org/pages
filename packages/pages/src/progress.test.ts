import { describe, expect, test } from 'bun:test'
import { bearerAuth, createPagesClient } from './client.ts'
import { clearProgress, reportProgress } from './progress.ts'

type Reply = { status?: number; body: unknown }

function fakePages(...replies: Reply[]) {
  const calls: { operation: string; args: Record<string, unknown> }[] = []
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { operation, arguments: args } = JSON.parse(String(init?.body))
    calls.push({ operation, args })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }) as typeof fetch
  const client = createPagesClient({ origin: 'http://pages.test', auth: bearerAuth('t'), fetch: fakeFetch })
  return { client, calls }
}

describe('reportProgress', () => {
  test('anchors to a passage using the heads from a scoped read', async () => {
    const { client, calls } = fakePages(
      { body: { heads: ['a'.repeat(64)] } },
      { body: { progress_id: 'pid', lease_token: 'lease' } },
    )
    const handle = await reportProgress(client, {
      pageId: 'p',
      message: 'Thinking about this paragraph',
      blockId: 'b1',
      matchText: 'The budget splits three ways.',
    })

    expect(calls.map((call) => call.operation)).toEqual(['read_page', 'report_page_progress'])
    expect(calls[0]!.args).toMatchObject({ page_id: 'p', block_ids: ['b1'], comments: 'none' })
    expect(calls[1]!.args).toMatchObject({
      page_id: 'p',
      message: 'Thinking about this paragraph',
      targets: [{ block_id: 'b1', match_text: 'The budget splits three ways.' }],
      expected_heads: ['a'.repeat(64)],
    })
    expect(handle).toEqual({ progressId: 'pid', leaseToken: 'lease' })
  })

  test('falls back to a message-only indicator when the passage cannot be anchored', async () => {
    const { client, calls } = fakePages(
      { body: { heads: ['a'.repeat(64)] } },
      { status: 400, body: { code: 'invalid_presence_target', error: 'ambiguous' } },
      { body: { progress_id: 'pid', lease_token: 'lease' } },
    )
    const handle = await reportProgress(client, {
      pageId: 'p',
      message: 'Thinking',
      blockId: 'b1',
      matchText: 'duplicate text',
    })

    expect(calls.map((call) => call.operation)).toEqual([
      'read_page',
      'report_page_progress',
      'report_page_progress',
    ])
    expect(calls[2]!.args).not.toHaveProperty('targets')
    expect(calls[2]!.args).not.toHaveProperty('expected_heads')
    expect(handle.progressId).toBe('pid')
  })

  test('renews an existing lease without another read', async () => {
    const { client, calls } = fakePages({ body: { progress_id: 'pid' } })
    const handle = await reportProgress(client, {
      pageId: 'p',
      message: 'Still working',
      progressId: 'pid',
      leaseToken: 'lease',
    })

    expect(calls.map((call) => call.operation)).toEqual(['report_page_progress'])
    expect(calls[0]!.args).toMatchObject({ progress_id: 'pid', lease_token: 'lease', message: 'Still working' })
    expect(handle).toEqual({ progressId: 'pid', leaseToken: null })
  })

  test('a message-only report needs no read or lease', async () => {
    const { client, calls } = fakePages({ body: { progress_id: 'pid', lease_token: 'lease' } })
    await reportProgress(client, { pageId: 'p', message: 'Working' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual({ page_id: 'p', message: 'Working' })
  })
})

test('the client sends the agent driver header', async () => {
  const headers: Record<string, string>[] = []
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    headers.push(init?.headers as Record<string, string>)
    return new Response(JSON.stringify({ progress_id: 'pid', lease_token: 'lease' }))
  }) as typeof fetch
  const client = createPagesClient({
    origin: 'http://pages.test',
    auth: bearerAuth('t'),
    fetch: fakeFetch,
    driver: 'Kilo',
  })
  await reportProgress(client, { pageId: 'p', message: 'Working' })
  expect(headers[0]?.['x-pages-driver']).toBe('Kilo')
})

describe('clearProgress', () => {
  test('sends the clear flag with the lease identity', async () => {
    const { client, calls } = fakePages({ body: { progress_id: 'pid', cleared: true } })
    await clearProgress(client, { pageId: 'p', progressId: 'pid', leaseToken: 'lease' })
    expect(calls[0]!.operation).toBe('report_page_progress')
    expect(calls[0]!.args).toEqual({
      page_id: 'p',
      progress_id: 'pid',
      lease_token: 'lease',
      clear: true,
    })
  })
})