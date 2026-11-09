// A fleet is data, not code: which programs run and what each one watches.
// Keeping it a validated value (rather than a script) is what lets a future
// control plane create, store and diff fleets without executing anything.
import * as v from 'valibot'

/** A `watch.page` of "recent" means the account's most recently edited page. */
export const RECENT_PAGE = 'recent'

const Watch = v.strictObject({ page: v.pipe(v.string(), v.minLength(1)) })

const Worker = v.strictObject({
  program: v.pipe(v.string(), v.minLength(1)),
  watch: v.pipe(v.array(Watch), v.minLength(1)),
})

export const FleetSpec = v.strictObject({
  origin: v.optional(v.pipe(v.string(), v.url())),
  intervalMs: v.optional(v.pipe(v.number(), v.minValue(50))),
  workers: v.pipe(v.array(Worker), v.minLength(1)),
})

export type FleetSpec = v.InferOutput<typeof FleetSpec>
export type FleetWorker = FleetSpec['workers'][number]

export function parseFleet(value: unknown): FleetSpec {
  return v.parse(FleetSpec, value)
}

/** The fleet you get with no file: every program, each watching the recent page. */
export function defaultFleet(programs: string[]): FleetSpec {
  return { workers: programs.map((program) => ({ program, watch: [{ page: RECENT_PAGE }] })) }
}
