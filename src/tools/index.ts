import type { Plugin } from "@opencode/plugin"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import type { Access } from "../access"
import type { Config } from "../config"
import type { Discovery } from "../discovery"
import type { LiveStore } from "../live-state"
import type { SendMessage } from "../messages"
import type { Guard } from "../permissions"
import { registerCancelDescendantsTool } from "./cancel-descendants"
import { registerCancelTool } from "./cancel"
import { registerListTool } from "./list"
import { registerContextTool, registerQueueTool, registerSteerTool } from "./send"
import { registerUsageTool } from "./usage"

export interface ToolDeps {
  config: Config
  access: Access
  discovery: Discovery
  live: LiveStore
  guard: Guard
  sendMessage: SendMessage
  session: Plugin.Context["session"]
  model: Plugin.Context["model"]
}

export const registerTools = (editor: ToolEditor, deps: ToolDeps) => {
  editor.namespace({
    name: deps.config.namespace,
    description: "Inspect, stop, steer and feed context to subagent sessions.",
  })

  registerListTool(editor, deps)
  registerUsageTool(editor, deps)
  registerCancelTool(editor, deps)
  registerCancelDescendantsTool(editor, deps)
  registerSteerTool(editor, deps)
  registerQueueTool(editor, deps)
  registerContextTool(editor, deps)
}
