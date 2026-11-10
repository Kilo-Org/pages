// pp up [program...] [--fleet FILE] [--page ID] [--origin URL] [--interval MS] [--fresh]
// pp list [--fleet FILE]
import { parseArgs } from 'node:util'
import { bearerAuth, createPagesClient } from '@pages-programs/pages'
import { defaultFleet, parseFleet, type FleetSpec } from './fleet.ts'
import { localOidcAuth } from './local-signin.ts'
import { createKiloLlm } from './llm.ts'
import { discoverPrograms, loadProgram } from './programs.ts'
import { up } from './supervisor.ts'

const PROGRAMS_DIR = 'programs'
const STATE_DIR = '.state'
const DEFAULT_ORIGIN = 'http://localhost:9894'
const DEFAULT_INTERVAL_MS = 400
// Fast and cheap, not frontier — latency matters more than raw capability here,
// since the whole point is a quick yes/no + short reply. Set KILO_MODEL to override
// (e.g. back to 'kilo-auto/free' if your Kilo account has no credits).
const DEFAULT_KILO_MODEL = 'anthropic/claude-haiku-5.5'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fleet: { type: 'string', default: 'fleet.yaml' },
    page: { type: 'string' },
    origin: { type: 'string' },
    interval: { type: 'string' },
    fresh: { type: 'boolean', default: false },
  },
})

const [command = 'up', ...selected] = positionals
const stamp = () => new Date().toISOString().slice(11, 23)
const log = (line: string) => console.log(`${stamp()} ${line}`)
const fail = (message: string): never => {
  console.error(message)
  return process.exit(1)
}

async function readFleet(file: string): Promise<FleetSpec> {
  const handle = Bun.file(file)
  if (!(await handle.exists())) return defaultFleet(await discoverPrograms(PROGRAMS_DIR))
  return parseFleet(Bun.YAML.parse(await handle.text()))
}

const fleet = await readFleet(values.fleet as string).catch((error: unknown) =>
  fail(`${values.fleet}: ${error instanceof Error ? error.message : error}`),
)

if (command === 'list') {
  const running = new Map(fleet.workers.map((worker) => [worker.program, worker.watch.map((w) => w.page).join(', ')]))
  for (const name of await discoverPrograms(PROGRAMS_DIR)) {
    const program = await loadProgram(PROGRAMS_DIR, name).catch((error: unknown) =>
      fail(error instanceof Error ? error.message : String(error)),
    )
    const watching = running.has(name) ? `watches ${running.get(name)}` : 'not in fleet'
    console.log(`${name.padEnd(16)} ${program.manifest.triggers.join(', ').padEnd(16)} ${watching}`)
  }
} else if (command === 'up') {
  const known = new Set(fleet.workers.map((worker) => worker.program))
  for (const name of selected) if (!known.has(name)) fail(`"${name}" is not in the fleet (${[...known].join(', ')})`)

  // Flags win over the environment, which wins over the fleet file, then defaults.
  const origin = values.origin ?? process.env.PAGES_ORIGIN ?? fleet.origin ?? DEFAULT_ORIGIN
  const intervalMs = Number(values.interval ?? fleet.intervalMs ?? DEFAULT_INTERVAL_MS)
  const token = process.env.PAGES_TOKEN
  const client = createPagesClient({ origin, auth: token ? bearerAuth(token) : localOidcAuth(origin) })
  const kiloApiKey = process.env.KILO_API_KEY
  const llm = kiloApiKey
    ? createKiloLlm({ apiKey: kiloApiKey, model: process.env.KILO_MODEL ?? DEFAULT_KILO_MODEL, orgId: process.env.KILO_ORG_ID })
    : undefined
  if (!llm) log('KILO_API_KEY not set: programs that need ctx.llm will skip those decisions')

  const workers = fleet.workers
    .filter((worker) => selected.length === 0 || selected.includes(worker.program))
    .map((worker) => (values.page ? { ...worker, watch: [{ page: values.page }] } : worker))

  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort())

  log(`fleet: ${workers.map((worker) => worker.program).join(', ')} → ${origin}`)
  await up({
    fleet: { ...fleet, workers },
    client,
    programsDir: PROGRAMS_DIR,
    stateDir: STATE_DIR,
    intervalMs,
    signal: controller.signal,
    log,
    fresh: values.fresh,
    llm,
  })
} else {
  fail(`unknown command "${command}". Use: up [program...] | list`)
}
