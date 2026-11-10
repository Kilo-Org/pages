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
  /** Keys with this prefix, for a program that needs to enumerate what it's tracking. */
  list(prefix: string): Promise<string[]>
}

/**
 * In-memory only, never persisted: for coordination objects (AbortControllers, base-text
 * snapshots for speculative work) that make no sense on disk and shouldn't survive a restart.
 * Fresh per `runProgram` instance, so no leakage between pages watched by the same program.
 */
export type ScratchState = {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  delete(key: string): void
}

/** One inference call. The host supplies the model and credentials; a program only sees this. */
export type LlmCapability = {
  /** `signal`, if given, aborts the underlying request — for discarding stale speculative work. */
  complete(input: { system: string; prompt: string; signal?: AbortSignal }): Promise<string>
}

/** Comment writes. The host supplies the Pages client and credentials. */
export type CommentsCapability = {
  /**
   * Posts a block-level comment. `dedupeOn` (typically the text being responded to) feeds a
   * deterministic idempotency key, so retrying with the same blockId + dedupeOn never double-posts.
   */
  addBlock(input: { blockId: string; body: string; dedupeOn: string }): Promise<{ threadId: string; messageId: string }>
  /** Edits an existing message in place (only the message's own author may). Same idempotency approach. */
  editMessage(input: {
    threadId: string
    messageId: string
    body: string
    dedupeOn: string
  }): Promise<{ threadId: string; messageId: string }>
}

export type ProgramContext = {
  log(message: string, data?: Record<string, unknown>): void
  state: ProgramState
  scratch: ScratchState
  /** Present only when the host was given an LLM capability (e.g. KILO_API_KEY is set). */
  llm?: LlmCapability
  comments?: CommentsCapability
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
  /** Optional: called every poll tick, even when no event fired. For debounced/timed logic. */
  tick?(ctx: ProgramContext): Promise<void>
}

export function defineProgram(program: Program): Program {
  return program
}
