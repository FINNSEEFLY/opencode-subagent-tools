# Limitations

Read these before you rely on the plugin for anything destructive. The tool
contracts are in [reference](reference.md); this page covers what can go wrong
and what to do about it.

## Discovery and status

- **Discovery can miss sessions.** The plugin refreshes the subtree through
  `ctx.session.list` before `list`, `cancel_descendants`, and `usage` with
  `includeDescendants: true`, so it finds children launched before it loaded,
  from the TUI, or by another process. The defaults
  are 200 nodes, 8 levels, and 5 pages per parent; raise these limits in
  [configuration](configuration.md) for bigger trees; partial results include a
  warning, and empty results are inconclusive.
- **Ordering can skip a child.** OpenCode orders `session.list` by
  `time.updated`, so a child that updates between pages can move and be missed;
  `discoveryComplete` does not show it, so re-run discovery before a large batch.
- **Status can be stale.** `running` comes from live events and the session
  record, and an `unknown` row may still be running. A resumed child can look
  finished if the server omits its busy/idle timestamps.
- **Live state is not persisted.** After a restart, the plugin rediscovers
  sessions through `ctx.session.list` and infers status from `session.get`; live
  events fill it again.

## Cancellation

- **`cancel` is a soft interrupt.** It uses `session.interrupt({ resume: false })`.
  A long tool call may finish first, and there is no hard abort.
- **Idle jobs keep running.** OpenCode can keep shell, subagent, or image jobs
  alive while a session is idle; `session.interrupt` does nothing there. When the
  session is running, an interrupt cancels its jobs as the session stops; for an
  idle session, use the job's own controls.
- **`cancel` does not cascade.** Interrupting a child leaves its own children
  running. Use `cancel_descendants` for the caller's subtree, or cancel each
  child.
- **The status check after `cancel` can lag.** The session record may still say
  `running` after the interrupt. Re-run `list` if `readBackMayLag` is true or
  the status is `running` or `unknown`.
- **Cancelling a child can wake the parent.** OpenCode may deliver a
  `<subagent state="cancelled">` notice to the parent, which can resume, continue
  its work, and spend more tokens. This is OpenCode behavior, not the plugin's;
  see [issue #36423](https://github.com/anomalyco/opencode/issues/36423).
- **`cancel_descendants` stops running descendants in batches.** It interrupts
  at most 20 per call (`maxCancelBatch`) and returns `remaining`; use
  the cursor when one is returned to continue, and use `cancel` for `unknown`
  rows. The status check can lag and an aborted call can leave part of the batch
  running, so re-run `list` and inspect `targets` and `remaining`.

## Usage and context

- **Usage can lag.** `usage` and `list` read the session record; cost and tokens
  update per step, so a child can show `0` or stale values until its step
  completes or it is cancelled. A child cancelled before its first step is saved
  can keep `0`, so re-query when `usageMayLag` is true (it is set while the
  session is running or unknown).
- **Context resets after compaction.** `contextTokens` is the last assistant step
  after the last completed compaction and can drop. `tokens` and `tokensUsed` are
  cumulative; use them for total usage, not current context.
- **Context after revert.** The UI reads the full loaded message list, while
  `usage` counts from the latest completed compaction; if a staged revert
  boundary predates that compaction, the two can differ. This is uncommon.
- **`contextTokens: 0` is not always missing.** Zero is valid when no assistant
  step exists after the last compaction. If context cannot be read, or the
  staged revert boundary is missing, the field is omitted and `warning` explains
  why.
- **`usage.tree` includes the target.** `tree.sessions`, `tree.costUSD`, and the
  token totals cover the target as well as its descendants, so do not
  double-count. A running or unknown descendant can make the totals lag, and
  incomplete discovery can leave sessions out; see [reference](reference.md#usage)
  for the fields.

## Targeting and permissions

- **Reads are unrestricted; mutations follow policy.** `list` and `usage` can
  read any session, including the caller and its ancestors. Mutations follow
  `sessionControlPolicy`, and `cancel_descendants` always stays in the caller's
  subtree; see the [security model](security-model.md).
- **A mutation cannot target the caller.** `usage` can read it.
- **Permissions are not prompted by default.** Mutations request
  `subagent.control`; a denial returns a tool error, and
  `enforcePermissions: false` skips the check entirely. Add an `ask` or `deny`
  rule if you rely on approval; see the [security model](security-model.md).

## Nested subagents

- **Nested subagents need an OpenCode setting.** Set
  `experimental.subagent_depth` to at least `2`; the default is `1`. This is an
  OpenCode setting, not a plugin option.
- **Grandchild transcripts are not exposed.** The plugin can list, inspect,
  steer, queue, and stop a grandchild, but it cannot read its transcript. Use the
  intermediate parent as a relay, or have the grandchild write a handoff file.
- **Nested cancellation can cost tokens.** In a nested tree, the cancelled
  session's parent is another subagent; it can resume after the interrupt, spend
  tokens, and continue up the branch. Re-run `list` after `cancel_descendants`
  and cancel that parent again if it resumed.

## Pagination and output

- **A cursor does not see new sessions.** `list` and `cancel_descendants` return
  a cursor for the next page, and a cursor sees the sessions found when the walk
  started. Children launched later may not appear, so re-run without a cursor to
  include them; retrying `cancel_descendants` with the cursor skips failed,
  unknown, rejected, and not-read targets, so inspect them manually.
- **`list` is limited by `maxListRows`.** It returns at most 20 rows by default.
  Raise `maxListRows` in [configuration](configuration.md) if you need more rows
  per page; the per-call `limit` must be between 1 and `maxListRows`, and the
  cursor still pages through the rest.
- **`list` filters on the last observed status.** Include `unknown` if you also
  want sessions whose state is not known yet. An empty `statuses` array is
  rejected; omit it to include all five.

## Compatibility

- **An OpenCode V2 build with `ctx.session.list` is required.** There is no
  event-only fallback. The plugin uses only public V2 plugin APIs: `ctx.tool`,
  `ctx.session`, `ctx.event`, `ctx.permission`, `ctx.model`, `ctx.skill`, and
  `ctx.options`. See the README for the supported version.
- **No fork or build step.** The plugin runs from source and uses the plugin API
  that OpenCode provides.
