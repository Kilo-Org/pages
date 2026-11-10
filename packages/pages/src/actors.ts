// Author labels on comments and presence are not verified identity. The only
// trustworthy signal is the host's own principal; everything else is a hint.
import type { ActorKind, ChangePriority } from '@pages-programs/sdk'

const AGENT_DRIVER = /agent|kilo|mcp|claude|codex/i

export function actorKindFor(
  principal: string | null,
  driver: string | null,
  ownPrincipal: string | null,
): ActorKind {
  if (principal) {
    if (ownPrincipal && principal === ownPrincipal) return 'agent'
    return driver && AGENT_DRIVER.test(driver) ? 'agent' : 'person'
  }
  return driver && AGENT_DRIVER.test(driver) ? 'agent' : 'unknown'
}

export function userPriority(kind: ActorKind): ChangePriority {
  if (kind === 'person') return 1
  if (kind === 'agent') return 3
  return 2
}
