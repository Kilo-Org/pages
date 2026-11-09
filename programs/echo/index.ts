import { defineProgram, type NodeChange, type ProgramContext } from '@pages-programs/sdk'

export type TextDelta = { removed: string; added: string }

/** Smallest single replacement that turns `before` into `after`. */
export function textDelta(before: string, after: string): TextDelta {
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  return { removed: before.slice(start, endBefore), added: after.slice(start, endAfter) }
}

const nodeKey = (change: NodeChange) => `nodes/${change.blockId}:${change.nodeId ?? change.nodeIndex ?? 0}`

async function describe(change: NodeChange, ctx: ProgramContext): Promise<string | null> {
  if (change.scope === 'block') return `block ${change.blockId.slice(0, 8)} ${change.change}`
  const key = nodeKey(change)
  if (change.change === 'deleted') {
    await ctx.state.delete(key)
    return `deleted ${change.type ?? 'node'}`
  }
  const after = change.markdown ?? ''
  const before = await ctx.state.get<string>(key)
  await ctx.state.set(key, after)
  // Nothing to diff against until the program has seen this node once.
  if (before === undefined) return `first sight of ${change.type ?? 'node'}: ${JSON.stringify(after)}`
  const { removed, added } = textDelta(before, after)
  if (!removed && !added) return null
  const parts = [] as string[]
  if (added) parts.push(`+${JSON.stringify(added)}`)
  if (removed) parts.push(`-${JSON.stringify(removed)}`)
  return `${parts.join(' ')}  → ${JSON.stringify(after)}`
}

export default defineProgram({
  manifest: { name: 'echo', triggers: ['page.changed'] },
  key: (event) => event.pageId,
  async handle(event, ctx) {
    if (event.titleChanged) ctx.log(`title → ${JSON.stringify(event.title)}`)
    for (const change of event.changes) {
      const line = await describe(change, ctx)
      if (line) ctx.log(line)
    }
  },
})
