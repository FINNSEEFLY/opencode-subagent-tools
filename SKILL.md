---
name: subagent-tools
description: Use the subagent tools to list, inspect usage, cancel, steer, queue, and inject context into OpenCode subagent sessions. Covers tool contracts, background work, delivery modes, soft interrupts, status-check lag, parent wake, nested depth, permissions, and budget handoffs.
---

# Subagent Tools

Use these tools when you need to inspect or control OpenCode subagent sessions. They complement the built-in `subagent` launch tool; they do not replace it.

## Names and namespace

Tool names below omit the default `subagent_` prefix. With the default namespace, call `subagent_list`, `subagent_usage`, `subagent_cancel`, `subagent_cancel_descendants`, `subagent_steer`, `subagent_queue`, and `subagent_context`. The prefix follows the plugin's `namespace` option and may be different in the user's config. In Code Mode, call the same tools as `tools.subagent.list`, `tools.subagent.usage`, and so on; the namespace separator is `.` instead of `_`.

## Choose the tool

| Goal                                          | Tool                 |
| --------------------------------------------- | -------------------- |
| See children, cost, and cumulative usage      | `list`               |
| Read current context, cost, and context limit | `usage`              |
| Correct a running child at its next boundary  | `steer`              |
| Make a message the next independent turn      | `queue`              |
| Give a child a fact without waking it         | `context`            |
| Stop one target session                       | `cancel`             |
| Stop the caller's running descendants         | `cancel_descendants` |

## Token and cost terms

- `tokens` — cumulative token breakdown for the session: `input`, `output`, `reasoning`, `cache.read`, `cache.write`. It includes every cache read and is not the current context.
- `tokensUsed` — `input + output + reasoning`; a cumulative non-cache budget.
- `contextTokens` — current context footprint: the last assistant step after the last completed compaction, `input + output + reasoning + cache.read + cache.write`. Only `usage` returns it.
- `costUSD` — the session's own cost. For a family total, use `usage` with `includeDescendants: true` and read `tree.costUSD`.

## Status and activity

- `status` — the last or current execution: `running`, `finished`, `failed`,
  `stopped`, or `unknown`. `finished` does not mean the delegated task is done.
- `active` — the session itself is running, unknown, or owns a background job.
  Descendants are not included.
- `subtreeActive` — the session or any discovered descendant is active.
- `activeDescendants` — at least one discovered child is active in its subtree.
  An idle parent with active descendants may wake.
- `backgroundJob` — the session's own observed background work. `kinds` can
  contain `shell`, `image`, and `subagent`. `stateUnknown` means work may remain
  but could not be verified.
- `usageMayLag` — usage may still grow because the session is active or unknown.

Use `active: true` for one session's own work and `subtreeActive: true` for the
whole delegated task. Do not use `statuses: ["running"]` for "still working".

## Text vs JSON

When both formats are allowed (the default), every tool accepts `format`. If the user configured only one format, the `format` input is absent: `["text"]` returns text only, and `["json"]` always returns structured output.

- Use `text` for a quick read. Use `json` when you need fields such as `targets`, `pending`, `usage`, `tree`, or `lastRequest`.
- Choose by task; do not force JSON everywhere.

## list

List child sessions discovered through the server's session tree, newest launch first.

### Inputs

- `parentID?` — parent session ID. Defaults to the calling session. Any parent is accepted because reads are unrestricted.
- `statuses?` — execution statuses: `running`, `stopped`, `failed`, `finished`, or `unknown`. Omit it to include all five. An empty array is an error; unknown values are rejected.
- `active?` — filter on the session's own activity. Omit to include both.
- `subtreeActive?` — filter on the session or any discovered descendant. Omit to include both.
- `limit?` — maximum rows. Defaults to `maxListRows` (20); values outside 1 to `maxListRows` are rejected.
- `cursor?` — cursor from a previous `list` call. Pass it back unchanged.
- `format?` — default `json`.

### Output

Text is a table-like summary. With `format: "json"`, the output contains:

- `root`, `statuses`, `discoveryComplete`, `warning?`
- `known` — all discovered sessions before the status and activity filters and cursor.
- `activeCount`, `subtreeActiveCount` — all discovered sessions with own activity or subtree activity, before filters.
- `matching` — all matches in the current discovery pass, before the cursor.
- `window` — matches after the cursor; `remaining` is the part not returned; `remainingPages` is pages left.
- `counts` — counts for all five execution statuses across all discovered sessions, before filter and cursor. It still sums to `known`.
- `rows[]` — `id`, `parentID?`, `agent?`, `title?`, `titleTruncated?`, `status`, `active`, `subtreeActive`, `activeDescendants?`, `backgroundJob?`, `ageSeconds?`, `launchedAt`, `usageMayLag?`, and optional `usage` with `costUSD?`, `tokens?`, and `tokensUsed?`.

### Notes

- A cursor is bound to the status and activity filters. A cursor walk sees the sessions found when it started. New children can increase `known`/`matching` without appearing in `window`; re-run without a cursor to include them.
- Discovery can miss sessions. `discoveryComplete: false` and `warning` mean the result may be incomplete; an empty list is not proof that no subagents exist. Incomplete discovery can make `subtreeActive` false.
- `usageMayLag: true` means the row is active or unknown and its usage is as of the last persisted step. A `finished` row with a background job still sets it.
- `usage.tokens` and `usage.tokensUsed` are cumulative; neither is the current context. `list` does not return `contextTokens`; use `usage` for that.
- Text markers distinguish own activity (`active`), subtree-only activity (`subtree`), background kind (`background=shell`), and active descendants (`descendants=active`).
- Use `cursor` until `remaining` is 0.

## usage

Read cost, tokens, and current context for a session. Read-only: any session ID is accepted, including the caller, its parents, and foreign sessions.

### Inputs

- `sessionID` — required. Target session ID.
- `includeDescendants?` — when `true`, add `tree` totals for the target and its descendants.
- `format?` — default `json`.

### Output

With `format: "json"`:

- `sessionID`, `parentID?`, `status`, `active`, `usageMayLag?`
- `subtreeActive?` — present only with `includeDescendants: true`; true when the target or any discovered descendant is active.
- `backgroundJob?` — the target's own observed background work.
- `costUSD?` — own cost, not a family total.
- `tokens?`, `tokensUsed?` — cumulative counts; `tokensUsed` is `input + output + reasoning`.
- `contextTokens?` — last assistant step after the last completed compaction: `input + output + reasoning + cache.read + cache.write`.
- `lastRequest?` — input/output/reasoning/cache read/cache write/total for that step.
- `contextLimit?`, `contextPercent?`, `model?`, `warning?`.
- `tree?` — with `includeDescendants: true`: `sessions` includes the target, `descendants` excludes it, and `costUSD`/`tokensUsed` include the target's own values when available. `tokensUsed` is omitted when no session in the tree reports token data. `discoveryComplete` covers the descendant walk; `descendantsMayLag?` flags active/unknown descendants; `warning?` marks incomplete discovery.

### Notes

- `contextTokens: 0` is legitimate when no assistant step exists after the last completed compaction. If context is unavailable, the field is omitted and `warning` explains why.
- `contextTokens` is the current context; `tokens` and `tokensUsed` are cumulative.
- `costUSD` is the session's own cost. For a family total, use `includeDescendants: true` and read `tree.costUSD`.
- The caller's own status is reported as `running` while the tool executes.
- `subtreeActive` is omitted without the tree: descendant activity is unknown, not false.
- Re-query after the step completes or after cancellation when `usageMayLag` is true.

## cancel

Stop one session with a soft interrupt.

### Inputs

- `sessionID` — required. Target session ID; the policy may allow a session outside the caller's subtree.
- `reason?` — up to 500 characters. Recorded in the result; not delivered to the child.
- `format?` — default `text`.

### Output

With `format: "json"`:

- `sessionID`, `accepted`, `interrupt`, `status`, `active`
- `backgroundJob?` — observed own work, with `mayRemain` and `stateUnknown` when relevant.
- `reason?`, `readBackMayLag`, `cancellationDoesNotCascade`
- `costUSD?`, `tokens?`, `tokensUsed?`

`interrupt` is `accepted`, `rejected`, or `unknown`:

- `accepted` — the server accepted the interrupt.
- `rejected` — the target was not running; this is not an error.
- `unknown` — the server returned no definitive boolean. An abort during the interrupt is a `Tool.Error`.

`accepted` is a convenience alias for `interrupt === "accepted"`. `cancellationDoesNotCascade` is always `true`.

### Notes

- This is a soft interrupt: it does not cascade to the child's children, a long tool call may finish first, and jobs owned by an idle session keep running.
- If the target is idle or terminal and no live background job is known, the tool probes the target's structured context for running work. A failed probe, or a probe without an authoritative idle snapshot for the target, sets `backgroundJob.stateUnknown`; it does not claim there is no job.
- If `interrupt` is `rejected` and a background job exists, the execution was idle; the tool cannot stop that job. If `interrupt` is accepted and a background job exists, the job may continue. `backgroundJob.mayRemain` marks this.
- `active` is the target's own state after the call. It is true for running, unknown, or observed background work.
- OpenCode may wake the parent with a cancellation notice.
- The status check after cancellation can lag. If `status` is `running` or `unknown`, or `readBackMayLag` is true, re-run `list`.
- The target may settle as `stopped`, `failed`, or `finished`; `stopped` is not guaranteed.

## cancel_descendants

Stop the running descendants of the calling session. It stops at most `maxCancelBatch` targets per call.

### Inputs

- `reason?` — up to 500 characters. Recorded in the result.
- `cursor?` — cursor from a previous `cancel_descendants` call; pass it back unchanged.
- `format?` — default `json`.

There is no `sessionID`, `parentID`, `statuses`, or `limit` argument. The tool always works in the calling session's subtree, regardless of `sessionControlPolicy`.

### Output

With `format: "json"`:

- `known` — all discovered descendants in the current pass, before the cursor is applied; `considered` — after the cursor; `running` — running among `considered`.
- `activeCount`, `subtreeActiveCount` — considered rows with own or subtree activity.
- `backgroundJobCount` — considered rows with `status !== "running"` that own a background job.
- `backgroundJobMayRemain?` — true when observed background work may still run.
- `beforeCursorRunning?` — running descendants before the cursor window.
- `targets[]` — `sessionID`, `interrupt` (`accepted`/`rejected`/`failed`/`unknown`), `readBack` (`ok`/`failed`/`not-read`), optional `status`, optional `backgroundJob`, optional `error`.
- `remaining` — running targets not attempted; `aborted` — the call stopped before the batch completed.
- `reason?`, `cursor?`, `warning?`.

### Notes

- Only `running` rows are targeted. `unknown` rows need an individual `cancel`.
- Idle rows that own background jobs are reported in `backgroundJobCount`; this tool cannot stop those jobs. If no execution is running but background jobs exist, the result is normal, not an unqualified "no running subagents".
- Idle parents with active descendants are counted in `subtreeActiveCount` and reported in the summary; they may wake. The running descendant is the target, not the parent.
- The whole batch is checked in one permission request.
- `maxCancelBatch` limits targets per call. Use `cursor` to continue; `remaining` counts what is left.
- Failed, unknown, rejected, and not-read targets are reported in `targets` and are not retried by the cursor. Inspect them manually.
- `aborted: true` means the call stopped before the batch completed; inspect `targets` and `remaining`.
- Nested cancellation can wake an intermediate parent inside the subtree. Re-run `list` after the batch and cancel that parent again if it resumed.
- Discovery can be incomplete; the output warns when some running descendants may be missing.
- It stops all running descendants of the calling session, not one selected branch. From a parent, it also stops the target child's siblings and their descendants.
- To stop one child and its descendants without touching siblings, `steer` that child to run `cancel_descendants` itself, then `cancel` it. Alternatively, list its descendants with `list(parentID: childID)` and cancel them individually. `cancel` does not cascade.
- JSON is the default because `targets[]` is the main result; use `format: "text"` for a short summary.

## steer

Send an instruction into a session at its next model request.

### Inputs

- `sessionID` — required.
- `text` — required; up to 16000 characters by default (`maxTextLength`).
- `resume?` — default `true`. `false` accepts the message without waking an idle child.
- `format?` — default `text`.

### Output

With `format: "json"`:

- `sessionID`, `messageID?`, `delivery`, `chars`, `resume`
- `status?` — status observed before the message was accepted
- `active`, `backgroundJob?` — observed target activity and own background work
- `pending?` — true when the message was accepted without waking an idle child

### Notes

- Delivered before the child's next model request. It does not interrupt the current tool call.
- The plugin cannot move a blocking shell to the background, so delivery may wait for that shell. This is a UI parity gap, not a hard failure.
- OpenCode sends a `<subagent>` report each time the child goes idle. A report can say `state="running"` and `Background work still running` when the execution is idle but background work remains. Read the report; do not resume the child just to read its result.
- `delivery` is the server-reported delivery, normally `steer`.

## queue

Queue a message as the next independent turn after the current execution settles.

### Inputs

- `sessionID` — required.
- `text` — required; up to 16000 characters by default (`maxTextLength`).
- `resume?` — default `true`. `false` accepts the message without waking an idle child.
- `format?` — default `text`.

### Output

With `format: "json"`:

- `sessionID`, `messageID?`, `delivery`, `chars`, `resume`
- `status?` — status observed before the message was accepted
- `active`, `backgroundJob?` — observed target activity and own background work
- `queued?` — true when the message was accepted but has not started yet
- `pending?` — true when the message was accepted without waking an idle child

### Notes

- The message does not join the current run. It waits for the current execution to settle, then starts a separate turn.
- Background jobs are not waited for and continue in parallel. The queue is promoted at the idle boundary even when background work remains.
- `queued` is inferred from the observed status and `resume`; it does not inspect the server's existing queue. Other queued prompts may be ahead.
- `delivery` is the server-reported delivery, normally `queue`.

## context

Inject a synthetic context message without starting a turn.

### Inputs

- `sessionID` — required.
- `text` — required; up to 16000 characters by default (`maxTextLength`).
- `description?` — up to 200 characters. A short label shown in the transcript.
- `format?` — default `text`.

### Output

With `format: "json"`:

- `sessionID`, `messageID?`, `delivery: "next-step"`, `chars`
- `description?`
- `status?` — status observed before the message was accepted
- `active`, `backgroundJob?` — observed target activity and own background work
- `pending?` — true when the message was accepted without waking an idle child

### Notes

- This is a synthetic message, not a user instruction.
- It always uses `resume: false`. An idle child keeps the message pending until its next run.
- For an instruction without waking, use `steer` with `resume: false`. For a follow-up turn, use `queue`.

## Permissions and policy

- Mutations use `subagent.control` when `enforcePermissions` is `true` (the default); `false` skips the permission check, but ownership still follows `sessionControlPolicy`.
- `list` and `usage` are read-only, do not request `subagent.control`, and may read any session, including the caller and its ancestors.
- `sessionControlPolicy` limits mutations only: `"descendants"` (default), `"all-except-ancestors"`, or `"all"`.
- `cancel_descendants` always stays in the caller's subtree; the policy does not widen it.
- A mutation cannot target the caller; `usage` may read it.
- OpenCode's base policy allows all actions, so add an `ask` or `deny` rule to prompt or block. `"all"` is privileged: a subagent can target its parent or root if it knows the ID.

## Errors

Refusals are `Tool.Error`: unknown target, self-target, invalid cursor, invalid, empty, or non-array `statuses`, malformed or overlong session/parent ID, target outside `sessionControlPolicy`, or permission denial.

Abort behavior:

- `list` and `usage` return `Tool.Error` when discovery or context read is aborted.
- `cancel` returns `Tool.Error` if the abort happens before or during the interrupt; an abort after the interrupt may still return a normal result.
- `cancel_descendants` returns `Tool.Error` before discovery; otherwise it reports `aborted: true` with the targets it attempted and a warning when discovery was incomplete.

In OpenCode 2.3.0+, these `Tool.Error` results are normal call results from a cooperative stop, not interrupted tool calls. The error message is actionable. Correct the arguments and continue.

No-op outcomes are not errors: `cancel` on an already stopped, failed, or finished session, and `cancel_descendants` with no running children, return a normal result.

## Background reports

In OpenCode 2.3.0+, all subagents run in the background. A `<subagent>` report arrives each time a child goes idle, and again after each later round. A report can say `state="running"` and include `Background work still running` when the child's execution is idle but its own background work remains. Read the report; do not resume the child just to read its result.

## Nested subagents

OpenCode creates nested subagents only when `experimental.subagent_depth` is at least `2`; this is an OpenCode setting, not a plugin option. The plugin can list, inspect, steer, queue, and stop nested descendants up to the configured limits, but it does not expose a grandchild's transcript. Use the intermediate parent as a relay or have the grandchild write a handoff file.

## Limits

- `list` returns up to 20 rows by default.
- `cancel_descendants` interrupts up to 20 targets per call by default.
- `steer`, `queue`, and `context` accept up to 16000 characters by default.
- `reason` is capped at 500 characters and `description` at 200. These two are fixed, not `limits` options.
- Discovery defaults: 200 nodes, 8 levels, and 5 pages.
- The discovery, list, cancel-batch, and text limits are configurable through the plugin's `limits` options.

## Example: budget handoff

If cost matters for your workflow, one way to use the tools together is: check `list` for `tokensUsed`, call `usage` for a child that is approaching your budget, `steer` it to write a handoff summary and stop new work, then `cancel` if it does not wind down. Read the handoff and start a fresh child. Keep the old session for audit; `contextTokens` resets after compaction, but `costUSD` and cumulative tokens do not.

## Workflow

1. Call `list`; it includes all statuses by default. Pass `active: true` for one session's own work or `subtreeActive: true` for the whole delegated task. Use `statuses` only when you need a specific execution outcome.
2. Pick the session ID from the result. Do not invent or guess IDs.
3. To change what a running child is doing, use `steer`; to add a follow-up turn, use `queue`; to add a fact without waking it, use `context`. These adjust the existing session and keep its current run and context. `cancel` stops the session; restarting it with the built-in `subagent` tool is a different workflow.
4. To stop one child, use `cancel`. To stop all your running descendants, use `cancel_descendants`; it cannot select one branch.
5. After `cancel`, re-run `list` if `interrupt` is `unknown`, `status` is `running` or `unknown`, or `readBackMayLag` is true. After `cancel_descendants`, inspect `targets[].status`/`targets[].readBack`; re-run `list` if a target still looks running. After a nested `cancel_descendants`, also check whether an intermediate parent resumed.

## Examples

- The child is editing the wrong file: use `steer` with a concrete constraint.
- The child should run the benchmark after its current task: use `queue`.
- The child is idle and you want to leave it idle: use `steer` with `resume: false`.
- The migration is already applied: use `context` with that fact; do not wake the child.
- Stop one child but keep its sibling: use `cancel` with the child's session ID.
- Stop every running descendant of the current session: use `cancel_descendants`.
- Stop one child and its descendants without touching siblings: `steer` that child to run `cancel_descendants` itself, then `cancel` it; or list its descendants and cancel them individually.
- If cost matters for a child: `usage` it, then `steer` a handoff before starting a fresh child.
