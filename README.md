# pages

Prototype: a fleet of small TypeScript programs that react to events from a
Pages instance. Each program is written so it can later load as a Dynamic
Worker; today a Bun process stands in for the host.

```text
14:53:11.943 [echo:f0fee042] first sight of paragraph: "one two"
14:53:11.946 [tally:f0fee042] edit batch #1: 1 change(s)
14:53:13.571 [echo:f0fee042] +" three"  → "one two three"
14:53:13.575 [tally:f0fee042] edit batch #2: 1 change(s)
```

## Quick start

Needs [Bun](https://bun.sh), a Pages instance running locally (`npm run dev` in
the Pages checkout, or `celld dev`), and at least one page in the local account.

```sh
bun install
bun run up                 # start every program in fleet.yaml
bun run up echo            # start only some
bun run pp list            # programs, their triggers, what the fleet has them watch
```

No environment variables, API key or sign-in step are needed against a local
instance.

## Layout

```text
packages/
  sdk/        @pages-programs/sdk    what a program imports: defineProgram, event and context types
  pages/      @pages-programs/pages  Pages client and the polling event source (fetch only)
  host/       @pages-programs/host   runtime loop, fleet spec, supervisor and the `pp` CLI (Bun only)
programs/
  echo/       one folder per program: index.ts default-exports defineProgram(...)
  tally/
fleet.yaml    which programs run and what each one watches
scripts/      the portability and boundary check
```

Programs are folders, not packages. Promote one to its own package only when it
needs npm dependencies of its own. The boundary that matters is enforced
instead: `bun run check:portable` bundles every program for a browser target
and fails if it

- imports anything but its own folder and `@pages-programs/sdk` (not the host,
  the Pages client or another program), or
- touches `node:`, `bun:`, `Bun.` or `process.`.

Whatever a program needs from the outside world arrives on `ctx`. That keeps
every program loadable in a bare Worker isolate.

## Adding a program

1. Create `programs/<name>/index.ts` and default-export
   `defineProgram({ manifest: { name: '<name>', triggers: ['page.changed'] }, key, handle })`.
   `manifest.name` must equal the folder name.
2. Add it to `fleet.yaml`.
3. `bun run check` and `bun run up <name>`.

## The fleet

`fleet.yaml` is data, validated with Valibot (`packages/host/src/fleet.ts`),
not a script. That is what lets a control plane create, store and diff fleets
later without running anything.

```yaml
origin: http://localhost:9894   # optional
intervalMs: 400                 # optional poll interval
workers:
  - program: echo
    watch:
      - page: recent            # a page id (the UUID in /p/<id>) or "recent"
  - program: tally
    watch:
      - page: <page-id>
```

`bun run up` starts one loop per (worker, watched page), all in one process and
sharing one authenticated client. An instance that fails to start or keeps
failing is logged and left behind; the rest keep running. With no
`fleet.yaml`, every program in `programs/` runs against `recent`.

`recent` calls `list_pages` sorted by activity and takes the first result, so it
follows whichever page you edited last. Pin an id for anything stable.

### Settings

A flag beats an environment variable, which beats `fleet.yaml`, which beats the
default.

| Setting | Flag | Environment | Fleet file | Default |
| --- | --- | --- | --- | --- |
| Pages server | `--origin URL` | `PAGES_ORIGIN` | `origin` | `http://localhost:9894` |
| Poll interval | `--interval MS` | | `intervalMs` | `400` |
| Fleet file | `--fleet FILE` | | | `fleet.yaml` |
| Override every selected worker's page | `--page ID` | | | |
| Forget saved cursors and state | `--fresh` | | | off |
| API key (bearer) | | `PAGES_TOKEN` | | unset: local sign-in |
| Kilo AI Gateway key | | `KILO_API_KEY` | | unset: `ctx.llm` absent, programs that use it no-op |
| Kilo model id | | `KILO_MODEL` | | `anthropic/claude-haiku-5.5` (fast/cheap; set `KILO_MODEL=kilo-auto/free` if your account has no credits) |
| Kilo org id | | `KILO_ORG_ID` | | unset. Needed if your `KILO_API_KEY` is shared across multiple orgs — scopes the request to the one with the balance you want to use. Find it in the app.kilo.ai URL after selecting that org. |

The port is not discovered. `localhost:9894` is only the default origin, so
point `--origin` at an instance running elsewhere.

### Authentication

- **Without `PAGES_TOKEN`** the host signs in as a browser would. A local Pages
  instance runs a loopback OIDC issuer that approves automatically, so the host
  follows its redirects and gets a session cookie for the local developer
  (`dev@localhost`), valid six hours and renewed on a 401. This only works
  against a local instance and is the same account your browser uses locally.
- **With `PAGES_TOKEN`** the host sends `Authorization: Bearer <token>`. Use an
  Anaconda API key from the instance's `/connect` page.

## State

Each instance saves its cursor and program state to
`.state/<program>/<page-id>.json` (git-ignored) after every handled event. A
restart resumes from the saved heads and catches up on what changed while it
was down. The cursor advances only after the handler returns, so delivery is
at-least-once.

## Toward Dynamic Workers

| Today | Later |
| --- | --- |
| `packages/host/src/runtime.ts` loop per instance, in one process | one supervisor Durable Object per (program, page) holding inbox, cursor and alarms |
| `programs/<name>/index.ts` imported by path | bundled (`Bun.build`, as the check already does), stored by digest, loaded through a Worker Loader |
| `fleet.yaml` on disk | the same `FleetSpec` created and stored through an API |
| `ctx` is `log`, `state`, `llm` and `comments` | `ctx` carries further capability objects (tasks, etc.) that hold the credentials |
| polling `read_page_changes` | a real event feed from the Pages host, behind the same `page.changed` event |

## Development

```sh
bun run check    # typecheck, tests, portability and boundary check
bun test         # tests only
```

## Known limits

- Pages has no event feed. `read_page_changes` is a net diff, so keystrokes
  between two polls arrive as one `page.changed` event, and a change shows up
  only after the browser's edit reaches the Pages host.
- The first edit of a node a program has not seen yet is reported by `echo` as
  `first sight`; deltas follow from the second edit on.
- Event ids are `pageId@heads`, stable across redelivery.
- Page ids in `fleet.yaml` are resolved once at startup.
