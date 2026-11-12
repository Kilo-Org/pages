# echo

Prints what changes on a page as it is edited:

```text
14:46:07.239 [echo:33945932] first sight of paragraph: "Hello wo"
14:46:07.651 [echo:33945932] +"rld"  → "Hello world"
```

```sh
bun run up echo
```

## How the data reaches the program

```text
browser (Wordgard + Automerge)    one local change per keystroke
   │  outbound sync batches: sends 30 ms after the last key, never waits more than 100 ms
   ▼
Page Durable Object (Pages host)  applies the batch and persists it; heads advance.
   ▲                              It emits no event.
   │  read_page_changes {since_heads}       called every 400 ms by us
   │
Pages: model/read-changes.mjs     projectReadChanges() diffs the document at since_heads
   │                              against now and returns the net result: one entry per
   ▼                              changed node, with its Markdown
packages/pages/src/page-changes-source.ts   (ours)
   │  heads differ → wrap the result as
   │  { id: "<pageId>@<heads>", type: "page.changed", changes: [...] }
   ▼
packages/host/src/runtime.ts      (ours) delivers the event, then saves the cursor
   ▼
programs/echo/index.ts            handle(event, ctx): diff each node's text against ctx.state
```

Who owns which step:

| Step | Owner |
| --- | --- |
| Keystrokes, batching, sync, persistence | Pages (browser and Page host) |
| `read_page_changes`: the net diff between two revisions | Pages (`model/read-changes.mjs`) |
| `page.changed`: the event, its id, the polling loop | this repo, `packages/pages` |
| The `PageChangedEvent` type | this repo, `packages/sdk` (types only, produces nothing) |
| Delivery, cursor, state | this repo, `packages/host` |
| The `+"rld"` delta | this program |

## What an event is, and is not

- **Not per character.** The browser batches keystrokes, `read_page_changes` returns
  the *net* result between two revisions, and we poll at most once per interval.
  Typing "abc" then deleting "b" between two polls yields "ac" with no trace of "b".
  Fast typing produces roughly one event per poll, each carrying the node's full
  current text.
- **Not a log.** `read_page_changes` is stateless and keeps no history. It reports no
  author (`attribution: "unavailable"`), so the program cannot tell who typed.
- **The deltas are computed here.** Each event carries a node's current Markdown. The
  program remembers the previous text of each node in `ctx.state` and diffs against
  it (`textDelta`). That is why a node the program has not seen yet prints
  `first sight` with its whole text, and deltas start from the second edit.
- **Empty events happen.** Heads can advance with no visible content change. The
  event then has an empty `changes` list and echo prints nothing for it.
- **Delivery is at-least-once.** The cursor (the heads last handled) is saved only
  after `handle` returns, so a crash replays the event. The id is stable across
  replays, so a program can deduplicate on it.

When Pages gets a real event feed, only the middle of the diagram changes: the poller
is replaced by a subscription that emits the same `page.changed` event. The program
does not change.

## Seeing comments and selections

The same poll also watches the page's two other user surfaces:

- **Comments.** `read_page_changes` is called with `comments: "all"` and the
  comments document's own `since_comment_heads`, so a comment-only change is a
  real event even when the Page's `heads` do not move. Each changed message
  carries its thread, body, and author.
- **Selections.** `read_page_presence` is an ephemeral snapshot with no server
  cursor. `packages/pages/src/presence-source.ts` fingerprints each attached
  selection locally and emits `selected` / `updated` / `cleared`. A selection
  is context, not a request: echo logs it and never replies to it on its own.
- **No self-replies.** The host reads `GET /whoami` once at startup and the
  source drops any comment or selection authored by that principal before the
  event is built. Echo's own comments can never re-enter its stream. If
  `whoami` fails, comment and presence watching is disabled rather than
  risking a loop.
- **Event identity.** The event id includes both document revisions and a local
  selection epoch, so comment-only and selection-only events deduplicate
  correctly across redeliveries while body-only ids stay stable.

## The room

Echo keeps one `room` value in `ctx.state`: the durable "what is being asked"
ledger plus the bookkeeping the executor needs.

- `intents` — one per target, with a unique id, `kind`, `status`, `version`,
  `targetScope`, `outputKind`, `confidence`, and evidence. A new admission
  after an abandoned intent keeps the old entry.
- `steps` — ordered work for one intent version: 1–30 steps with `kind`,
  `position`, and `dependsOn`. `new_action` and `correction` get a plan;
  `chat` and `clarify` do not. A version bump marks older steps `stale`;
  they are cancelled only when unowned.
- `targets` — per-node reply identity (`threadId`/`messageId`/`lastReply`),
  dedupe text, backoff, and the `generation` / `assumedIntentVersion` fence.
- `selections` — the latest person selection per peer, with one evidence ref
  per peer in the intent.

Triage creates the target's intent (action, correction, chat, or clarify);
a later change to an active target bumps its version. The first reply
attaches its thread to the intent. `attempt()` reads the model outside the
room lock, then re-checks text, generation, and intent version immediately
before writing. The lock covers the check and the write, not the model call,
so one slow draft does not block other targets.

PR 3's flat `nodes/*` records are migrated once into `room.targets` on first
read. While the room is introduced, changed target records are also written
back to their `nodes/*` keys, so a rollback to PR 3 keeps reply identity for
new writes. A deleted thread clears the target's reply identity so the next
edit creates a new thread instead of retrying an edit against a deleted one.

## Triaging before answering

The assistant is always watching. Every settled, non-empty change is
classified against the room, and none of them stays silent:

| Signal | Outcome |
| --- | --- |
| explicit correction language, or an edit overlapping an active intent | `correction` |
| a question | `chat` |
| request language ("please", add/fix/change/shorten/…) | `new_action` |
| hedged language ("maybe", "not sure", "should we") | ambiguous → one model classification call |
| any other statement, thought, or plan fragment | ambiguous → one model classification call |

`clarify` is the fallback when the classification model returns malformed
output. A clear correction never calls the classification model; it goes
straight to the answer generation call.

Rules read a lightly normalized copy of the text, with markdown emphasis,
code ticks, and leading escapes removed, so `**Does this work?**` is still
recognized as a question. The body classifier receives the previous text and
reply as context, and a body correction prompt carries the text the edit
replaced (`previousText`), so "make it shorter" has something to shorten.
If there is no previous text to work from, the model asks for it.

Generation follows triage instead of deciding again. Every outcome must
produce a reply or a short suggestion; there is no `respond: false` escape.
A missing reply is a failed attempt and retries with backoff, not silence.
`new_action` and `chat` answer, suggest, or ask one short clarifying
question, and a `correction` with no earlier reply acts on the previous text
or asks what to change. The only no-op is empty text.

For `new_action` and `correction`, echo asks the model for an ordered plan
through the `todo_write` tool, then the room validates and persists it.
`task` steps are the user-facing deliverables; `draft_reply`, `post_reply`,
and `edit_reply` are execution steps. A multi-part request should have one
task per deliverable, which becomes a visible checklist. A single-deliverable
request has no task steps, so it gets a normal reply.

For a body action with task steps, echo posts an unchecked checklist before
generation and edits the same message to the checked list plus the answer.
For a comment action, the threaded reply includes the checked list. The list
is not a separate page block: comments are the only visible write surface
today. The answer returns `completedTasks` keys, so a partial reply checks
only the tasks it finished and leaves the rest pending; `completed: false`
keeps everything unchecked. Hosts without `completeWithTools` fall back to
`draft → post` (or `draft → edit` for a body correction), which has no task
steps and therefore no checklist. Chat never gets a plan, so a knowledge
answer cannot become a hidden to-do item.

A plan that names unsupported work, repeats keys, or has a cycle is rejected.
`post_reply` and `edit_reply` are normalized to what the executor will do:
edit when a reply already exists, post otherwise. Draft and final writes use
different idempotency prefixes (`plan:` and `reply:`), so editing the
checklist cannot collide with the final edit.

A comment on an active thread is answered in that thread with
`replyToThread`, not by creating a new block comment. The handled message
body is recorded per thread, so a redelivered event cannot double-reply.
A failed comment generation creates no intent and bumps no version; the
retry starts clean and only records the intent when the reply succeeds.

## Replying to settled text, speculatively

Besides logging, `echo` watches for a block of text that reads like a
question or request, and replies with a block comment — started *before*
the author is necessarily done, not after a long fixed wait:

```text
14:46:15.812 [echo:33945932] replied in thread a1b2c3d4: "Yes — ..."
14:46:22.401 [echo:33945932] updated reply in thread a1b2c3d4: "Actually — ..."
```

- **Start early, not after a long quiet period.** `tick(ctx)` runs on every
  poll. A node becomes eligible for a *draft* once its text has sat
  unchanged for just `SPECULATIVE_PAUSE_MS` (1s, not the old 8s) and is at
  least a few characters long — "worth a guess now," not "the user is
  definitely done."
- **Or skip the pause entirely, if the text already looks finished.**
  `looksComplete()` checks for trailing sentence-ending punctuation
  (`?`/`.`/`!`). Text that already looks done starts a draft immediately,
  not after even the 1s pause — the actual "prediction": recognizing
  that a thought already looks complete, rather than guessing at one
  that isn't. A correction to already-complete-looking text triggers a
  new draft the same way, immediately, not after a pause — see the next
  point for what keeps that safe.
- **Abort on new input.** If the text changes again before a draft
  resolves, the in-flight model call is actually cancelled (an
  `AbortSignal` threaded into the fetch, not just a result thrown away) and
  nothing from it ever posts.
- **Commit only when the revision still matches.** The real correctness
  guarantee isn't the abort signal — it's a re-read of the node's current
  text right before committing. A draft only ever posts/edits if the text
  it was based on still matches current text at that instant; otherwise
  it's silently discarded, same as an explicit abort.
- **Decision.** One call to `ctx.llm.complete(...)` gets a strict-JSON
  `{ respond, reply }`.
- **Corrections update the existing reply, in place.** Once echo has
  replied to a block, any further change to that block is treated as a
  possible update to the *same* reply, not a new one — the model sees its
  own previous reply alongside the new text and, if it decides to update,
  writes the full replacement text, which `editMessage` applies to the
  same comment (`manage_page_comment action:edit`). One always-current
  answer per block, not a growing thread. This needs the editor to be the
  message's original author, so it only works as long as `echo` keeps
  using the same host identity across a node's lifetime (true today; worth
  knowing if that identity ever changes mid-session).
- **Dedup.** Each node remembers the exact text it last completed an
  attempt for (`evaluatedText`); the same settled text is never re-asked.
  Every comment write also carries a deterministic idempotency key, so a
  retried write after a crash replays the original receipt instead of
  posting or editing twice.
- **No self-reply loop.** `echo` never edits page content, and a comment
  write only moves the comments document. The source drops any comment
  authored by the host's own `/whoami` principal before the event is built,
  so echo's own reply can never show up as a new event for it to react to.
- **Failures back off, they don't hot-loop.** A failed decide/write attempt
  doesn't retry on the very next poll — backoff starts at
  `SPECULATIVE_PAUSE_MS` and doubles (capped at 5 minutes). An aborted
  attempt is not a failure and doesn't count toward this.
- **Requires `KILO_API_KEY`.** Without it, `ctx.llm` is absent and `tick`
  is a no-op; `echo` still logs diffs as before.

```sh
KILO_API_KEY=... bun run up echo
```

## Showing up before it has an answer

The model call in `attempt()` can take a second or more. Rather than staying
silent the whole time, `echo` publishes a "reading" caret on the block the
moment it starts deciding, via `ctx.presence.showReading(blockId)` — a UX
hint only, not a write that can fail the attempt. It's a best-effort call: any
rejection is swallowed, and it is never awaited before the real `ctx.llm`
call starts.

Under the hood this is a scoped `read_page({block_ids: [blockId]})`
(`packages/pages/src/reading-presence.ts`) — Pages already derives agent
presence from authorized calls it sees (`model/agent-presence.mjs`), so a
block-scoped read is enough to show a reading marker on that passage for a
few seconds, with no dedicated presence-write endpoint needed. It only shows
up for API-credentialed hosts (an API key or MCP OAuth) — a host signed in
the way a browser is (the local-dev default, no `PAGES_TOKEN`) publishes
nothing, same as a person's own editor never shows their own caret back to
them.
