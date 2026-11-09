# pages

Prototype: small TypeScript programs that react to events from a Pages
instance. Directionally they are Dynamic Worker modules; today a Bun script
stands in for the host.

The `echo` program prints what changes on a page as you type:

```text
14:44:06.758 watching Test @ 4afbc644 as "echo"
14:46:07.239 first sight of paragraph: "Hello wo"
14:46:07.651 +"rld"  → "Hello world"
```

## Quick start

Needs [Bun](https://bun.sh), a Pages instance running locally
(`npm run dev` in the Pages checkout, or `celld dev`), and at least one page
in the local account. Create one in the browser first.

```sh
bun install
bun run echo
```

That is all. No environment variables, no API key and no sign-in step are
needed against a local instance. With no `--page` given, the program watches
your most recently edited page and logs which one it picked, so edit a page
(or pass `--page`) to choose it.

## Configuration

Every setting has a default aimed at a local Pages dev server. Nothing is
discovered: the port is simply the default origin, `http://localhost:9894`,
which is where the Pages dev server listens unless `PAGES_PORT` is set on
that side. If your instance runs elsewhere, say so.

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| Pages server | `--origin URL` | `PAGES_ORIGIN` | `http://localhost:9894` |
| Page to watch | `--page ID` | `PAGES_PAGE_ID` | the account's most recently edited page |
| Poll interval | `--interval MS` | | `400` |
| Forget saved cursor and state | `--fresh` | | off |
| API key (bearer) | | `PAGES_TOKEN` | unset: local sign-in |

A flag beats its environment variable, which beats the default.

```sh
bun run echo -- --origin http://localhost:9895 --page <page-id>
PAGES_ORIGIN=https://pages.example.com PAGES_TOKEN=... bun run echo -- --page <page-id>
```

The page ID is the UUID in the page's URL: `http://localhost:9894/p/<page-id>`.
Nothing is hardcoded. When `--page` and `PAGES_PAGE_ID` are both unset, the
host calls `list_pages` (sorted by activity) and takes the first result. If the
account has no pages it exits with a message. Pass `--page` for anything you
want pinned, since "most recent" changes as you edit other pages.

### How it authenticates

- **Without `PAGES_TOKEN`** the host signs in the way a browser would. A local
  Pages instance runs a loopback OIDC issuer that approves automatically, so
  the host follows its redirects and receives a session cookie for the local
  developer (`dev@localhost`). The cookie lasts six hours; the host signs in
  again on a 401. This only works against a local instance, and it is the same
  account your browser uses locally, so the pages you own are visible to it.
- **With `PAGES_TOKEN`** the host sends `Authorization: Bearer <token>`. Use an
  Anaconda API key from the instance's `/connect` page. Keep it out of the
  repo and the shell history where you can.

## State

The host saves the cursor and the program's state to
`.state/<program>/<page-id>.json` (git-ignored) after each handled event. A
restart resumes from the saved heads and catches up on what changed while it
was down. `--fresh` deletes the file first.

## Development

```sh
bun run check    # typecheck, tests, portability check
bun test         # tests only
```

`bun run check:portable` bundles the portable files for a browser target and
fails on `node:`, `bun:`, `Bun.` or `process.` usage, which keeps programs
loadable as Dynamic Workers.

## Layout

| File | Role | Portable to a Worker |
| --- | --- | --- |
| `src/program.ts` | `Program` contract: manifest, `key`, `handle(event, ctx)` | yes |
| `src/programs/echo.ts` | The program: logs the text delta of each change | yes |
| `src/page-changes-source.ts` | Polls `read_page_changes`, emits `page.changed` events | yes |
| `src/pages-client.ts` | `fetch`-only client for `/api/tools` | yes |
| `src/host/runtime.ts` | The loop, cursor and state a host owns | replaced by a Durable Object |
| `src/host/run-local.ts`, `local-signin.ts`, `resolve-page.ts` | Bun wiring, file store, local sign-in, default page choice | no |

## Known limits

- Pages has no event feed. `read_page_changes` is a net diff, so keystrokes
  between two polls arrive as one `page.changed` event, and a change shows up
  only after the browser's edit reaches the Pages host.
- The first edit of a node the program has not seen yet is reported as
  `first sight`; deltas follow from the second edit on.
- Event ids are `pageId@heads`, stable across redelivery. The cursor is saved
  only after the handler returns (at-least-once).
- Only one page is watched per process, and the page is chosen once at startup.
