import { describe, expect, test } from 'bun:test'
import { bearerAuth, createPagesClient } from './client.ts'
import { addBlockComment, editComment } from './comments.ts'

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

describe('addBlockComment', () => {
  test('posts a block comment with a deterministic idempotency key, no base_heads', async () => {
    const { client, calls } = fakePages({ body: { result: { thread_id: 'th1', message_id: 'm1' } } })
    const result = await addBlockComment(client, { pageId: 'p', blockId: 'b1', body: 'hello', dedupeOn: 'Does it work?' })
    expect(result).toEqual({ threadId: 'th1', messageId: 'm1' })
    const call = calls[0]!
    expect(call.operation).toBe('manage_page_comment')
    expect(call.args).toMatchObject({ page_id: 'p', action: 'add', block_id: 'b1', body: 'hello' })
    expect(call.args.base_heads).toBeUndefined()
    expect(typeof call.args.idempotency_key).toBe('string')
    expect((call.args.idempotency_key as string).length).toBeGreaterThanOrEqual(8)
  })

  test('the idempotency key is a pure function of page, block and dedupeOn', async () => {
    const { client, calls: calls1 } = fakePages({ body: { result: { thread_id: 'th1', message_id: 'm1' } } })
    await addBlockComment(client, { pageId: 'p', blockId: 'b1', body: 'hello', dedupeOn: 'same text' })
    const { client: client2, calls: calls2 } = fakePages({ body: { result: { thread_id: 'th1', message_id: 'm1' } } })
    await addBlockComment(client2, { pageId: 'p', blockId: 'b1', body: 'a different reply', dedupeOn: 'same text' })
    expect(calls1[0]!.args.idempotency_key).toBe(calls2[0]!.args.idempotency_key)

    const { client: client3, calls: calls3 } = fakePages({ body: { result: { thread_id: 'th1', message_id: 'm1' } } })
    await addBlockComment(client3, { pageId: 'p', blockId: 'b1', body: 'hello', dedupeOn: 'different text' })
    expect(calls3[0]!.args.idempotency_key).not.toBe(calls1[0]!.args.idempotency_key)
  })
})

describe('editComment', () => {
  test('edits an existing message with thread_id + message_id, no base_heads', async () => {
    const { client, calls } = fakePages({ body: { result: { thread_id: 'th1', message_id: 'm1' } } })
    const result = await editComment(client, {
      pageId: 'p',
      threadId: 'th1',
      messageId: 'm1',
      body: 'updated answer',
      dedupeOn: 'refined question',
    })
    expect(result).toEqual({ threadId: 'th1', messageId: 'm1' })
    const call = calls[0]!
    expect(call.operation).toBe('manage_page_comment')
    expect(call.args).toMatchObject({
      page_id: 'p',
      action: 'edit',
      thread_id: 'th1',
      message_id: 'm1',
      body: 'updated answer',
    })
    expect(call.args.base_heads).toBeUndefined()
  })

  test("the idempotency key differs from addBlockComment's, even with the same dedupeOn", async () => {
    const { client: addClient, calls: addCalls } = fakePages({ body: { result: { thread_id: 'th1', message_id: 'm1' } } })
    await addBlockComment(addClient, { pageId: 'p', blockId: 'b1', body: 'x', dedupeOn: 'same text' })
    const { client: editClient, calls: editCalls } = fakePages({ body: { result: { thread_id: 'th1', message_id: 'm1' } } })
    await editComment(editClient, { pageId: 'p', threadId: 'th1', messageId: 'm1', body: 'y', dedupeOn: 'same text' })
    expect(editCalls[0]!.args.idempotency_key).not.toBe(addCalls[0]!.args.idempotency_key)
  })
})
