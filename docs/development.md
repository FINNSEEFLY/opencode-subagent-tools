# Development

## Dependencies

The plugin imports only `@opencode/plugin` plus Node built-ins:

```ts
import { Plugin, Skill } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
```

- `@opencode/plugin` is the plugin API package; see the README for the supported OpenCode V2 version. It ships the Promise plugin API used here (`Plugin.define`, `ctx.tool.transform`, `ctx.event`, `ctx.session`, `ctx.permission`, `ctx.model`, `ctx.skill`, `ctx.options`), including the typed `ctx.session.list`.
- At runtime **OpenCode resolves `@opencode/plugin` itself**, so a user who copies the package into a plugins directory does not need to install anything for the plugin to work.
- `package.json` declares `@opencode/plugin` as an **optional peer dependency** (and as a dev dependency for local typechecking and tests), not a bundled runtime dependency. OpenCode provides it at runtime, so installing the plugin does not need to pull in a second copy.
- There are **no third-party runtime dependencies** in the plugin source.
- `ctx.session.list` is required. `setup` fails with a clear error on a build that does not expose it; there is no event-only fallback.
- The optional `limits` options are validated and clamped in `config.ts`; see [configuration](configuration.md) for the public defaults and ranges.

## Source layout

`src/index.ts` is the composition root. It resolves configuration, constructs the runtime services, registers tools and the skill, starts the event stream, and returns the cleanup function. Domain modules own one concept each:

| Module           | Owns                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `config.ts`      | Public `Options`/`Limits`, defaults, and clamping                       |
| `status.ts`      | Status vocabulary and session-record status derivation                  |
| `session.ts`     | Session-shaped types and `session.list` response adapters               |
| `live-state.ts`  | Process-local live evidence and freshness rules                         |
| `session-row.ts` | `SessionRow` projection used by discovery and tools                     |
| `discovery.ts`   | Bounded subtree walk and row discovery                                  |
| `access.ts`      | `session.get` read-back and parent-chain ownership verification         |
| `permissions.ts` | `subagent.control` permission gate                                      |
| `messages.ts`    | Shared steer/queue/context admission path                               |
| `interrupt.ts`   | Shared interrupt outcome mapping                                        |
| `cursor.ts`      | Opaque paging cursor encode/decode/compare                              |
| `tokens.ts`      | Token normalization, totals, context formula, usage schema              |
| `format.ts`      | Human-readable age, cost, and compact-number formatting                 |
| `text.ts`        | Clipping, Unicode length, control-character, and length-error helpers   |
| `errors.ts`      | `Tool.Error` helper and the OpenCode capability message                 |
| `events.ts`      | Event names, reducer, reconnect loop                                    |
| `skill.ts`       | Bundled `SKILL.md` parsing and registration                             |
| `tools/*.ts`     | Tool registration grouped by shared behavior, plus input/output helpers |

`SKILL.md` sits at the package root, beside `src/`; `skill.ts` resolves it with `new URL("../SKILL.md", import.meta.url)`.

## Tests

The suite lives in `tests/` and mirrors the feature areas: `list`, `usage`, `actions`, `status`, `mutations`, `permissions`, `policy`, `cancel-descendants`, `discovery`, and `options`, plus focused unit tests for config, cursor, events, messages, output, schema validation, and tokens. `tests/harness.ts` builds the mocked plugin context and registers the per-test cleanup hook. Tests exercise the plugin through its public `setup`/tool surface.

CI runs the unit suite only. Loading the packed package into a real OpenCode server is a manual release check, not a CI job.

`tests/`, `.oxlintrc.json`, and `bun.lock` are repository-only; the npm package ships the source tree, `SKILL.md`, `SECURITY.md`, and the user-facing docs.

## Commands

```sh
bun install
bun run lint
bun run format:check
bun run typecheck
bun test
```

`bun run check` runs lint, format checking, typecheck, and the test suite. `bun run format` rewrites files with Prettier. The lint configuration is in `.oxlintrc.json`; it enables Oxlint's `correctness` and `suspicious` categories plus the `Reflect` restriction.

The tests cover:

- Discovery through `ctx.session.list`: pagination, depth/node/page limits, bare arrays, malformed responses, failures, and incomplete-discovery warnings.
- Status filtering and cursor pagination for `list`: `known`/`matching`/`window`/`remaining`, empty-status rejection, new children between pages, and cursor scoping.
- `cancel_descendants`: `targets`, `remaining`, cursor, before-cursor running children, abort, and failed/unknown/read-back outcomes.
- Configurable limits, `sessionControlPolicy` modes, and ancestor verification, including depth exhaustion reported as unverified.
- Cancellation, steering, queueing, and context injection.
- Usage freshness markers (`usageMayLag` and tree), context unavailable/zero handling, and `Tool.Error` refusals.
- Live status and freshness (`activeAt`), stale live terminal reconciliation, out-of-order event rejection, event-stream reconnect, and event subscription filtering.
- Permission routing and denial identity, cleanup, and the `ctx.session.list` capability guard.

Discovery, ownership checks, interrupts, prompt/synthetic admission, and read-backs accept the tool's `context.signal`; stopping a tool call stops the underlying work where the client supports it.
