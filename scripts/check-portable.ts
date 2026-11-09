// Two rules keep programs loadable as Dynamic Workers:
//  1. Everything bundled for a Worker avoids node:/bun: imports and Bun/process globals.
//  2. A program may import only its own folder and the SDK: never the host,
//     the Pages client or another program. Anything else it needs arrives on ctx.
import { readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const root = resolve('.')
const forbidden = /\bnode:|\bbun:|\bBun\.|\bprocess\./
const problems: string[] = []

const programNames = (await readdir('programs', { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

async function bundle(entry: string, allowed: (input: string) => boolean, label: string) {
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', metafile: true })
  if (!result.success) {
    problems.push(`${label}: ${result.logs.map(String).join('; ')}`)
    return
  }
  const inputs = Object.keys(result.metafile?.inputs ?? {}).map((input) => resolve(input))
  for (const input of inputs) {
    const rel = relative(root, input)
    if (rel.includes('node_modules')) continue
    if (!allowed(rel)) problems.push(`${label}: imports ${rel}, outside its allowed boundary`)
    const lines = (await Bun.file(input).text()).split('\n')
    const hit = lines.findIndex((line) => forbidden.test(line.replace(/\/\/.*$/, '')))
    if (hit >= 0) problems.push(`${label}: ${rel}:${hit + 1} uses a host-only API`)
  }
  const bytes = result.outputs.reduce((total, output) => total + output.size, 0)
  console.log(`${label.padEnd(22)} ${String(inputs.length).padStart(2)} modules  ${(bytes / 1024).toFixed(1).padStart(5)} KiB`)
}

for (const name of programNames) {
  await bundle(
    `programs/${name}/index.ts`,
    (rel) => rel.startsWith(`programs/${name}/`) || rel.startsWith('packages/sdk/'),
    `programs/${name}`,
  )
}
await bundle('packages/pages/src/index.ts', (rel) => rel.startsWith('packages/pages/') || rel.startsWith('packages/sdk/'), 'packages/pages')

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
