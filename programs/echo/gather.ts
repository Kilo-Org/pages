// Scoped, best-effort reads for context assembly. A read failure never blocks
// a reply: the trigger and the room remain enough to answer, and the envelope
// records that it was degraded. A slow read is bounded by a short timeout so it
// cannot stall the page loop.
import type { PageRead, ProgramContext, ThreadRead } from '@pages-programs/sdk'

export type GatherInput = {
  ctx: ProgramContext
  pageId: string
  surface: 'body' | 'comment'
  blockId: string | null
  threadId: string | null
  /** Stable cache key for this trigger, usually its text or message id. */
  key: string
  /** Aborts reads when the attempt is superseded by newer input. */
  signal?: AbortSignal
  /** Test and tuning override for the per-read timeout. */
  timeoutMs?: number
}

export type GatheredContext = {
  page: PageRead | null
  threads: ThreadRead[]
  degraded: boolean
}

const CACHE_KEY = 'context-cache'
const CACHE_LIMIT = 16
const CACHE_TTL_MS = 5_000
const READ_TIMEOUT_MS = 2_000
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

const isAbortError = (error: unknown): boolean => {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : ''
  return name === 'AbortError' || name === 'TimeoutError'
}

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
  signal: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<{ page: PageRead | null; degraded: boolean }> {
  try {
    const page = await ctx.reads!.page({
      ...(blockId ? { blockIds: [blockId] } : {}),
      includeContent,
      includePresence: true,
      maxBytes: PAGE_BYTES,
      signal,
    })
    return { page, degraded: false }
  } catch (error) {
    if (callerSignal?.aborted) return { page: null, degraded: false }
    if (includeContent && isBudgetError(error)) {
      warnOnce(ctx, `read_page exceeded its budget for block ${blockId?.slice(0, 8) ?? 'page'}`)
      const retry = await readPage(ctx, blockId, false, signal, callerSignal)
      return { page: retry.page, degraded: true }
    }
    warnOnce(
      ctx,
      isAbortError(error)
        ? 'read_page timed out'
        : `read_page: ${messageOf(error)}`,
    )
    return { page: null, degraded: true }
  }
}

type ThreadScope = { blockId: string; state: 'open' } | { threadIds: string[]; state: 'all' }

async function readThreadScope(
  ctx: ProgramContext,
  scope: ThreadScope,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<{ threads: ThreadRead[] | null; degraded: boolean }> {
  const read = (includeMessages: boolean) =>
    ctx.reads!.comments({
      ...(scope.state === 'all' ? { threadIds: scope.threadIds } : { blockId: scope.blockId }),
      state: scope.state,
      includeMessages,
      maxBytes: COMMENT_BYTES,
      signal,
    })
  const label =
    scope.state === 'all'
      ? scope.threadIds[0]?.slice(0, 8)
      : scope.blockId.slice(0, 8)
  try {
    return { threads: await read(true), degraded: false }
  } catch (error) {
    if (callerSignal?.aborted) return { threads: null, degraded: false }
    if (isBudgetError(error)) {
      warnOnce(ctx, `list_page_comments exceeded its budget for ${label}`)
      try {
        return { threads: await read(false), degraded: true }
      } catch (retryError) {
        if (callerSignal?.aborted) return { threads: null, degraded: false }
        warnOnce(
          ctx,
          isAbortError(retryError)
            ? 'list_page_comments timed out'
            : `list_page_comments: ${messageOf(retryError)}`,
        )
        return { threads: null, degraded: true }
      }
    }
    warnOnce(
      ctx,
      isAbortError(error)
        ? 'list_page_comments timed out'
        : `list_page_comments: ${messageOf(error)}`,
    )
    return { threads: null, degraded: true }
  }
}

async function readThreads(
  ctx: ProgramContext,
  surface: 'body' | 'comment',
  blockId: string | null,
  threadId: string | null,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<{ threads: ThreadRead[]; degraded: boolean }> {
  const scopes: ThreadScope[] = []
  if (surface === 'comment') {
    if (threadId) scopes.push({ threadIds: [threadId], state: 'all' })
    else if (blockId) scopes.push({ blockId, state: 'open' })
  } else {
    if (threadId) scopes.push({ threadIds: [threadId], state: 'all' })
    if (blockId) scopes.push({ blockId, state: 'open' })
  }
  if (scopes.length === 0) return { threads: [], degraded: false }

  const results = await Promise.all(
    scopes.map((scope) => readThreadScope(ctx, scope, signal, callerSignal)),
  )
  const merged = new Map<string, ThreadRead>()
  for (const result of results) {
    for (const thread of result.threads ?? []) {
      if (!merged.has(thread.id)) merged.set(thread.id, thread)
    }
  }
  return {
    threads: [...merged.values()],
    degraded: results.some((result) => result.degraded),
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
  if (input.signal?.aborted) return { page: null, threads: [], degraded: false }

  const cache = cacheOf(ctx)
  const cacheKey = `${pageId}:${surface}:${blockId ?? '-'}:${threadId ?? '-'}:${key.length}:${key.slice(0, 120)}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? READ_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // A blockless trigger still gets the page title and heading outline.
    const [pageResult, threadResult] = await Promise.all([
      readPage(ctx, blockId, Boolean(blockId), controller.signal, input.signal),
      readThreads(ctx, surface, blockId, threadId, controller.signal, input.signal),
    ])
    if (input.signal?.aborted) return { page: null, threads: [], degraded: false }
    const value: GatheredContext = {
      page: pageResult.page,
      threads: threadResult.threads,
      degraded: pageResult.degraded || threadResult.degraded,
    }

    if (cache.size >= CACHE_LIMIT) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) cache.delete(oldest[0])
    }
    cache.set(cacheKey, { at: Date.now(), value })
    return value
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
}