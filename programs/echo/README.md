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
  write never moves the Page's content `heads` — so echo's own reply can
  never show up as a new `page.changed` event for it to react to.
- **Failures back off, they don't hot-loop.** A failed decide/write attempt
  doesn't retry on the very next poll — backoff starts at
  `SPECULATIVE_PAUSE_MS` and doubles (capped at 5 minutes). An aborted
  attempt is not a failure and doesn't count toward this.
- **Requires `KILO_API_KEY`.** Without it, `ctx.llm` is absent and `tick`
  is a no-op; `echo` still logs diffs as before.

```sh
KILO_API_KEY=... bun run up echo
```
