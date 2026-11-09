// The contract between a program and whatever hosts it. Nothing in this file
// (or in a program that imports only it) may touch Node, Bun or the filesystem:
// the same module must load as a Dynamic Worker later.

export type NodeChange = {
  /** `block` entries only say a block changed; `node` entries carry its text. */
  scope: 'block' | 'node'
  blockId: string
  change: 'inserted' | 'updated' | 'deleted' | (string & {})
  nodeIndex: number | null
  nodeId: string | null
  type: string | null
  markdown: string | null
}

export type PageChangedEvent = {
  /** Stable across redeliveries: page plus the heads the change was observed at. */
  id: string
  type: 'page.changed'
  at: string
  pageId: string
  title: string | null
  titleChanged: boolean
  fromHeads: string[]
  toHeads: string[]
  changes: NodeChange[]
}

export type ProgramEvent = PageChangedEvent

/** Every event type a manifest may subscribe to. */
export const eventTypes = ['page.changed'] as const satisfies readonly ProgramEvent['type'][]

export type ProgramState = {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
}

export type ProgramContext = {
  log(message: string, data?: Record<string, unknown>): void
  state: ProgramState
}

export type Program = {
  manifest: {
    name: string
    /** Event types the program wants. The host decides which pages feed it. */
    triggers: ProgramEvent['type'][]
  }
  /** Instance key: events with the same key are handled serially with shared state. */
  key(event: ProgramEvent): string
  handle(event: ProgramEvent, ctx: ProgramContext): Promise<void>
}

export function defineProgram(program: Program): Program {
  return program
}
