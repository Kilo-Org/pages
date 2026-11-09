import { describe, expect, test } from 'bun:test'
import echo, { textDelta } from '../src/programs/echo.ts'
import type { NodeChange, PageChangedEvent, ProgramContext } from '../src/program.ts'

function harness() {
  const lines: string[] = []
  const kv: Record<string, unknown> = {}
  const ctx: ProgramContext = {
    log: (message) => void lines.push(message),
    state: {
      get: async <T>(key: string) => kv[key] as T | undefined,
      set: async (key, value) => void (kv[key] = value),
      delete: async (key) => void delete kv[key],
    },
  }
  return { lines, ctx }
}

const node = (change: NodeChange['change'], markdown: string | null): NodeChange => ({
  scope: 'node',
  blockId: 'b1',
  change,
  nodeIndex: 0,
  nodeId: null,
  type: 'paragraph',
  markdown,
})

const event = (n: number, changes: NodeChange[]): PageChangedEvent => ({
  id: `p@${n}`,
  type: 'page.changed',
  at: '2026-11-09T00:00:00.000Z',
  pageId: 'p',
  title: 'T',
  titleChanged: false,
  fromHeads: [`h${n - 1}`],
  toHeads: [`h${n}`],
  changes,
})

describe('textDelta', () => {
  test('insertion, deletion and replacement', () => {
    expect(textDelta('Hello', 'Hello!')).toEqual({ removed: '', added: '!' })
    expect(textDelta('Hello world', 'Hello')).toEqual({ removed: ' world', added: '' })
    expect(textDelta('cat', 'cot')).toEqual({ removed: 'a', added: 'o' })
    expect(textDelta('a', 'a')).toEqual({ removed: '', added: '' })
  })
})

describe('echo program', () => {
  test('first sight, then deltas, from state', async () => {
    const { lines, ctx } = harness()
    await echo.handle(event(1, [node('updated', 'Hello')]), ctx)
    await echo.handle(event(2, [node('updated', 'Hello, wor')]), ctx)
    await echo.handle(event(3, [node('updated', 'Hello, world')]), ctx)
    expect(lines).toEqual([
      'first sight of paragraph: "Hello"',
      '+", wor"  → "Hello, wor"',
      '+"ld"  → "Hello, world"',
    ])
  })

  test('deleted nodes forget their text', async () => {
    const { lines, ctx } = harness()
    await echo.handle(event(1, [node('updated', 'x')]), ctx)
    await echo.handle(event(2, [node('deleted', null)]), ctx)
    await echo.handle(event(3, [node('inserted', 'x')]), ctx)
    expect(lines[1]).toBe('deleted paragraph')
    expect(lines[2]).toStartWith('first sight')
  })

  test('is keyed by page', () => {
    expect(echo.key(event(1, []))).toBe('p')
  })
})
