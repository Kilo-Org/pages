import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstanceStore, SavedInstance } from './runtime.ts'

const path = (stateDir: string, program: string, pageId: string) => join(stateDir, program, `${pageId}.json`)

export function fileStore(stateDir: string, program: string, pageId: string): InstanceStore {
  const file = path(stateDir, program, pageId)
  return {
    async load() {
      const handle = Bun.file(file)
      return (await handle.exists()) ? ((await handle.json()) as SavedInstance) : undefined
    },
    async save(saved) {
      await mkdir(join(stateDir, program), { recursive: true })
      await Bun.write(file, JSON.stringify(saved, null, 2))
    },
  }
}

export const clearStore = (stateDir: string, program: string, pageId: string) =>
  rm(path(stateDir, program, pageId), { force: true })
