/**
 * subagent-tools — discovery-first control for OpenCode subagents.
 *
 * OpenCode exposes `session.list`, `session.get`, `session.interrupt`, and
 * `session.prompt { delivery: "steer" }` to plugins. This plugin adds the
 * model-facing surface:
 *
 *   subagent_list          what is (or was) running, with observed state
 *   subagent_usage         cost, cumulative tokens, and current context footprint
 *   subagent_cancel        stop one session by its session ID
 *   subagent_cancel_descendants stop running descendants in the caller's subtree
 *   subagent_steer         add a turn-level instruction to a running child
 *   subagent_queue         add a follow-up turn after the current run settles
 *   subagent_context       inject context into a child without requesting a turn
 *
 * Discovery is authoritative: every `list`/`cancel_descendants` walks the server's
 * session tree with `ctx.session.list`. A small in-memory live map, fed by
 * `session.status`, `session.execution.*`, `session.idle` and `session.deleted`
 * events, adds freshness for the current process. Nothing is persisted: after a restart the server's session
 * records are the source of truth.
 *
 * Single-target mutations follow `sessionControlPolicy`: the caller's subtree
 * by default, any session except ancestors, or any session except the caller.
 * `cancel_descendants` always stays inside the caller's subtree; read-only tools are
 * intentionally unrestricted.
 *
 * Approval: `enforcePermissions` defaults to true, so every mutation is routed
 * through `ctx.permission.assert` with the action `subagent.control`.
 * `cancel_descendants` checks the whole batch in one permission request.
 *
 * Requires an OpenCode build with `ctx.session.list`.
 */

import { Plugin } from "@opencode/plugin"
import { createAccess } from "./access"
import { resolveConfig } from "./config"
import { createDiscovery } from "./discovery"
import { OPENCODE_REQUIREMENT } from "./errors"
import { startEventStream, type EventApi } from "./events"
import { createLiveState } from "./live-state"
import { createSendMessage } from "./messages"
import { createGuard } from "./permissions"
import type { SessionList } from "./session"
import { registerSkill } from "./skill"
import { registerTools } from "./tools"

export default Plugin.define({
  id: "subagent-tools",

  async setup(ctx) {
    const config = resolveConfig(ctx.options)

    const rawSessionList = (ctx.session as { list?: unknown }).list
    const sessionList =
      typeof rawSessionList === "function"
        ? (rawSessionList.bind(ctx.session) as SessionList)
        : undefined
    if (!sessionList) throw new Error(OPENCODE_REQUIREMENT)

    const live = createLiveState()
    const discovery = createDiscovery({
      sessionList,
      live,
      limits: config.limits,
    })
    const access = createAccess({
      session: ctx.session,
      limits: config.limits,
      policy: config.sessionControlPolicy,
      namespace: config.namespace,
    })
    const guard = createGuard({
      permission: ctx.permission,
      enabled: config.enforcePermissions,
    })
    const sendMessage = createSendMessage({
      session: ctx.session,
      access,
      guard,
      live,
    })

    const toolsRegistration = await ctx.tool.transform((editor) => {
      registerTools(editor, {
        config,
        access,
        discovery,
        live,
        guard,
        sendMessage,
        session: ctx.session,
        model: ctx.model,
      })
    })

    const skillRegistration = config.registerSkill
      ? await registerSkill(ctx.skill)
      : undefined

    // Start the event stream only after tool registration succeeded, so a setup
    // failure cannot leave a background subscriber behind.
    const eventsAbort = new AbortController()
    startEventStream({
      event: ctx.event as unknown as EventApi | undefined,
      live,
      signal: eventsAbort.signal,
    })

    // Stop the event stream when the plugin unloads or its config reloads.
    return async () => {
      eventsAbort.abort()
      if (skillRegistration) await skillRegistration.dispose().catch(() => undefined)
      await toolsRegistration.dispose().catch(() => undefined)
    }
  },
})
