// Thin client for Kilo's AI Gateway (https://kilo.ai/docs/gateway): an
// OpenAI-compatible chat-completions endpoint. Lives in the host, not a
// program, since programs may only reach the outside world through ctx.
import * as v from 'valibot'
import type { LlmCapability } from '@pages-programs/sdk'

const GATEWAY_URL = 'https://ai-gateway.kilo.ai/api/v1/chat/completions'

export type KiloLlmOptions = {
  apiKey: string
  model: string
  /** Scopes the request to a specific org's balance — some keys are shared across orgs and need this to bill correctly. */
  orgId?: string
  fetch?: typeof fetch
}

const ChatCompletion = v.object({
  choices: v.pipe(v.array(v.object({ message: v.object({ content: v.nullable(v.string()) }) })), v.minLength(1)),
})

const ErrorBody = v.object({ error: v.object({ message: v.string() }) })

export function createKiloLlm(options: KiloLlmOptions): LlmCapability {
  const doFetch = options.fetch ?? fetch
  return {
    async complete({ system, prompt, signal }) {
      const response = await doFetch(GATEWAY_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
          ...(options.orgId ? { 'x-kilocode-organizationid': options.orgId } : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
        }),
        signal,
      })
      const text = await response.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      if (!response.ok) {
        const parsed = v.safeParse(ErrorBody, body)
        throw new Error(`kilo gateway: ${parsed.success ? parsed.output.error.message : `HTTP ${response.status}`}`)
      }
      const completion = v.parse(ChatCompletion, body)
      const content = completion.choices[0]?.message.content
      if (!content) throw new Error('kilo gateway: empty completion')
      return content
    },
  }
}
