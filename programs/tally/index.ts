import { defineProgram } from '@pages-programs/sdk'

// Counts how many change events this page has produced, across restarts.
export default defineProgram({
  manifest: { name: 'tally', triggers: ['page.changed'] },
  key: (event) => event.pageId,
  async handle(event, ctx) {
    const events = ((await ctx.state.get<number>('events')) ?? 0) + 1
    await ctx.state.set('events', events)
    ctx.log(`edit batch #${events}: ${event.changes.length} change(s)`)
  },
})
