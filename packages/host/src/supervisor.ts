// Runs a fleet: one loop per (worker, watched page), all in this process and
// sharing one authenticated client. A failing instance is logged and left
// behind; it never takes the others down. A Durable Object per instance
// replaces this later, keyed the same way: program + page.
import type { PagesClient } from '@pages-programs/pages'
import { clearStore, fileStore } from './file-store.ts'
import { RECENT_PAGE, type FleetSpec } from './fleet.ts'
import { loadProgram } from './programs.ts'
import { resolvePage } from './resolve-page.ts'
import { runProgram } from './runtime.ts'

export type UpOptions = {
  fleet: FleetSpec
  client: PagesClient
  programsDir: string
  stateDir: string
  intervalMs: number
  signal: AbortSignal
  log(line: string): void
  fresh?: boolean
}

export async function up(options: UpOptions): Promise<void> {
  const instances = options.fleet.workers.flatMap((worker) =>
    worker.watch.map((watch) => ({ program: worker.program, page: watch.page })),
  )

  const results = await Promise.allSettled(
    instances.map(async ({ program: name, page }) => {
      const label = (id: string) => `${name}:${id.slice(0, 8)}`
      const loaded = await loadProgram(options.programsDir, name)
      const resolved = await resolvePage(options.client, page === RECENT_PAGE ? undefined : page)
      const log = (line: string) => options.log(`[${label(resolved.pageId)}] ${line}`)
      if (resolved.discovered) log(`most recently edited page is "${resolved.title}" (${resolved.pageId})`)
      if (options.fresh) await clearStore(options.stateDir, name, resolved.pageId)
      await runProgram({
        program: loaded,
        client: options.client,
        pageId: resolved.pageId,
        store: fileStore(options.stateDir, name, resolved.pageId),
        intervalMs: options.intervalMs,
        signal: options.signal,
        log,
      })
    }),
  )

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const { program, page } = instances[index]!
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      options.log(`[${program}] ${page} stopped: ${reason}`)
    }
  })
}
