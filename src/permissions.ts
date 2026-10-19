import type { Plugin } from "@opencode/plugin"
import {
  MAX_AGENT_NAME_LENGTH,
  MAX_PROMPT_PREVIEW_LENGTH,
  type SessionInfoLike,
} from "./session"
import { clip } from "./text"
import type { ToolCtx } from "./tools/input"

export const PERMISSION_ACTION = "subagent.control"

export interface GuardTarget {
  id: string
  title?: string
  agent?: string
}

export const guardTarget = (
  info: SessionInfoLike | undefined,
  sessionID: string,
): GuardTarget => ({
  id: sessionID,
  title: clip(info?.title, MAX_PROMPT_PREVIEW_LENGTH),
  agent: clip(info?.agent, MAX_AGENT_NAME_LENGTH),
})

export interface GuardDeps {
  permission: Plugin.Context["permission"]
  enabled: boolean
}

export const createGuard = ({ permission, enabled }: GuardDeps) => {
  return async (targets: GuardTarget[], context: ToolCtx) => {
    if (!enabled || targets.length === 0) return
    const sessionID = context.sessionID
    if (!sessionID) {
      throw new Error(
        "Refusing: the calling session is unknown, so permissions cannot be checked.",
      )
    }
    await permission.assert({
      sessionID,
      agent: context.agent,
      source:
        context.messageID && context.id
          ? { type: "tool" as const, messageID: context.messageID, id: context.id }
          : undefined,
      action: PERMISSION_ACTION,
      resources: targets.map((target) => target.id),
      metadata: {
        count: targets.length,
        targets: targets.map((target) => ({
          id: target.id,
          ...(target.title ? { title: target.title } : {}),
          ...(target.agent ? { agent: target.agent } : {}),
        })),
      },
    })
  }
}

export type Guard = ReturnType<typeof createGuard>
