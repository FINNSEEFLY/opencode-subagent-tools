# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - 2026-11-07

### Added

- Initial release of the `subagent-tools` OpenCode plugin.
- Seven tools under the default `subagent` namespace:
  - `subagent_list` — list subagent sessions, filter by status, and page through results.
  - `subagent_usage` — read cost, tokens, current context, and optional descendant totals for any session.
  - `subagent_cancel` — stop one session with a soft interrupt.
  - `subagent_cancel_descendants` — stop the caller's running descendants in batches.
  - `subagent_steer` — send an instruction at the target session's next model request.
  - `subagent_queue` — queue a message as the next independent turn.
  - `subagent_context` — inject a synthetic context message without starting a turn.
- Options: `namespace`, `enforcePermissions`, `sessionControlPolicy`, `allowedOutputFormats`, `registerSkill`, and `limits` for discovery, list size, cancellation batch, and text length.
- Permission action `subagent.control` for mutations; `list` and `usage` are read-only. `cancel_descendants` checks the whole batch in one permission request.
- Per-call text or JSON output when both formats are allowed; `list`, `usage`, and `cancel_descendants` default to JSON. Set `allowedOutputFormats` to one format to omit the per-call choice.
- Discovery through `ctx.session.list`; requires OpenCode 2.2.5+. Tested against `@opencode/plugin` 2.2.5.
- Input validation for session IDs and text lengths.
- Bundled `SKILL.md` skill with operational guidance.
- Bun test suite, lint, typecheck, and CI scripts.
