import { expect, test } from 'bun:test'
import type { PageChangedEvent, ProgramContext } from '@pages-programs/sdk'
import tally from './index.ts'

test('counts events in state across calls', async () => {
  const kv: Record<string, unknown> = {}
  const lines: string[] = []
  const ctx: ProgramContext = {
    log: (message) => void lines.push(message),
    state: {
      get: async <T>(key: string) => kv[key] as T | undefined,
      set: async (key, value) => void (kv[key] = value),
      delete: async (key) => void delete kv[key],
      list: async (prefix) => Object.keys(kv).filter((key) => key.startsWith(prefix)),
    },
    scratch: { get: () => undefined, set: () => {}, delete: () => {} },
  }
  const event = { id: 'p@h1', type: 'page.changed', pageId: 'p', changes: [{}, {}] } as unknown as PageChangedEvent
  await tally.handle(event, ctx)
  await tally.handle(event, ctx)
  expect(lines).toEqual(['edit batch #1: 2 change(s)', 'edit batch #2: 2 change(s)'])
})
