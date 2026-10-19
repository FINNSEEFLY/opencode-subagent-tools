# Configuration

Pass options with the object form of a `plugins` entry in `opencode.json(c)`. Options belong to the entry that loads the plugin and are read from `ctx.options` during `setup`. If you installed with `opencode plugin add`, replace the string entry with the object form to add options.

A plugin auto-discovered from a `plugins/` directory has no entry, so it always uses defaults. To pass options, load it through `opencode.json(c)`.

Local paths in `plugins` must be directories. A path to a single `.ts` file is skipped. Point `package` at the directory that contains `package.json` with `name` and `exports`.

## Full example

The example shows the defaults and uses the npm package name. You can omit any option you do not need. For a local checkout, use the directory path instead; see [Global vs project configuration](#global-vs-project-configuration).

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-subagent-tools",
      "options": {
        "namespace": "subagent",
        "enforcePermissions": true,
        "sessionControlPolicy": "descendants",
        "allowedOutputFormats": ["text", "json"],
        "registerSkill": true,
        "limits": {
          "maxDiscoveryNodes": 200,
          "maxDiscoveryDepth": 8,
          "maxDiscoveryPages": 5,
          "maxListRows": 20,
          "maxCancelBatch": 20,
          "maxTextLength": 16000,
        },
      },
    },
  ],
}
```

## Options

| Option                 | Type     | Default            | Effect                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | -------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`            | string   | `"subagent"`       | Tool namespace. Tools become `<namespace>_list`, `<namespace>_usage`, `<namespace>_cancel`, `<namespace>_cancel_descendants`, `<namespace>_steer`, `<namespace>_queue`, and `<namespace>_context`.                                                                                                                                                                                            |
| `enforcePermissions`   | boolean  | `true`             | Checks every mutation with `ctx.permission.assert` using action `subagent.control`. A denial returns a tool error. Read-only `list` and `usage` do not request `subagent.control`. Set to `false` to skip permission evaluation entirely; ownership still follows `sessionControlPolicy`.                                                                                                     |
| `sessionControlPolicy` | string   | `"descendants"`    | Who **mutating** tools may target: `"descendants"` (caller subtree), `"all-except-ancestors"` (any except caller/ancestors), or `"all"` (any session, including the caller's ancestors, except the caller itself). Read-only `list`/`usage` are not restricted. `cancel_descendants` always stays in the caller's subtree.                                                                    |
| `allowedOutputFormats` | string[] | `["text", "json"]` | Formats the tools may return. `["text"]` returns text only; `["json"]` always returns structured output. When both are allowed, tools also accept a per-call `format`; with one format the input is omitted. Unknown values are ignored; a non-array, an empty list, or a list with no recognized values falls back to the default, while a partially valid list keeps the recognized values. |
| `registerSkill`        | boolean  | `true`             | Registers the bundled `SKILL.md` as a skill for the model. Set to `false` to skip skill registration; the tools still work.                                                                                                                                                                                                                                                                   |

The permission action is always `subagent.control`, even if you change `namespace`. See [Permissions](security-model.md#permissions).

## Session control policy

`sessionControlPolicy` applies only to **mutating** tools. Read-only `list` and `usage` may read any session, including the caller and its ancestors.

| Tool                 | Mutating | Uses `subagent.control` | Policy applies            |
| -------------------- | -------- | ----------------------- | ------------------------- |
| `list`               | no       | no                      | no; any `parentID`        |
| `usage`              | no       | no                      | no; any session           |
| `cancel`             | yes      | yes                     | yes                       |
| `cancel_descendants` | yes      | yes                     | no; always caller subtree |
| `steer` / `queue`    | yes      | yes                     | yes                       |
| `context`            | yes      | yes                     | yes                       |

| Value                     | Mutations may target                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `"descendants"` (default) | Only the calling session's subtree.                                      |
| `"all-except-ancestors"`  | Any session except the caller and its ancestors.                         |
| `"all"`                   | Any session, including the caller's ancestors, except the caller itself. |

Cross-tree control without allowing upward control:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-subagent-tools",
      "options": { "sessionControlPolicy": "all-except-ancestors" },
    },
  ],
}
```

Full control, including ancestors:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-subagent-tools",
      "options": { "sessionControlPolicy": "all" },
    },
  ],
}
```

`"all"` is security-sensitive: a subagent can target its parent or root if it knows the ID. Read-only tools are unrestricted in every mode and do not request `subagent.control`. `cancel_descendants` never widens beyond the caller's subtree.

## Global vs project configuration

Options are scoped to the config file that contains the `plugins` entry:

- **Global** — `~/.config/opencode/opencode.json(c)`: applies to every project.
- **Project** — `./opencode.json(c)` or `./.opencode/opencode.json(c)`: applies to that project only.
- **System** — `/etc/opencode/opencode.json(c)` on Linux, `/Library/Application Support/opencode` on macOS, or `%ProgramData%\opencode` on Windows: managed settings with the highest precedence.

### Global example

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-subagent-tools",
      "options": {
        "namespace": "subagent",
        "enforcePermissions": true,
        "sessionControlPolicy": "descendants",
      },
    },
  ],
}
```

For a local checkout, use the absolute path to the plugin directory instead of the npm name:

```jsonc
{
  "plugins": [
    {
      "package": "C:/Users/<you>/opencode-subagent-tools",
      "options": { "sessionControlPolicy": "all-except-ancestors" },
    },
  ],
}
```

### Project example

From `./opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode-subagent-tools",
      "options": {
        "namespace": "subagent",
        "enforcePermissions": true,
      },
    },
  ],
}
```

From `./.opencode/opencode.jsonc`, the path is relative to that file, so use one extra `../`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "../opencode-subagent-tools",
      "options": {
        "namespace": "subagent",
        "enforcePermissions": true,
      },
    },
  ],
}
```

The package path is a directory containing `package.json` and `exports`, not a `.ts` file.

### Choosing a scope

Use a global entry when the same options should apply everywhere. Use a project entry when only that project needs the option.

Plugin arrays from applicable config files are merged from lowest to highest precedence; they are not replaced. OpenCode rejects duplicate plugin IDs: a second entry is reported as failed with `Duplicate plugin ID` and does not load. Load the plugin in exactly one scope. If you need different options per project, load it only from the project config.

### Auto-discovered directory installs

Copying the package directory (with `package.json`, `src/`, and `SKILL.md`) into a `plugins/` directory is still supported, but that path is auto-discovered and has no `plugins` entry. It always uses default options. To pass options, use a configured directory package and a `plugins` entry as above.

## Limits

All limits are integers and are clamped to the allowed range. Invalid values fall back to the default.

| Option              | Default | Range   | Effect                                                               |
| ------------------- | ------- | ------- | -------------------------------------------------------------------- |
| `maxDiscoveryNodes` | `200`   | 1–5000  | Maximum nodes visited in one server discovery pass.                  |
| `maxDiscoveryDepth` | `8`     | 1–32    | Maximum parent-chain depth walked during discovery and verification. |
| `maxDiscoveryPages` | `5`     | 1–50    | Maximum `session.list` pages requested per parent.                   |
| `maxListRows`       | `20`    | 1–50    | Maximum rows returned by `list` per call.                            |
| `maxCancelBatch`    | `20`    | 1–50    | Maximum children interrupted by `cancel_descendants` per call.       |
| `maxTextLength`     | `16000` | 1–32000 | Maximum characters accepted by `steer`, `queue`, and `context`.      |

`list` and `cancel_descendants` are independent: raising `maxListRows` does not change how many children `cancel_descendants` may stop, and vice versa. The `session.list` page size stays at 100.

Discovery follows the server cursor:

- A short page with a cursor continues.
- A page without a cursor ends the walk.
- A full page without a cursor is treated as potentially truncated.
- A repeated cursor is treated as incomplete.

## Tuning notes

- Raising `maxDiscoveryNodes`, `maxDiscoveryDepth`, or `maxDiscoveryPages` increases the number of `session.list` calls and discovery latency.
- Raising `maxListRows` increases the number of rows in `list` output. Raising `maxCancelBatch` increases the number of interrupts and status checks per `cancel_descendants` call. `cancel_descendants` checks the whole batch in one permission request, so an `ask` policy prompts once per call, not once per child.
- `list` and `cancel_descendants` use a cursor to page. A cursor keeps its place while statuses change, but it sees the sessions found when the walk started; children launched after the first page may not appear.
- `list` filters by the last observed status. Include `unknown` in `statuses` if you also want to see sessions whose state is not known yet.
- Discovery stops at the configured node, depth, and page limits and can miss sessions. An empty or partial result is not proof that no subagents exist; see [limitations](limitations.md).
- `sessionControlPolicy: "all"` is security-sensitive; see the [security model](security-model.md).

## Power-user example

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-subagent-tools",
      "options": {
        "limits": {
          "maxDiscoveryNodes": 1000,
          "maxDiscoveryDepth": 16,
          "maxDiscoveryPages": 10,
          "maxListRows": 50,
          "maxCancelBatch": 10,
          "maxTextLength": 24000,
        },
      },
    },
  ],
}
```
