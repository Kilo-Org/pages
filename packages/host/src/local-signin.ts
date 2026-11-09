// Local development only. A `celld dev` Pages instance runs a loopback OIDC
// issuer that approves automatically; walking its redirects yields a 6 hour
// session cookie for the local developer. Production uses a bearer API key.
import type { PagesAuth } from '@pages-programs/pages'

const SESSION_COOKIE = '__Host-nteract_cloud_server_session'

function cookiePairs(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ')
}

async function hop(url: string, cookie: string): Promise<Response> {
  const response = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} })
  if (response.status < 300 || response.status >= 400) {
    throw new Error(`local sign-in: unexpected ${response.status} from ${url}`)
  }
  return response
}

export async function localSessionCookie(origin: string): Promise<string> {
  const login = await hop(`${origin}/api/auth/login`, '')
  const loginCookie = cookiePairs(login)
  const issuer = await hop(new URL(login.headers.get('location') ?? '', origin).href, '')
  const callback = await hop(new URL(issuer.headers.get('location') ?? '', origin).href, loginCookie)
  const session = cookiePairs(callback)
  if (!session.includes(SESSION_COOKIE)) throw new Error('local sign-in: no session cookie issued')
  return session
}

export function localOidcAuth(origin: string): PagesAuth {
  let cookie: string | undefined
  return {
    headers: async () => ({ cookie: (cookie ??= await localSessionCookie(origin)) }),
    refresh: async () => {
      cookie = await localSessionCookie(origin)
      return true
    },
  }
}
