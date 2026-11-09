import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as v from 'valibot'
import { eventTypes, type Program } from '@pages-programs/sdk'

const ProgramShape = v.object({
  manifest: v.object({
    name: v.string(),
    triggers: v.array(v.picklist(eventTypes)),
  }),
  key: v.function(),
  handle: v.function(),
})

/** A program is a folder under `programs/` whose `index.ts` default-exports defineProgram(...). */
export async function discoverPrograms(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const names: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && (await Bun.file(join(root, entry.name, 'index.ts')).exists())) names.push(entry.name)
  }
  return names.sort()
}

export async function loadProgram(root: string, name: string): Promise<Program> {
  const file = resolve(root, name, 'index.ts')
  if (!(await Bun.file(file).exists())) throw new Error(`no program "${name}": expected ${file}`)
  const module = (await import(file)) as { default?: unknown }
  const shape = v.safeParse(ProgramShape, module.default)
  if (!shape.success) {
    throw new Error(`programs/${name}/index.ts must default-export defineProgram(...): ${shape.issues[0]?.message}`)
  }
  const program = module.default as Program
  if (program.manifest.name !== name) {
    throw new Error(`programs/${name}: manifest.name is "${program.manifest.name}", expected "${name}"`)
  }
  return program
}
