// Scoped, best-effort reads for context assembly. A read failure never blocks
// a reply: the trigger and the room remain enough to answer, and the envelope
// records that it was degraded.
import type { PageRead, ProgramContext, ThreadRead } from '@pages-programs/sdk'

export type GatherInput = {
  ctx: ProgramContext
  pageId: string
  surface: 'body' | 'comment'
  blockId: string | null
  threadId: string | null
  /** Stable cache key for this trigger, usually its text or message id. */
  key: string
}

export type GatheredContext = {
  page: PageRead | null
  threads: ThreadRead[]
  degraded: boolean
}

const CACHE_KEY = 'context-cache'
const CACHE_LIMIT = 16
const CACHE_TTL_MS = 5_000
const PAGE_BYTES = 24 * 1024
const COMMENT_BYTES = 12 * 1024

type Cache = Map<string, { at: number; value: GatheredContext }>

const cacheOf = (ctx: ProgramContext): Cache => {
  const existing = ctx.scratch.get<Cache>(CACHE_KEY)
  if (existing) return existing
  const created: Cache = new Map()
  ctx.scratch.set(CACHE_KEY, created)
  return created
}

const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''

const isBudgetError = (error: unknown): boolean => codeOf(error) === 'read_budget_exceeded'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const warnOnce = (ctx: ProgramContext, message: string): void => {
  if (ctx.scratch.get<boolean>('context-read-warning')) return
  ctx.scratch.set('context-read-warning', true)
  ctx.log(`context reads degraded: ${message}`)
}

async function readPage(
  ctx: ProgramContext,
  blockId: string | null,
  includeContent: boolean,
): Promise<{ page: PageRead | null; degraded: boolean }> {
  try {
    const page = await ctx.reads!.page({
      ...(blockId ? { blockIds: [blockId] } : {}),
      includeContent,
      includePresence: true,
      maxBytes: PAGE_BYTES,
    })
    return { page, degraded: false }
  } catch (error) {
    if (includeContent && isBudgetError(error)) {
      warnOnce(ctx, `read_page exceeded its budget for block ${blockId?.slice(0, 8) ?? 'page'}`)
      const retry = await readPage(ctx, blockId, false)
      return { page: retry.page, degraded: true }
    }
    warnOnce(ctx, `read_page: ${messageOf(error)}`)
    return { page: null, degraded: true }
  }
}

async function readThreads(
  ctx: ProgramContext,
  surface: 'body' | 'comment',
  blockId: string | null,
  threadId: string | null,
): Promise<{ threads: ThreadRead[] | null; degraded: boolean }> {
  const read = (includeMessages: boolean) =>
    ctx.reads!.comments({
      ...(surface === 'comment' && threadId ? { threadIds: [threadId] } : {}),
      ...(blockId && (surface === 'body' || !threadId) ? { blockId } : {}),
      state: surface === 'comment' ? 'all' : 'open',
      includeMessages,
      maxBytes: COMMENT_BYTES,
    })
  try {
    return { threads: await read(true), degraded: false }
  } catch (error) {
    if (isBudgetError(error)) {
      warnOnce(ctx, `list_page_comments exceeded its budget for ${blockId?.slice(0, 8) ?? threadId?.slice(0, 8)}`)
      try {
        return { threads: await read(false), degraded: true }
      } catch (retryError) {
        warnOnce(ctx, `list_page_comments: ${messageOf(retryError)}`)
        return { threads: null, degraded: true }
      }
    }
    warnOnce(ctx, `list_page_comments: ${messageOf(error)}`)
    return { threads: null, degraded: true }
  }
}

/**
 * Reads the smallest useful page and comment scope for a trigger. The caller
 * passes the current trigger key so a retry within the cache window does not
 * repeat the same reads.
 */
export async function gatherContext(input: GatherInput): Promise<GatheredContext> {
  const { ctx, pageId, surface, blockId, threadId, key } = input
  if (!ctx.reads) return { page: null, threads: [], degraded: false }

  const cache = cacheOf(ctx)
  const cacheKey = `${pageId}:${surface}:${blockId ?? '-'}:${threadId ?? '-'}:${key.length}:${key.slice(0, 120)}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  const wantsPage = Boolean(blockId)
  const [pageResult, threadResult] = await Promise.all([
    wantsPage
      ? readPage(ctx, blockId, true)
      : Promise.resolve({ page: null, degraded: false }),
    readThreads(ctx, surface, blockId, threadId),
  ])
  const value: GatheredContext = {
    page: pageResult.page,
    threads: threadResult.threads ?? [],
    degraded: pageResult.degraded || threadResult.degraded,
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) cache.delete(oldest[0])
  }
  cache.set(cacheKey, { at: Date.now(), value })
  return value
}
