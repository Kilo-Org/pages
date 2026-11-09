// Stand-in for the program host: owns the loop, the cursor and the state, so a
// program only ever sees `handle(event, ctx)`. A Durable Object supervisor would
// replace this file; the Program contract and the page source stay as they are.
import type { PagesClient } from '../pages-client.ts'
import { openCursor, pollPage, type PageCursor } from '../page-changes-source.ts'
import type { Program, ProgramContext, ProgramEvent } from '../program.ts'

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

  const ctx: ProgramContext = {
    log: (message, data) => options.log(data ? `${message} ${JSON.stringify(data)}` : message),
    state: {
      get: async <T>(key: string) => kv[key] as T | undefined,
      set: async (key, value) => void (kv[key] = value),
      delete: async (key) => void delete kv[key],
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
      // Advance the durable cursor only after the handler returned: at-least-once.
      cursor = result.cursor
      if (event || result.resynced) await persist()
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
