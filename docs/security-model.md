# Security model

These are **destructive tools that the model can call**. The defaults are
deliberately scoped.

## Permissions

Every mutating tool (`cancel`, `cancel_descendants`, `steer`, `queue`, `context`) calls
`ctx.permission.assert` with action `subagent.control` when
`enforcePermissions` is `true` (the default). A denial returns a tool error.
`cancel_descendants` checks the whole batch in one request: any `deny` blocks the batch,
and an `ask` policy prompts once per call.

Read-only `list` and `usage` do not request `subagent.control`. They can read
any session, including the caller and its ancestors.

OpenCode's base policy allows all actions, so `enforcePermissions: true` by
itself does not prompt. Add an `ask` or `deny` rule for `subagent.control` if
you want a prompt or a block; see [configuration](configuration.md) for the option.

The TUI may render the custom `subagent.control` action without the target IDs
or titles carried in the permission metadata. When target visibility matters,
review the tool call or use explicit `allow`/`deny` rules instead of relying
only on an `ask` prompt.

## Session control policy

`sessionControlPolicy` applies only to mutations:

| Value                     | Mutations may target                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `"descendants"` (default) | Only the calling session's subtree.                                      |
| `"all-except-ancestors"`  | Any session except the caller and its ancestors.                         |
| `"all"`                   | Any session, including the caller's ancestors, except the caller itself. |

`cancel_descendants` always remains scoped to the calling session's subtree, regardless
of policy. Use individual `cancel` for foreign sessions.

`"all"` is security-sensitive: a subagent can target its parent or root session
if it knows the ID. A subagent can also discover IDs through `list` because
reads are unrestricted. Enable `"all"` only for deliberate orchestration
setups.

`"all-except-ancestors"` walks the caller's parent chain and refuses a target
that appears in it. If the chain is too deep, cyclic, or unreadable, the plugin
fails closed and refuses the mutation rather than assuming the target is safe.

Under `"descendants"`, single-target mutations verify the target by walking its
`parentID` chain with `session.get`. This lets them control a descendant that
the current discovery pass did not return. A chain that exceeds
`maxDiscoveryDepth` or is malformed is unverified, not foreign. Under
`"all-except-ancestors"`, the plugin walks the caller's parent chain. Under
`"all"`, it only reads the target.

## Read-only access

`list` may inspect any `parentID`'s subtree, and `usage` may read any session's
cost, tokens, and context. This is intentional: `sessionControlPolicy` is a
mutation policy, not a read policy. Treat session cost/context and subtree
metadata as visible to any agent that can call these tools.

## Other protections

- Mutating tools can never target the calling session itself. `usage` is
  read-only and may read the caller.
- Session IDs are validated for length and control characters; they are never
  silently truncated. Every mutation target is verified through `session.get`
  or the discovered session tree before use.
- `cancel_descendants` only targets descendants discovered through
  `ctx.session.list`.
- Discovery stops at the configured limits and can miss sessions. An empty or
  partial result is not proof that no subagents exist; see
  [limitations](limitations.md).
- `enforcePermissions: false` skips permission evaluation entirely. Do not
  combine it with `sessionControlPolicy: "all"` unless you intend to allow
  unrestricted control of any session except the caller.

See [SECURITY.md](../SECURITY.md) for vulnerability reporting and
[configuration](configuration.md) for the full option reference.
