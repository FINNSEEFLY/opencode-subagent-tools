# Security Policy

## Supported versions

Security fixes are applied to the latest published `0.1.x` release.

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting:

<https://github.com/finnseefly/opencode-subagent-tools/security/advisories/new>

Include:

- the affected version;
- the OpenCode version;
- a minimal reproduction or the relevant plugin configuration;
- the impact you observed;
- any suggested fix or mitigation.

If private reporting is unavailable, open a minimal public issue asking for a
private channel. Do not include exploit details in that issue.

## Scope

This plugin exposes model-facing tools that can interrupt, steer, queue
messages for, and inject context into OpenCode sessions. Reports about
permission or ownership bypass, session-ID confusion, ancestor control under
`sessionControlPolicy`, prompt injection through session titles or metadata,
and denial of service are in scope.

Known limitations are documented in [docs/limitations.md](docs/limitations.md).
The default `sessionControlPolicy` is `"descendants"`; the `"all"` policy is
security-sensitive and should be enabled deliberately.
