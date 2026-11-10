// Stand-in for the program host: owns the loop, the cursor and the state, so a
// program only ever sees `handle(event, ctx)`. A Durable Object supervisor would
// replace this file; the Program contract and the page source stay as they are.
import type { PagesClient } from '@pages-programs/pages'
import { addBlockComment, editComment, openCursor, pollPage, type PageCursor } from '@pages-programs/pages'
import type { LlmCapability, Program, ProgramContext, ProgramEvent } from '@pages-programs/sdk'

export type SavedInstance = {
  cursor: PageCursor
  kv: Record<string, unknown>
  lastEventId: string | null
}

export type InstanceStore = {
  load(): Promise<SavedInstance | undefined>
  save(saved: SavedInstance): Promise<void>
}

export type RunOptions = {
  program: Program
  client: PagesClient
  pageId: string
  store: InstanceStore
  intervalMs: number
  signal: AbortSignal
  log(line: string): void
  /** Present only when the host has model credentials configured (e.g. KILO_API_KEY). */
  llm?: LlmCapability
  /** Resolves when the program has handled this many events (tests and demos). */
  stopAfterEvents?: number
}

export async function runProgram(options: RunOptions): Promise<void> {
  const { program, client, pageId, store, signal } = options
  const saved = await store.load()
  let cursor = saved?.cursor ?? (await openCursor(client, pageId))
  const kv: Record<string, unknown> = saved?.kv ?? {}
  let lastEventId = saved?.lastEventId ?? null
  let handled = 0
  let failures = 0
  // Set by ctx.state.set/delete; lets us persist only when something actually changed,
  // instead of on every poll just because the program defines tick().
  let kvDirty = false
  // In-memory only, never persisted — fresh per runProgram() call, so no leakage between
  // (program, page) instances even though a program module is imported once and reused.
  const scratch = new Map<string, unknown>()

  const ctx: ProgramContext = {
    log: (message, data) => options.log(data ? `${message} ${JSON.stringify(data)}` : message),
    state: {
      get: async <T>(key: string) => kv[key] as T | undefined,
      set: async (key, value) => {
        kv[key] = value
        kvDirty = true
      },
      delete: async (key) => {
        if (key in kv) {
          delete kv[key]
          kvDirty = true
        }
      },
      list: async (prefix: string) => Object.keys(kv).filter((key) => key.startsWith(prefix)),
    },
    scratch: {
      get: <T>(key: string) => scratch.get(key) as T | undefined,
      set: (key, value) => void scratch.set(key, value),
      delete: (key) => void scratch.delete(key),
    },
    llm: options.llm,
    comments: {
      addBlock: (input) => addBlockComment(client, { pageId, ...input }),
      editMessage: (input) => editComment(client, { pageId, ...input }),
    },
  }

  const persist = () => store.save({ cursor, kv, lastEventId })
  await persist()
  options.log(`watching ${cursor.title ?? pageId} @ ${cursor.heads[0]?.slice(0, 8)} as "${program.manifest.name}"`)

  while (!signal.aborted) {
    try {
      const result = await pollPage(client, pageId, cursor)
      failures = 0
      const event: ProgramEvent | null = result.event
      if (event && program.manifest.triggers.includes(event.type) && event.id !== lastEventId) {
        await program.handle(event, ctx)
        lastEventId = event.id
        handled++
      }
      if (result.resynced) options.log('cursor was unknown to the host; resynced to current heads')
      if (program.tick) await program.tick(ctx)
      // Advance the durable cursor only once handle/tick have both returned: at-least-once.
      // If tick throws, this line never runs, so a retry re-polls from the same cursor —
      // lastEventId still skips re-running handle() for an event already processed.
      cursor = result.cursor
      if (event || result.resynced || kvDirty) {
        await persist()
        kvDirty = false
      }
      if (options.stopAfterEvents !== undefined && handled >= options.stopAfterEvents) return
    } catch (error) {
      failures++
      const message = error instanceof Error ? error.message : String(error)
      options.log(`poll failed (${failures}): ${message}`)
    }
    await sleep(Math.min(options.intervalMs * 2 ** Math.min(failures, 5), 15_000), signal)
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}
