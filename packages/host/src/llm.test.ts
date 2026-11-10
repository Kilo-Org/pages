import { describe, expect, test } from 'bun:test'
import { createKiloLlm } from './llm.ts'

function fakeFetch(reply: { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }) as typeof fetch
  return { fn, calls }
}

describe('createKiloLlm', () => {
  test('posts an OpenAI-shaped chat completion with the bearer key, returns the content', async () => {
    const { fn, calls } = fakeFetch({ body: { choices: [{ message: { content: '{"respond":true}' } }] } })
    const llm = createKiloLlm({ apiKey: 'k', model: 'anthropic/claude-sonnet-4.5', fetch: fn })
    const result = await llm.complete({ system: 'sys', prompt: 'hello' })
    expect(result).toBe('{"respond":true}')
    expect(calls[0]!.url).toBe('https://ai-gateway.kilo.ai/api/v1/chat/completions')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer k')
    const body = JSON.parse(String(calls[0]!.init?.body))
    expect(body.model).toBe('anthropic/claude-sonnet-4.5')
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ])
  })

  test('surfaces the gateway error message on a non-2xx response', async () => {
    const { fn } = fakeFetch({ status: 402, body: { error: { message: 'insufficient balance' } } })
    const llm = createKiloLlm({ apiKey: 'k', model: 'm', fetch: fn })
    await expect(llm.complete({ system: 's', prompt: 'p' })).rejects.toThrow('insufficient balance')
  })

  test('sends the org header only when an orgId is given', async () => {
    const { fn, calls } = fakeFetch({ body: { choices: [{ message: { content: 'ok' } }] } })
    const llm = createKiloLlm({ apiKey: 'k', model: 'm', orgId: 'org-123', fetch: fn })
    await llm.complete({ system: 's', prompt: 'p' })
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['x-kilocode-organizationid']).toBe('org-123')

    const { fn: fnNoOrg, calls: callsNoOrg } = fakeFetch({ body: { choices: [{ message: { content: 'ok' } }] } })
    const llmNoOrg = createKiloLlm({ apiKey: 'k', model: 'm', fetch: fnNoOrg })
    await llmNoOrg.complete({ system: 's', prompt: 'p' })
    const headersNoOrg = callsNoOrg[0]!.init?.headers as Record<string, string>
    expect(headersNoOrg['x-kilocode-organizationid']).toBeUndefined()
  })

  test('rejects an empty completion', async () => {
    const { fn } = fakeFetch({ body: { choices: [{ message: { content: null } }] } })
    const llm = createKiloLlm({ apiKey: 'k', model: 'm', fetch: fn })
    await expect(llm.complete({ system: 's', prompt: 'p' })).rejects.toThrow('empty completion')
  })

  test('passes the signal through, so aborting it really cancels the request', async () => {
    const controller = new AbortController()
    const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as typeof fetch
    const llm = createKiloLlm({ apiKey: 'k', model: 'm', fetch: fn })
    const promise = llm.complete({ system: 's', prompt: 'p', signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})
