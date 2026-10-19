# Tool reference

The plugin registers seven tools under a namespace. With the default namespace `subagent`, the names are `subagent_list`, `subagent_usage`, `subagent_cancel`, `subagent_cancel_descendants`, `subagent_steer`, `subagent_queue`, and `subagent_context`.

The prefix follows the plugin's `namespace` option. OpenCode normalizes unsupported characters in names and namespaces to `_`.

Inputs marked `?` are optional; unknown properties are rejected.

- When `allowedOutputFormats` allows both formats (the default), every tool accepts `format`; see [Text vs JSON](#text-vs-json).
- Mutations follow the targeting rules in the [security model](security-model.md).
- For operational guidance, see the bundled `SKILL.md`.

## list

List discovered sessions in a subtree, newest launch first. Read-only.

### Inputs

| Name       | Type      | Default            | Notes                                                                                                                   |
| ---------- | --------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `parentID` | string?   | caller             | Any session ID is accepted.                                                                                             |
| `statuses` | string[]? | all five           | `running`, `stopped`, `failed`, `finished`, or `unknown`. An empty array, an unknown value, or a non-array is rejected. |
| `limit`    | integer?  | `maxListRows` (20) | 1 to `maxListRows`; values outside this range are rejected.                                                             |
| `cursor`   | string?   | —                  | From a previous `list` call; pass it back unchanged.                                                                    |

### Output

Text output is one row per session plus summary and warning lines. JSON output contains:

- `root` — subtree root: the caller or `parentID`.
- `statuses` — applied status filter.
- `discoveryComplete` — whether discovery walked the whole subtree, not whether all rows fit on this page.
- `warning?` — set when discovery was incomplete.
- `known` — all discovered sessions before the status filter and cursor.
- `matching` — matches in the current discovery pass, before the cursor.
- `window` — matches after the cursor; equals `matching` on the first page.
- `remaining` — matches in the window not returned on this page.
- `remainingPages` — pages left in the cursor walk.
- `cursor?` — cursor for the next page.
- `counts` — counts for all five statuses across all discovered sessions, before the filter and cursor.
- `rows[]` — one entry per session:
  - `id`, `parentID?`, `agent?`, `title?`, `titleTruncated?` (true when the title was truncated).
  - `status`, `ageSeconds?` (omitted when the launch time is unknown), `launchedAt`.
  - `usageMayLag?` — true when the row is running or unknown.
  - `usage?` — `costUSD?`, `tokens?`, and `tokensUsed?` when the server provides them.

### Errors and edge cases

- A malformed or unreadable `parentID` returns `Tool.Error`.
- If the caller is unknown and `parentID` is omitted, the tool returns `Tool.Error`.
- An invalid cursor returns `Tool.Error`; a cursor is bound to the tool, root, and status filter.
- Aborting discovery returns `Tool.Error` instead of a partial result.
- An empty result does not prove that no subagents exist. See [limitations](limitations.md).
- A new child can increase `known` and `matching` without appearing in the current cursor walk; re-run without a cursor to include it.

## usage

Read cost, tokens, current context, and status for a session. Read-only.

### Inputs

| Name                 | Type     | Default | Notes                                                  |
| -------------------- | -------- | ------- | ------------------------------------------------------ |
| `sessionID`          | string   | —       | Required. Any session ID is accepted.                  |
| `includeDescendants` | boolean? | `false` | Adds `tree` totals for the target and its descendants. |

### Output

Text output is a summary. JSON output contains:

- `sessionID`, `parentID?`, `status`.
- `usageMayLag?` — true when the session is running or unknown; values are as of the last persisted step.
- `costUSD?` — the session's own cost, not a family total.
- `tokens?` — cumulative `input`, `output`, `reasoning`, `cache.read`, and `cache.write`.
- `tokensUsed?` — cumulative `input + output + reasoning`.
- `contextTokens?` — the last assistant step after the last completed compaction: `input + output + reasoning + cache.read + cache.write`. `0` is legitimate; the field is omitted when context is unavailable, with `warning`.
- `lastRequest?` — `input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`, and `total` for that step.
- `contextLimit?` — when the session's model and its catalog context limit are available.
- `contextPercent?` — when both `contextLimit` and `contextTokens` are available.
- `model?` — `id`, `providerID?`, and `variant?` when known.
- `tree?` — with `includeDescendants: true`:
  - `sessions` includes the target; `descendants` excludes it.
  - `costUSD`, `tokens`, and `tokensUsed` include the target. `tokensUsed` is omitted when no session in the tree reports token data.
  - `discoveryComplete` covers the descendant walk.
  - `descendantsMayLag?` flags running or unknown descendants.
  - `warning?` marks incomplete discovery; it is also mirrored at the top-level `warning`.
- `warning?` — set when context could not be read or discovery was incomplete.

When no tree token data is available, `tree.tokens` and `tree.tokensUsed` are omitted and the tree summary prints `used=unknown`.

### Errors and edge cases

- An unknown session returns `Tool.Error`.
- Aborting a context, usage, or tree read returns `Tool.Error`.
- The caller's own status is `running` while the tool executes.
- Re-query after the step completes or after cancellation when `usageMayLag` is true.
- `contextTokens` is the current context; `tokens` and `tokensUsed` are cumulative.
- `costUSD` is the session's own cost; use `includeDescendants: true` and `tree.costUSD` for a family total.

## cancel

Stop one session with a soft interrupt.

### Inputs

| Name        | Type    | Default | Notes                                                                     |
| ----------- | ------- | ------- | ------------------------------------------------------------------------- |
| `sessionID` | string  | —       | Required. Target session ID.                                              |
| `reason`    | string? | —       | Up to 500 characters. Recorded in the result; not delivered to the child. |

### Output

Text output reports the interrupt result, the current state, and a lag note. JSON output contains:

- `sessionID`, `accepted`, `interrupt`.
- `interrupt` — `accepted` (the server accepted), `rejected` (no active execution), or `unknown` (no definitive server answer; an abort during the interrupt is a `Tool.Error`).
- `accepted` — alias for `interrupt === "accepted"`.
- `status` — status after the interrupt and status check.
- `reason?` — the recorded reason.
- `readBackMayLag` — true when the interrupt was accepted and the status check after cancellation still reports `running` or `unknown`.
- `cancellationDoesNotCascade` — always `true`; cancellation is non-cascading, not a claim that the target has no children.
- `costUSD?`, `tokens?`, `tokensUsed?` — usage after the interrupt.

### Errors and edge cases

- An unknown target, a self-target, a malformed ID, or a target outside `sessionControlPolicy` returns `Tool.Error`.
- Aborting before or during the interrupt returns `Tool.Error`. An abort after the interrupt may return a normal result.
- Cancelling a stopped, failed, or finished session is not an error.
- This is a soft interrupt: it does not cascade, a long tool call may finish first, and jobs owned by an idle session keep running.
- OpenCode may wake the parent with a cancellation notice.
- If `interrupt` is `unknown`, `readBackMayLag` is true, or `status` is `running` or `unknown`, re-run `list`.

## cancel_descendants

Stop the running descendants of the calling session, including grandchildren (requires `experimental.subagent_depth` at least 2). The tool always works in the caller's subtree and has no `sessionID` argument.

### Inputs

| Name     | Type    | Default | Notes                                                              |
| -------- | ------- | ------- | ------------------------------------------------------------------ |
| `reason` | string? | —       | Up to 500 characters. Recorded in the result.                      |
| `cursor` | string? | —       | From a previous `cancel_descendants` call; pass it back unchanged. |

There is no `sessionID`, `parentID`, `statuses`, or `limit` input.

### Output

Text output is a summary with counts and per-target details. JSON output contains:

- `known` — all discovered descendants in the current pass, before the cursor is applied.
- `considered` — descendants after the cursor.
- `running` — running descendants among `considered`.
- `beforeCursorRunning?` — running descendants before the cursor window; re-run without a cursor to include them.
- `targets[]` — one entry per attempted target: `sessionID`, `interrupt`, `readBack`, `status?` (status after the check, when `readBack` is `ok`), and `error?` (failure detail).
  - `interrupt` — `accepted` (the server accepted), `rejected` (no active execution), `failed` (the call threw), or `unknown` (aborted or no definitive answer).
  - `readBack` — `ok` (the status check after cancellation returned a status), `failed`, or `not-read` (not attempted or abandoned after an abort).
- `remaining` — running targets not attempted; use `cursor` to continue, or retry when no cursor is returned.
- `aborted` — true when the call stopped before the batch completed.
- `reason?`, `cursor?`, `warning?`.

### Errors and edge cases

- An unknown caller returns `Tool.Error`.
- Aborting before discovery returns `Tool.Error`. Aborting during discovery or the batch returns `aborted: true` with the targets that were attempted and a warning when discovery was incomplete.
- Only `running` rows are targeted. Use `cancel` for `unknown` rows.
- `maxCancelBatch` limits targets per call (20 by default).
- The whole batch is checked in one permission request.
- Cursor retries skip failed, unknown, rejected, and not-read targets. Inspect them manually.
- Nested cancellation can wake an intermediate parent; re-run `list` and cancel it again if it resumed.
- Discovery can miss running descendants; the output warns when that is possible.

## steer

Send an instruction into a session at its next model request. The message does not interrupt current work.

### Inputs

| Name        | Type     | Default | Notes                                                               |
| ----------- | -------- | ------- | ------------------------------------------------------------------- |
| `sessionID` | string   | —       | Required. Target session ID.                                        |
| `text`      | string   | —       | Up to `maxTextLength` (16000) characters; longer input is rejected. |
| `resume`    | boolean? | `true`  | `false` accepts the message without waking an idle child.           |

### Output

Text output reports the target and delivery. JSON output contains:

- `sessionID`, `messageID?`, `delivery`, `chars`, `resume`.
- `status?` — status observed before the message was accepted; a wake may not be reflected yet.
- `pending?` — true when the message was accepted without waking an idle child.

### Errors and edge cases

- An unknown target, a self-target, empty or overlong text, or a target outside `sessionControlPolicy` returns `Tool.Error`.
- The message is delivered before the child's next model request; the current tool call is not interrupted.
- Waking an idle child may not produce a completion notice in the parent. Resume that child by `sessionID` with the built-in `subagent` tool to read its result.
- `delivery` is the server-reported delivery, normally `steer`.

## queue

Queue a message as the next independent turn after the current task settles.

### Inputs

| Name        | Type     | Default | Notes                                                               |
| ----------- | -------- | ------- | ------------------------------------------------------------------- |
| `sessionID` | string   | —       | Required. Target session ID.                                        |
| `text`      | string   | —       | Up to `maxTextLength` (16000) characters; longer input is rejected. |
| `resume`    | boolean? | `true`  | `false` accepts the message without waking an idle child.           |

### Output

Text output reports the target and delivery. JSON output contains:

- `sessionID`, `messageID?`, `delivery`, `chars`, `resume`.
- `status?` — status observed before the message was accepted; a wake may not be reflected yet.
- `pending?` — true when the message was accepted without waking an idle child.

### Errors and edge cases

- An unknown target, a self-target, empty or overlong text, or a target outside `sessionControlPolicy` returns `Tool.Error`.
- The message does not join the current run; it waits until the current task settles, then starts a separate turn.
- `delivery` is the server-reported delivery, normally `queue`.

## context

Inject a synthetic context message without asking for a turn. The tool always uses `resume: false`.

### Inputs

| Name          | Type    | Default | Notes                                                               |
| ------------- | ------- | ------- | ------------------------------------------------------------------- |
| `sessionID`   | string  | —       | Required. Target session ID.                                        |
| `text`        | string  | —       | Up to `maxTextLength` (16000) characters; longer input is rejected. |
| `description` | string? | —       | Up to 200 characters. A short label shown in the transcript.        |

### Output

Text output reports the target and size. JSON output contains:

- `sessionID`, `messageID?`, `delivery: "next-step"`, `chars`.
- `description?`.
- `status?` — status observed before the message was accepted; context does not wake the child.
- `pending?` — true when the message was accepted without waking an idle child.

### Errors and edge cases

- An unknown target, a self-target, empty or overlong text, overlong description, or a target outside `sessionControlPolicy` returns `Tool.Error`.
- This is a synthetic message, not a user instruction.
- An idle child keeps the message pending until its next run.
- For an instruction without waking, use `steer` with `resume: false`. For a follow-up turn, use `queue`.

## Statuses

- `running` — the session is executing; a live start newer than the last idle marker, or `busy > idle` in the session record, keeps it running.
- `stopped` — the run was interrupted before it finished.
- `failed` — the last run failed.
- `finished` — the last run succeeded.
- `unknown` — no reliable status is available; the session may still be running.

Status is observed from live events and the session record. It can lag, and an `unknown` row may still be running. See [limitations](limitations.md).

`list` includes all five statuses by default. `statuses` filters the rows; `counts` always covers all five.

## Discovery and pagination

`ctx.session.list` is required; see the [README](../README.md) for the supported OpenCode V2 version. `list`, `cancel_descendants`, and `usage` with `includeDescendants: true` walk the relevant subtree through that API. This finds children launched before the plugin loaded, from the TUI, or by another process.

Discovery stops after `maxDiscoveryNodes` nodes, `maxDiscoveryDepth` levels, or `maxDiscoveryPages` pages per parent. The defaults are 200, 8, and 5. An incomplete result includes a warning; an empty result is not proof that no subagents exist. See [configuration](configuration.md) for the limits.

`list` and `cancel_descendants` return a cursor for stable paging. A cursor keeps its place while statuses change. A cursor walk sees the sessions found when it started; children launched after the first page may not appear in that walk. Re-run without a cursor to include them.

For `list`:

- `known` — all discovered sessions before the status filter and cursor.
- `matching` — matches in the current discovery pass, before the cursor.
- `window` — matches after the cursor.
- `remaining` — matches in the window not returned on this page.
- `remainingPages` — pages left in the cursor walk.
- `counts` — all discovered sessions by status, before the filter and cursor.

A new child can increase `known` and `matching` without appearing in the current cursor walk. `matching - window` then includes previous pages and new children.

For `cancel_descendants`, the cursor is bound to the tool and the caller's subtree. `remaining` counts running targets not attempted in the call.

## Text vs JSON

`format: "json"` returns a structured `output` object. `format: "text"` returns a string `output`.

If only one format is allowed, the `format` input is omitted. `["text"]` also omits the output schema and returns text only; `["json"]` keeps the structured output schema and always returns an object.

Per-tool defaults (when both formats are allowed):

| Tool                 | Default format |
| -------------------- | -------------- |
| `list`               | `json`         |
| `usage`              | `json`         |
| `cancel_descendants` | `json`         |
| `cancel`             | `text`         |
| `steer`              | `text`         |
| `queue`              | `text`         |
| `context`            | `text`         |

Use `text` for a quick read. Use `json` when you need fields such as `targets`, `pending`, `usage`, `tree`, or `lastRequest`. See [configuration](configuration.md) for the option.

## Context vs cumulative usage

`usage.contextTokens` follows the OpenCode UI formula:

```text
last assistant step after the last completed compaction:
  input + output + reasoning + cache.read + cache.write
```

It resets after a completed compaction and is the best available estimate of the current context footprint.

`Session.Info.tokens` is cumulative across the whole session and includes every cache read; it is not the current context. Use `tokensUsed` (`input + output + reasoning`) for a cumulative non-cache budget, and `costUSD` for spend.

`contextTokens: 0` is legitimate when no assistant step exists after the last completed compaction. If context cannot be read, the field is omitted and `warning` explains why.

`usage.tree` includes the target: `tree.sessions` counts the target plus descendants, `tree.descendants` counts only descendants, and `tree.costUSD`/`tokensUsed` include the target's own values. `tokensUsed` is omitted when no session in the tree reports token data.

`tree.discoveryComplete` reports discovery completeness, not whether every session finished. `tree.descendantsMayLag` covers descendants; the top-level `usageMayLag` covers the target.

## Errors

Validation and ownership refusals return `Tool.Error`, not a successful output. This covers an unknown target, a self-target, an invalid cursor, and invalid, empty, or non-array `statuses`.

It also covers a malformed or overlong session/parent ID, a target that cannot be verified through the server's session tree, a target outside `sessionControlPolicy`, and a permission denial.

The error message is actionable; correct the call and continue.

No-op outcomes are not errors: `cancel` on a stopped, failed, or finished session, and `cancel_descendants` with no running children, return a normal result.

Partial batch failures stay in `cancel_descendants.targets` with `interrupt: "failed"` or `readBack: "failed"` so the caller can inspect them.

Abort behavior:

- `list` and `usage` return `Tool.Error` when discovery or a context read is aborted.
- `cancel` returns `Tool.Error` when the abort happens before or during the interrupt. An abort after the interrupt may still return a normal result.
- `cancel_descendants` returns `Tool.Error` before discovery. Otherwise it reports `aborted: true` with the targets it attempted, and a warning when discovery was incomplete.

## Permissions and configuration

Mutations use the `subagent.control` permission action when `enforcePermissions` is enabled; see the [security model](security-model.md) for targeting rules and policy modes.

Configuration options, including `enforcePermissions`, `sessionControlPolicy`, `allowedOutputFormats`, `registerSkill`, and limits, are described in [configuration](configuration.md). When `registerSkill` is `true` (the default), the plugin registers `SKILL.md` as the `subagent-tools` skill.
