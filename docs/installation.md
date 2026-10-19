# Installation

The standard install uses npm or GitHub; see the [README quick start](../README.md#quick-start).
This page covers manual and local installation, path rules, and the difference
between server and CLI plugins.

## Requirements

- An OpenCode V2 build with `ctx.session.list`; see the [README](../README.md) for the supported version.
- The plugin is a TypeScript directory package: `package.json` exports
  `./src/index.ts`, and OpenCode loads the sources directly. There is no build
  step.
- Keep `SKILL.md` beside `src/` if you want the bundled skill. Without it, the
  tools still load, but the skill is skipped.

## Manual installation

Use this when you want to run a local checkout or pin the plugin yourself.

### Global plugins directory

OpenCode discovers immediate plugin package directories under the OpenCode
config directory:

```text
<global-config-dir>/plugins/
```

On Windows the global config directory is `%USERPROFILE%\.config\opencode`. Copy
the package as a directory named `subagent-tools`:

```powershell
$target = "$env:USERPROFILE\.config\opencode\plugins\subagent-tools"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item .\package.json, .\SKILL.md $target
Copy-Item .\src $target -Recurse
```

OpenCode watches this directory and reloads plugins automatically. If the new
package is not picked up, run `opencode reload`; a full restart is not normally
needed.

This layout loads the plugin with its default options. An auto-discovered
package has no `plugins` entry, so there is nowhere to attach `options`. Use the
directory package layout below when you need to pass options.

> Project-scoped plugins live in `.opencode/plugins/`. A `plugins/` directory
> beside a project-root `opencode.json(c)` is **not** auto-discovered.

### From a local directory package

Global config lives at `~/.config/opencode/opencode.jsonc`; project config lives
at `./opencode.jsonc` or `./.opencode/opencode.jsonc`. Relative paths resolve
from the config file that contains the entry, so a path that works in
`./opencode.jsonc` needs one extra `../` in `./.opencode/opencode.jsonc`.

`opencode.json(c)` can load the plugin from a directory that contains a
`package.json` with `name` and `exports`. Point `package` at the directory.

Global config — absolute path:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/Users/<you>/opencode-subagent-tools"],
}
```

Object form — required if you want to pass options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/<you>/opencode-subagent-tools",
      "options": {
        "namespace": "subagent",
        "enforcePermissions": true,
        "sessionControlPolicy": "descendants",
      },
    },
  ],
}
```

Project config — relative path from `./opencode.jsonc`:

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

From `./.opencode/opencode.jsonc`, use `"package": "../opencode-subagent-tools"`
or an absolute path.

The `plugins` array also accepts npm package names, GitHub specifications, local
directories, and `file://` URLs. Local paths must be directories; a path to a
single file is skipped.

> **Do not load the plugin twice.** If the package directory is already
> auto-discovered from a `plugins/` directory, adding a second `plugins` entry is
> rejected by OpenCode as a duplicate plugin ID; the duplicate is reported as
> failed and does not load. Load the plugin either as an auto-discovered package
> (defaults only) or as a configured directory package (options), not both.

> **Windows paths.** Tilde expansion is not guaranteed for plugin paths on
> Windows; use an absolute forward-slash path such as `C:/Users/<you>/...`.
> `%USERPROFILE%` is not expanded inside JSON config strings.

> **Server plugin vs CLI plugin.** This plugin uses the server plugin API
> (`ctx.tool`, `ctx.session`, `ctx.event`, `ctx.permission`), so load it as a
> server plugin — from the global plugins directory or from `plugins` in
> `opencode.json(c)`. The separate `cli.json` is for CLI-only (TUI) plugins and
> is not needed here.

## After installation

Run `opencode reload`, then ask the agent to call `subagent_list`. If the tool is
missing, check that `ctx.session.list` is available in your OpenCode build and
that the plugin loaded without errors.

## Options

See [configuration](configuration.md) for all options, defaults, ranges, and
examples. For manual installs, the object form of the `plugins` entry is required
to pass options; an auto-discovered package always uses defaults.
