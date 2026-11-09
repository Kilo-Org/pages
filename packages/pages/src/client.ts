// Minimal Pages JSON-tools client. fetch only, so it runs anywhere a Worker does.

export type PagesAuth = {
  headers(): Promise<Record<string, string>>
  /** Called once after a 401 so the host can sign in again; return false to give up. */
  refresh?(): Promise<boolean>
}

export type PagesClientOptions = {
  origin: string
  auth: PagesAuth
  fetch?: typeof fetch
}

export class PagesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(`${code}: ${message}`)
  }
}

export type PagesClient = ReturnType<typeof createPagesClient>

export function bearerAuth(token: string): PagesAuth {
  return { headers: async () => ({ authorization: `Bearer ${token}` }) }
}

export function createPagesClient(options: PagesClientOptions) {
  const origin = options.origin.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch

  async function send(operation: string, args: Record<string, unknown>): Promise<Response> {
    return doFetch(`${origin}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...(await options.auth.headers()) },
      body: JSON.stringify({ operation, arguments: args }),
    })
  }

  async function call(operation: string, args: Record<string, unknown>): Promise<unknown> {
    let response = await send(operation, args)
    if (response.status === 401 && options.auth.refresh && (await options.auth.refresh())) {
      response = await send(operation, args)
    }
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    if (!response.ok) {
      const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
      throw new PagesError(
        response.status,
        typeof record.code === 'string' ? record.code : 'request_failed',
        typeof record.error === 'string' ? record.error : `HTTP ${response.status}`,
        body,
      )
    }
    return body
  }

  return { call }
}
