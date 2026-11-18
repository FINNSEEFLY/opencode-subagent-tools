# Tool reference

The plugin registers seven tools under a namespace. With the default namespace `subagent`, the names are `subagent_list`, `subagent_usage`, `subagent_cancel`, `subagent_cancel_descendants`, `subagent_steer`, `subagent_queue`, and `subagent_context`.

The prefix follows the plugin's `namespace` option. OpenCode normalizes unsupported characters in names and namespaces to `_`. In Code Mode, call the same tools as `tools.subagent.list`, `tools.subagent.usage`, and so on; the namespace separator is `.` instead of `_`.

Inputs marked `?` are optional; unknown properties are rejected.

- When `allowedOutputFormats` allows both formats (the default), every tool accepts `format`; see [Text vs JSON](#text-vs-json).
- Mutations follow the targeting rules in the [security model](security-model.md).
- For operational guidance, see the bundled `SKILL.md`.

## list

List discovered sessions in a subtree, newest launch first. Read-only.

### Inputs

| Name            | Type      | Default            | Notes                                                                                                                                       |
| --------------- | --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `parentID`      | string?   | caller             | Any session ID is accepted.                                                                                                                 |
| `statuses`      | string[]? | all five           | Execution statuses: `running`, `stopped`, `failed`, `finished`, or `unknown`. An empty array, an unknown value, or a non-array is rejected. |
| `active`        | boolean?  | —                  | Filter on the session's own activity. Omit to include both active and inactive rows.                                                        |
| `subtreeActive` | boolean?  | —                  | Filter on the session or any discovered descendant. Omit to include both.                                                                   |
| `limit`         | integer?  | `maxListRows` (20) | 1 to `maxListRows`; values outside this range are rejected.                                                                                 |
| `cursor`        | string?   | —                  | From a previous `list` call; pass it back unchanged. A cursor is bound to the status and activity filters.                                  |

### Output

Text output is one row per session plus summary and warning lines. JSON output contains:

- `root` — subtree root: the caller or `parentID`.
- `statuses` — applied execution-status filter.
- `discoveryComplete` — whether discovery walked the whole subtree, not whether all rows fit on this page.
- `warning?` — set when discovery was incomplete.
- `known` — all discovered sessions before the status and activity filters and cursor.
- `activeCount` — all discovered sessions with their own active execution or background job, before filters.
- `subtreeActiveCount` — all discovered sessions that are active or have an active descendant, before filters.
- `matching` — matches in the current discovery pass, before the cursor.
- `window` — matches after the cursor; equals `matching` on the first page.
- `remaining` — matches in the window not returned on this page.
- `remainingPages` — pages left in the cursor walk.
- `cursor?` — cursor for the next page.
- `counts` — counts for all five execution statuses across all discovered sessions, before the status and activity filters and cursor. It sums to `known`.
- `rows[]` — one entry per session:
  - `id`, `parentID?`, `agent?`, `title?`, `titleTruncated?` (true when the title was truncated).
  - `status` — execution status; `finished` means the last execution succeeded, not that the delegated task is complete.
  - `active` — true when the session itself is running, unknown, or owns a background job. Descendants are excluded.
  - `subtreeActive` — true when the session or any discovered descendant is active.
  - `activeDescendants?` — true only when at least one discovered child is active in its subtree.
  - `backgroundJob?` — the session's own observed work: `kinds` (`shell`, `image`, `subagent`, `codemode`), and optional `stateUnknown` when work may remain but could not be verified.
  - `ageSeconds?` (omitted when the launch time is unknown), `launchedAt`.
  - `usageMayLag?` — true when the row is active or unknown.
  - `usage?` — `costUSD?`, `tokens?`, and `tokensUsed?` when the server provides them.

Text output adds `active` or `subtree` markers, `background=<kinds>`, `descendants=active`, and `usage=lagging` when relevant.

### Errors and edge cases

- A malformed or unreadable `parentID` returns `Tool.Error`.
- If the caller is unknown and `parentID` is omitted, the tool returns `Tool.Error`.
- An invalid cursor returns `Tool.Error`; a cursor is bound to the tool, root, status filter, and activity filters.
- A non-boolean `active` or `subtreeActive` returns `Tool.Error`.
- Aborting discovery returns `Tool.Error` instead of a partial result.
- An empty result does not prove that no subagents exist. See [limitations](limitations.md).
- A new child can increase `known` and `matching` without appearing in the current cursor walk; re-run without a cursor to include it.
- `statuses` filters executions only. Use `active` or `subtreeActive` for work that is still in progress.

## usage

Read cost, tokens, current context, status, and activity for a session. Read-only.

### Inputs

| Name                 | Type     | Default | Notes                                                  |
| -------------------- | -------- | ------- | ------------------------------------------------------ |
| `sessionID`          | string   | —       | Required. Any session ID is accepted.                  |
| `includeDescendants` | boolean? | `false` | Adds `tree` totals for the target and its descendants. |

### Output

Text output is a summary. JSON output contains:

- `sessionID`, `parentID?`, `status`, `active`.
- `status` — execution status; the caller is reported as `running` while the tool executes.
- `active` — true when the session itself is running, unknown, or owns a background job.
- `subtreeActive?` — present only with `includeDescendants: true`; true when the target or any discovered descendant is active. Without the tree, descendant activity is unknown and the field is omitted.
- `backgroundJob?` — the target's own observed work: `kinds`, and optional `stateUnknown`.
- `usageMayLag?` — true when the session is active or unknown; values are as of the last persisted step.
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
  - `descendantsMayLag?` flags active or unknown descendants.
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
- `status` — execution status after the interrupt and status check.
- `active` — true when the target is running, unknown, or owns observed background work after the call.
- `backgroundJob?` — the target's own observed work: `kinds` (`shell`, `image`, `subagent`, `codemode`), `mayRemain?` when work may still run after the call, and `stateUnknown?` when a probe failed.
- `reason?` — the recorded reason.
- `readBackMayLag` — true when the interrupt was accepted and the status check after cancellation still reports `running` or `unknown`.
- `cancellationDoesNotCascade` — always `true`; cancellation is non-cascading, not a claim that the target has no children.
- `costUSD?`, `tokens?`, `tokensUsed?` — usage after the interrupt.

Text distinguishes an accepted interrupt with a remaining job ("may continue"), an idle target with a job ("cannot stop the background job"), and an unverified probe ("state could not be verified"). If the target's subtree may still be active and no own background job was observed, the text says so.

### Errors and edge cases

- An unknown target, a self-target, a malformed ID, or a target outside `sessionControlPolicy` returns `Tool.Error`.
- Aborting before or during the interrupt returns `Tool.Error`. An abort after the interrupt may return a normal result.
- Cancelling a stopped, failed, or finished session is not an error.
- If the target is idle or terminal and no live background job is known, the tool probes `session.context(target)` for running shell messages and shell/image/subagent tool parts. It cannot see a Code Mode job; that requires an idle snapshot. A failed probe, or a probe without an authoritative idle snapshot for the target, sets `backgroundJob.stateUnknown`; it does not claim there is no job.
- This is a soft interrupt: it does not cascade, a long tool call may finish first, and jobs owned by an idle session keep running. The tool reports those jobs but cannot stop them.
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
- `activeCount` — considered descendants with their own active execution or background job.
- `subtreeActiveCount` — considered descendants that are active or have an active descendant.
- `backgroundJobCount` — considered descendants with `status !== "running"` that own a background job.
- `backgroundJobMayRemain?` — true when an observed background job may still run after the call.
- `beforeCursorRunning?` — running descendants before the cursor window; re-run without a cursor to include them.
- `targets[]` — one entry per attempted target: `sessionID`, `interrupt`, `readBack`, `status?` (status after the check, when `readBack` is `ok`), `backgroundJob?` (observed work with `mayRemain?`), and `error?` (failure detail).
  - `interrupt` — `accepted` (the server accepted), `rejected` (no active execution), `failed` (the call threw), or `unknown` (aborted or no definitive answer).
  - `readBack` — `ok` (the status check after cancellation returned a status), `failed`, or `not-read` (not attempted or abandoned after an abort).
- `remaining` — running targets not attempted; use `cursor` to continue, or retry when no cursor is returned.
- `aborted` — true when the call stopped before the batch completed.
- `reason?`, `cursor?`, `warning?`.

If no execution is running but idle descendants own background jobs, the result is normal with `running: 0` and `backgroundJobCount > 0`; the summary says those jobs cannot be stopped. Idle parents with active descendants are reported through `subtreeActiveCount` and the summary, not interrupted.

### Errors and edge cases

- An unknown caller returns `Tool.Error`.
- Aborting before discovery returns `Tool.Error`. Aborting during discovery or the batch returns `aborted: true` with the targets that were attempted and a warning when discovery was incomplete.
- Only `running` rows are targeted. Use `cancel` for `unknown` rows.
- Idle rows that own background jobs are counted in `backgroundJobCount`; this tool cannot stop those jobs.
- Idle parents with active descendants are counted in `subtreeActiveCount`; the running descendant is the target, not the parent.
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
- `active` — the observed target was running, unknown, or owned a background job.
- `backgroundJob?` — the target's own observed work.
- `pending?` — true when the message was accepted without waking an idle child.

### Errors and edge cases

- An unknown target, a self-target, empty or overlong text, or a target outside `sessionControlPolicy` returns `Tool.Error`.
- The message is delivered before the child's next model request; the current tool call is not interrupted.
- The plugin cannot move a blocking shell to the background, so delivery may wait for that shell. This is a UI parity gap, not a hard failure.
- OpenCode sends a `<subagent>` report each time the child goes idle. A report can say `state="running"` and `Background work still running` when the execution is idle but background work remains. Read the report; do not resume the child just to read its result.
- `delivery` is the server-reported delivery, normally `steer`.

## queue

Queue a message as the next independent turn after the current execution settles.

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
- `active` — the observed target was running, unknown, or owned a background job.
- `backgroundJob?` — the target's own observed work.
- `queued?` — true when the message was accepted but has not started yet. Inferred from the observed status and `resume`; it does not inspect the server's existing queue, so other queued prompts may be ahead.
- `pending?` — true when the message was accepted without waking an idle child.

### Errors and edge cases

- An unknown target, a self-target, empty or overlong text, or a target outside `sessionControlPolicy` returns `Tool.Error`.
- The message does not join the current run; it waits for the current execution to settle, then starts a separate turn.
- Background jobs are not waited for and continue in parallel. The queue is promoted at the idle boundary even when background work remains.
- `queued` is `true` when the target was running/unknown, when its status could not be observed, or when it was idle with `resume: false`; it is `false` when the target was idle and `resume: true`.
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
- `active` — the observed target was running, unknown, or owned a background job.
- `backgroundJob?` — the target's own observed work.
- `pending?` — true when the message was accepted without waking an idle child.

### Errors and edge cases

- An unknown target, a self-target, empty or overlong text, overlong description, or a target outside `sessionControlPolicy` returns `Tool.Error`.
- This is a synthetic message, not a user instruction.
- An idle child keeps the message pending until its next run.
- For an instruction without waking, use `steer` with `resume: false`. For a follow-up turn, use `queue`.

## Statuses and activity

- `running` — the session is executing; a live start newer than the last idle marker, or `busy > idle` in the session record, keeps it running.
- `stopped` — the run was interrupted before it finished.
- `failed` — the last run failed.
- `finished` — the last run succeeded. This does not mean the delegated task is complete.
- `unknown` — no reliable status is available; the session may still be running.

`status` is execution-oriented. In OpenCode 2.3.0+, shell, image, subagent, or Code Mode work can stay alive while a session is idle, so use the activity fields for "still working":

- `active` — the session itself is running, unknown, or owns a background job. Descendants are not included.
- `subtreeActive` — the session or any discovered descendant is active.
- `activeDescendants` — at least one discovered child is active. An idle parent with active descendants may wake.
- `backgroundJob` — the session's own observed work: `kinds` can contain `shell`, `image`, `subagent`, and `codemode`. `stateUnknown` means work may remain but could not be verified.
- `usageMayLag` — the session is active or unknown, so usage may still grow.

Status and activity are observed from live events, the idle hook, shell events, structured context probes, and the session record. Code Mode jobs are visible only through the idle hook. They can lag, and an `unknown` row may still be running. See [limitations](limitations.md).

`list` includes all five statuses by default. `statuses` filters executions only; use `active` and `subtreeActive` for work that is still in progress. `counts` always covers all five statuses and sums to `known`.

## Discovery and pagination

OpenCode 2.3.0+ is required. `list`, `cancel_descendants`, and `usage` with `includeDescendants: true` walk the relevant subtree through `ctx.session.list`. This finds children launched before the plugin loaded, from the TUI, or by another process.

Discovery stops after `maxDiscoveryNodes` nodes, `maxDiscoveryDepth` levels, or `maxDiscoveryPages` pages per parent. The defaults are 200, 8, and 5. An incomplete result includes a warning; an empty result is not proof that no subagents exist. See [configuration](configuration.md) for the limits.

`list` and `cancel_descendants` return a cursor for stable paging. A cursor keeps its place while statuses change. A `list` cursor is bound to the status and activity filters. A cursor walk sees the sessions found when it started; children launched after the first page may not appear in that walk. Re-run without a cursor to include them.

For `list`:

- `known` — all discovered sessions before the status and activity filters and cursor.
- `activeCount`, `subtreeActiveCount` — all discovered sessions with own or subtree activity, before filters.
- `matching` — matches in the current discovery pass, before the cursor.
- `window` — matches after the cursor.
- `remaining` — matches in the window not returned on this page.
- `remainingPages` — pages left in the cursor walk.
- `counts` — all discovered sessions by status, before the filters and cursor; it sums to `known`.

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

Use `text` for a quick read. Use `json` when you need fields such as `targets`, `pending`, `queued`, `active`, `subtreeActive`, `backgroundJob`, `usage`, `tree`, or `lastRequest`. See [configuration](configuration.md) for the option.

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

In OpenCode 2.3.0+, these `Tool.Error` results are normal call results from a cooperative stop, not interrupted tool calls.

## Permissions and configuration

Mutations use the `subagent.control` permission action when `enforcePermissions` is enabled; see the [security model](security-model.md) for targeting rules and policy modes.

Configuration options, including `enforcePermissions`, `sessionControlPolicy`, `allowedOutputFormats`, `registerSkill`, and limits, are described in [configuration](configuration.md). When `registerSkill` is `true` (the default), the plugin registers `SKILL.md` as the `subagent-tools` skill.
