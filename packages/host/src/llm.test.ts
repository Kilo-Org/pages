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

  test('rejects an empty completion', async () => {
    const { fn } = fakeFetch({ body: { choices: [{ message: { content: null } }] } })
    const llm = createKiloLlm({ apiKey: 'k', model: 'm', fetch: fn })
    await expect(llm.complete({ system: 's', prompt: 'p' })).rejects.toThrow('empty completion')
  })
})
