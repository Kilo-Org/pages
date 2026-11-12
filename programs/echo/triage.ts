// Deterministic first: is this a new request, a correction to work in flight,
// or just conversation? The model is a classification fallback only when the
// language signals disagree.
import type { CommentChange, LlmTool, LlmToolCall } from '@pages-programs/sdk'
import {
  findActiveIntentForTarget,
  findIntentForBlock,
  findIntentForThread,
  STEP_KINDS,
  validatePlanSteps,
  type Intent,
  type IntentKind,
  type PlanStepInput,
  type RoomState,
  type StepKind,
} from './room.ts'

export type TriageOutcome = 'new_action' | 'correction' | 'chat' | 'clarify' | 'ignore'

export type Triage = {
  outcome: TriageOutcome
  intentId: string | null
  confidence: number
  reason: string
  source: 'rules' | 'model'
}

export type Ambiguous = { ambiguous: true; signals: string[] }

const QUESTION =
  /(\?\s*$)|^\s*(who|what|when|where|why|how|can|could|would|should|is|are|do|does|did|will)\b/i
const REQUEST =
  /\b(please|add|fix|change|make|remove|update|tighten|rewrite|rephrase|shorten|expand|explain|clarify|use|switch|rename|delete|move|turn|replace|adjust|summari[sz]e|list|describe|show|give|write|draft|outline)\b/i
const CORRECTION =
  /\b(actually|instead|not|no|wrong|rather|i meant|should be|change that|make that|that's not)\b/i
const HEDGE = /\b(maybe|perhaps|consider|might|should we|could we|i wonder|not sure|possibly)\b/i

const MIN_CHARS = 3

/** Strip the markdown wrappers that hide a question or request from the rules. */
const signalText = (text: string) =>
  text
    .trim()
    .replace(/^(?:\\+\s*)+/, '')
    .replace(/^[\s*_~`#>]+/, '')
    .replace(/[\s*_~`]+$/, '')
    .trim()

const decision = (
  outcome: TriageOutcome,
  intent: Intent | undefined,
  confidence: number,
  reason: string,
): Triage => ({
  outcome,
  intentId: intent?.id ?? null,
  confidence,
  reason,
  source: 'rules',
})

/** A body edit. Overlapping an active target intent usually means correction. */
export function triageBody(
  text: string,
  room: RoomState,
  targetKey: string,
): Triage | Ambiguous {
  const trimmed = signalText(text)
  if (trimmed.length < MIN_CHARS) return decision('ignore', undefined, 0.9, 'too short')
  const intent = findActiveIntentForTarget(room, targetKey)
  if (CORRECTION.test(trimmed)) return decision('correction', intent, 0.85, 'correction language')
  if (QUESTION.test(trimmed)) return decision('chat', intent, 0.8, 'question')
  if (REQUEST.test(trimmed)) return decision('new_action', intent, 0.75, 'request language')
  if (HEDGE.test(trimmed)) return { ambiguous: true, signals: ['hedged request'] }
  if (intent) return decision('correction', intent, 0.6, 'overlaps an active intent')
  return decision('ignore', undefined, 0.6, 'statement, not addressed to an agent')
}

/** A comment or reply. A thread tied to an intent is the strongest signal. */
export function triageComment(change: CommentChange, room: RoomState): Triage | Ambiguous {
  if (change.change === 'deleted') return decision('ignore', undefined, 1, 'thread deleted')
  const text = signalText(change.body ?? '')
  if (text.length < MIN_CHARS) return decision('ignore', undefined, 0.9, 'too short')
  const intent =
    findIntentForThread(room, change.threadId) ??
    (change.blockId ? findIntentForBlock(room, change.blockId) : undefined)
  if (CORRECTION.test(text)) return decision('correction', intent, 0.85, 'correction language')
  if (QUESTION.test(text)) return decision('chat', intent, 0.8, 'question')
  if (REQUEST.test(text)) return decision('new_action', intent, 0.75, 'request language')
  if (HEDGE.test(text)) return { ambiguous: true, signals: ['hedged request'] }
  if (intent) return decision('correction', intent, 0.6, 'reply on an active intent')
  return decision('ignore', undefined, 0.6, 'statement, not addressed to an agent')
}

export function kindFor(outcome: TriageOutcome): IntentKind | null {
  if (outcome === 'new_action') return 'action'
  if (outcome === 'correction') return 'correction'
  if (outcome === 'chat') return 'chat'
  if (outcome === 'clarify') return 'clarify'
  return null
}

export const TRIAGE_SYSTEM_PROMPT = [
  'Classify one user change on a collaborative page for an assistant.',
  'Outcomes: new_action (a new request), correction (a change to work already underway),',
  'chat (a question or conversational turn worth answering), clarify (intent is unclear),',
  'ignore (not addressed to the assistant).',
  'Return strict JSON only, no prose, no code fences:',
  '{"outcome": string, "intentId": string or null, "confidence": number from 0 to 1, "reason": string}.',
].join(' ')

export const TODO_WRITE_TOOL: LlmTool = {
  name: 'todo_write',
  description: 'Create or replace the ordered plan for the current intent version.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 30,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', description: 'Short unique key for this step.' },
            kind: {
              type: 'string',
              enum: [...STEP_KINDS],
              description:
                'task is a visible deliverable; draft_reply produces response text; post_reply posts it; edit_reply replaces an existing reply.',
            },
            description: { type: 'string', description: 'What this step does, in one sentence.' },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keys of steps that must finish first.',
            },
          },
          required: ['key', 'kind', 'description'],
        },
      },
    },
    required: ['steps'],
  },
}

export const PLAN_SYSTEM_PROMPT = [
  'You plan the work for one assistant intent on a collaborative page.',
  'Call todo_write exactly once with an ordered plan of 1-30 steps.',
  'Use task for each distinct user-facing deliverable that should appear in a visible checklist.',
  'If the request enumerates items (comma-separated or numbered), create one task per item.',
  'Never collapse an enumerated list into a single "complete all items" task.',
  'Use draft_reply, post_reply, and edit_reply for the execution steps.',
  'A multi-part request should have one task per part; a single-deliverable request should have no task steps.',
  'Do not invent steps the assistant cannot perform. Use dependsOn to order steps.',
  'Keep task descriptions short and concrete; keep execution descriptions brief.',
].join(' ')

/** Parse the one supported tool call. Anything malformed becomes a deterministic fallback plan. */
export function parseTodoWriteCall(call: LlmToolCall): PlanStepInput[] | null {
  if (call.name !== 'todo_write') return null
  const args = call.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const rawSteps = (args as Record<string, unknown>).steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > 30) return null
  const steps: PlanStepInput[] = []
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const step = raw as Record<string, unknown>
    if (typeof step.key !== 'string') return null
    if (typeof step.kind !== 'string' || !STEP_KINDS.includes(step.kind as StepKind)) return null
    if (typeof step.description !== 'string') return null
    if (
      step.dependsOn !== undefined &&
      (!Array.isArray(step.dependsOn) || step.dependsOn.some((dep) => typeof dep !== 'string'))
    )
      return null
    steps.push({
      key: step.key,
      kind: step.kind as StepKind,
      description: step.description,
      ...(step.dependsOn ? { dependsOn: step.dependsOn as string[] } : {}),
    })
  }
  return validatePlanSteps(steps) ? null : steps
}

export function triagePrompt(
  surface: 'body' | 'comment',
  text: string,
  room: RoomState,
  targetKey: string | null,
): string {
  const active = Object.values(room.intents)
    .filter((intent) => intent.status === 'active')
    .slice(0, 10)
    .map((intent) => ({
      id: intent.id,
      kind: intent.kind,
      scope: intent.targetScope,
      version: intent.version,
    }))
  return JSON.stringify({ surface, text, targetKey, activeIntents: active })
}

export function parseTriage(raw: string): Triage {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/```$/, '')
    .trim()
  const parsed: unknown = JSON.parse(cleaned)
  if (typeof parsed !== 'object' || parsed === null || !('outcome' in parsed))
    throw new Error(`malformed triage: ${cleaned.slice(0, 200)}`)
  const { outcome, intentId, confidence, reason } = parsed as {
    outcome?: unknown
    intentId?: unknown
    confidence?: unknown
    reason?: unknown
  }
  if (!['new_action', 'correction', 'chat', 'clarify', 'ignore'].includes(String(outcome)))
    throw new Error(`malformed triage outcome: ${String(outcome)}`)
  return {
    outcome: outcome as TriageOutcome,
    intentId: typeof intentId === 'string' ? intentId : null,
    confidence:
      typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? confidence : 0.5,
    reason: typeof reason === 'string' ? reason : 'model classification',
    source: 'model',
  }
}
