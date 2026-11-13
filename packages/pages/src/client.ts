// Minimal Pages JSON-tools client. fetch only, so it runs anywhere a Worker does.

import * as v from 'valibot'

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

export type Whoami = {
  principal: string
  displayName: string | null
  email: string | null
  credentialKind: string
  canWrite: boolean
}

const WhoamiResponse = v.object({
  account: v.object({
    principal: v.string(),
    display_name: v.optional(v.nullable(v.string())),
    email: v.optional(v.nullable(v.string())),
  }),
  credential: v.object({
    kind: v.string(),
    can_write: v.boolean(),
  }),
})

export function bearerAuth(token: string): PagesAuth {
  return { headers: async () => ({ authorization: `Bearer ${token}` }) }
}

export function createPagesClient(options: PagesClientOptions) {
  const origin = options.origin.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch

  async function send(
    operation: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    return doFetch(`${origin}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...(await options.auth.headers()) },
      body: JSON.stringify({ operation, arguments: args }),
      ...(signal ? { signal } : {}),
    })
  }

  async function parse(response: Response): Promise<unknown> {
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

  async function call(
    operation: string,
    args: Record<string, unknown>,
    callOptions: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    let response = await send(operation, args, callOptions.signal)
    if (response.status === 401 && options.auth.refresh && (await options.auth.refresh())) {
      response = await send(operation, args, callOptions.signal)
    }
    return parse(response)
  }

  async function whoami(): Promise<Whoami> {
    const get = async () =>
      doFetch(`${origin}/whoami`, {
        method: 'GET',
        headers: { origin, ...(await options.auth.headers()) },
      })
    let response = await get()
    if (response.status === 401 && options.auth.refresh && (await options.auth.refresh())) {
      response = await get()
    }
    const body = v.parse(WhoamiResponse, await parse(response))
    return {
      principal: body.account.principal,
      displayName: body.account.display_name ?? null,
      email: body.account.email ?? null,
      credentialKind: body.credential.kind,
      canWrite: body.credential.can_write,
    }
  }

  return { call, whoami }
}
