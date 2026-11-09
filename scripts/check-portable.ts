// A program, its event source and the Pages client must bundle for a bare
// Worker isolate: no node:/bun: imports, no Bun or process globals.
import { relative } from 'node:path'

const entries = ['src/programs/echo.ts', 'src/page-changes-source.ts']
const forbidden = /\bnode:|\bbun:|\bBun\.|\bprocess\./

const result = await Bun.build({ entrypoints: entries, target: 'browser', format: 'esm', metafile: true })
if (!result.success) {
  console.error(result.logs.map(String).join('\n'))
  process.exit(1)
}

const inputs = Object.keys(result.metafile?.inputs ?? {})
const problems: string[] = []
for (const input of inputs) {
  if (input.includes('node_modules')) continue
  const source = await Bun.file(input).text()
  const hit = source.split('\n').findIndex((line) => forbidden.test(line.replace(/\/\/.*$/, '')))
  if (hit >= 0) problems.push(`${relative('.', input)}:${hit + 1} uses a host-only API`)
}

const bytes = result.outputs.reduce((total, output) => total + output.size, 0)
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`portable: ${inputs.length} modules, ${(bytes / 1024).toFixed(1)} KiB bundled`)
