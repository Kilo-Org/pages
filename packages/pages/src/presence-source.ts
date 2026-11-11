// Turns the ephemeral page-presence snapshot into selection changes.
//
// Presence has no revision or durable cursor, and the Pages API is explicit
// that a selection does not prove someone is typing. We diff fingerprints
// locally and treat the result as context, never as a request.
import * as v from 'valibot'
import type { PagesClient } from './client.ts'
import { actorKindFor, userPriority } from './actors.ts'
import type { SelectionChange } from '@pages-programs/sdk'

export type SelectionSnapshot = {
  blockId: string
  kind: 'caret' | 'selection' | null
  startUtf16: number | null
  endUtf16: number | null
  quote: string | null
  principal: string
  displayName: string | null
  driver: string | null
  observedAt: string
}

/** Local, serializable presence cursor: no server revision exists. */
export type SelectionCursor = {
  epoch: number
  seen: Record<string, SelectionSnapshot>
}

export const emptySelectionCursor = (): SelectionCursor => ({ epoch: 0, seen: {} })

const Selection = v.object({
  block_id: v.string(),
  status: v.string(),
  kind: v.optional(v.nullable(v.string())),
  start_utf16: v.optional(v.nullable(v.number())),
  end_utf16: v.optional(v.nullable(v.number())),
  quote: v.optional(v.nullable(v.string())),
})

const Participant = v.object({
  peer_id: v.string(),
  principal: v.string(),
  displayName: v.optional(v.nullable(v.string())),
  driver: v.optional(v.nullable(v.string())),
  last_seen: v.optional(v.nullable(v.string())),
  selection: v.optional(v.nullable(Selection)),
})

const Presence = v.object({
  participants: v.optional(v.array(Participant)),
})

const fingerprint = (snapshot: SelectionSnapshot) =>
  JSON.stringify([
    snapshot.blockId,
    snapshot.kind,
    snapshot.startUtf16,
    snapshot.endUtf16,
    snapshot.quote,
  ])

export type PollSelectionsResult = {
  cursor: SelectionCursor
  changes: SelectionChange[]
  epoch: number
}

/**
 * Reads one presence snapshot and emits only new/changed/cleared selections.
 * Throws on a failed read; callers treat that as a skipped tick, not a poll
 * failure.
 */
export async function pollSelections(
  client: PagesClient,
  pageId: string,
  cursor: SelectionCursor,
  ownPrincipal: string | null,
  now: () => Date = () => new Date(),
): Promise<PollSelectionsResult> {
  const raw = await client.call('read_page_presence', { page_id: pageId })
  const presence = v.parse(Presence, raw)
  const at = now().toISOString()
  const changes: SelectionChange[] = []
  const seen: Record<string, SelectionSnapshot> = { ...cursor.seen }
  const present = new Set<string>()

  for (const participant of presence.participants ?? []) {
    if (ownPrincipal && participant.principal === ownPrincipal) continue
    const selection = participant.selection
    if (!selection || selection.status !== 'attached') continue
    present.add(participant.peer_id)
    const snapshot: SelectionSnapshot = {
      blockId: selection.block_id,
      kind: selection.kind === 'caret' ? 'caret' : selection.kind === 'selection' ? 'selection' : null,
      startUtf16: selection.start_utf16 ?? null,
      endUtf16: selection.end_utf16 ?? null,
      quote: selection.quote ?? null,
      principal: participant.principal,
      displayName: participant.displayName ?? null,
      driver: participant.driver ?? null,
      observedAt: participant.last_seen ?? at,
    }
    const before = cursor.seen[participant.peer_id]
    if (before && fingerprint(before) === fingerprint(snapshot)) continue
    const kind = actorKindFor(snapshot.principal, snapshot.driver, ownPrincipal)
    changes.push({
      surface: 'selection',
      change: before ? 'updated' : 'selected',
      peerId: participant.peer_id,
      principal: snapshot.principal,
      displayName: snapshot.displayName,
      driver: snapshot.driver,
      blockId: snapshot.blockId,
      kind: snapshot.kind,
      startUtf16: snapshot.startUtf16,
      endUtf16: snapshot.endUtf16,
      quote: snapshot.quote,
      observedAt: snapshot.observedAt,
      actorKind: kind,
      priority: userPriority(kind),
    })
    seen[participant.peer_id] = snapshot
  }

  for (const [peerId, before] of Object.entries(cursor.seen)) {
    if (present.has(peerId)) continue
    const kind = actorKindFor(before.principal, before.driver, ownPrincipal)
    changes.push({
      surface: 'selection',
      change: 'cleared',
      peerId,
      principal: before.principal,
      displayName: before.displayName,
      driver: before.driver,
      blockId: before.blockId,
      kind: before.kind,
      startUtf16: before.startUtf16,
      endUtf16: before.endUtf16,
      quote: before.quote,
      observedAt: at,
      actorKind: kind,
      priority: userPriority(kind),
    })
    delete seen[peerId]
  }

  return {
    cursor: { epoch: cursor.epoch + (changes.length ? 1 : 0), seen },
    changes,
    epoch: cursor.epoch + (changes.length ? 1 : 0),
  }
}
