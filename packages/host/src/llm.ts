// Thin client for Kilo's AI Gateway (https://kilo.ai/docs/gateway): an
// OpenAI-compatible chat-completions endpoint. Lives in the host, not a
// program, since programs may only reach the outside world through ctx.
import * as v from 'valibot'
import type { LlmCapability, LlmTool, LlmToolCall } from '@pages-programs/sdk'

const GATEWAY_URL = 'https://ai-gateway.kilo.ai/api/v1/chat/completions'

export type KiloLlmOptions = {
  apiKey: string
  model: string
  /** Scopes the request to a specific org's balance — some keys are shared across orgs and need this to bill correctly. */
  orgId?: string
  fetch?: typeof fetch
}

const ToolCall = v.object({
  id: v.string(),
  function: v.object({ name: v.string(), arguments: v.string() }),
})

const ChatCompletion = v.object({
  choices: v.pipe(
    v.array(
      v.object({
        message: v.object({
          content: v.nullable(v.string()),
          tool_calls: v.optional(v.array(ToolCall)),
        }),
      }),
    ),
    v.minLength(1),
  ),
})

type Completion = v.InferOutput<typeof ChatCompletion>

const ErrorBody = v.object({ error: v.object({ message: v.string() }) })

export function createKiloLlm(options: KiloLlmOptions): LlmCapability {
  const doFetch = options.fetch ?? fetch

  async function request(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Completion> {
    const response = await doFetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        ...(options.orgId ? { 'x-kilocode-organizationid': options.orgId } : {}),
      },
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
    if (!response.ok) {
      const error = v.safeParse(ErrorBody, parsed)
      throw new Error(`kilo gateway: ${error.success ? error.output.error.message : `HTTP ${response.status}`}`)
    }
    return v.parse(ChatCompletion, parsed)
  }

  function message(body: string, prompt: string): Record<string, unknown> {
    return {
      model: options.model,
      messages: [
        { role: 'system', content: body },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    }
  }

  function calls(completion: Completion): LlmToolCall[] {
    return (completion.choices[0]?.message.tool_calls ?? []).map((call) => {
      let args: unknown
      try {
        args = JSON.parse(call.function.arguments)
      } catch {
        throw new Error(`kilo gateway: malformed tool arguments for ${call.function.name}`)
      }
      return { id: call.id, name: call.function.name, arguments: args }
    })
  }

  return {
    async complete({ system, prompt, signal }) {
      const completion = await request(message(system, prompt), signal)
      const content = completion.choices[0]?.message.content
      if (!content) throw new Error('kilo gateway: empty completion')
      return content
    },
    async completeWithTools({ system, prompt, tools, toolChoice, signal }) {
      const completion = await request(
        {
          ...message(system, prompt),
          tools: tools.map((tool: LlmTool) => ({ type: 'function', function: tool })),
          ...(toolChoice ? { tool_choice: toolChoice } : {}),
        },
        signal,
      )
      const content = completion.choices[0]?.message.content ?? null
      const toolCalls = calls(completion)
      if (!content && toolCalls.length === 0) throw new Error('kilo gateway: empty completion')
      return { content, toolCalls }
    },
  }
}
