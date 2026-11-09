// bun src/host/run-local.ts [--page ID] [--origin URL] [--interval MS] [--fresh]
import { mkdir, rm } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { bearerAuth, createPagesClient } from '../pages-client.ts'
import echo from '../programs/echo.ts'
import { localOidcAuth } from './local-signin.ts'
import { resolvePage } from './resolve-page.ts'
import { runProgram, type InstanceStore, type SavedInstance } from './runtime.ts'

const { values } = parseArgs({
  options: {
    page: { type: 'string', default: process.env.PAGES_PAGE_ID },
    origin: { type: 'string', default: process.env.PAGES_ORIGIN ?? 'http://localhost:9894' },
    interval: { type: 'string', default: '400' },
    fresh: { type: 'boolean', default: false },
  },
})

const origin = values.origin as string
const token = process.env.PAGES_TOKEN
const client = createPagesClient({ origin, auth: token ? bearerAuth(token) : localOidcAuth(origin) })

const stamp = () => new Date().toISOString().slice(11, 23)
const log = (line: string) => console.log(`${stamp()} ${line}`)

const resolved = await resolvePage(client, values.page).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
const pageId = resolved.pageId
if (resolved.discovered) log(`no --page given; watching your most recently edited page: "${resolved.title}" (${pageId})`)

const dir = `.state/${echo.manifest.name}`
const file = `${dir}/${pageId}.json`
if (values.fresh) await rm(file, { force: true })

const store: InstanceStore = {
  async load() {
    const handle = Bun.file(file)
    return (await handle.exists()) ? ((await handle.json()) as SavedInstance) : undefined
  },
  async save(saved) {
    await mkdir(dir, { recursive: true })
    await Bun.write(file, JSON.stringify(saved, null, 2))
  },
}

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort())

await runProgram({
  program: echo,
  client,
  pageId,
  store,
  intervalMs: Number(values.interval),
  signal: controller.signal,
  log,
})
