import { Error as ToolError } from "@opencode/plugin/promise/tool"

export const REQUIRED_SESSION_ID = "sessionID is required."
export const REQUIRED_TEXT = "text is required."
export const OPENCODE_REQUIREMENT =
  "subagent-tools requires an OpenCode build with ctx.session.list. See the README for the supported version."

/**
 * Refusals are tool errors, not successful results. OpenCode surfaces
 * `Tool.Error` to the model with the reason, so the model can correct course
 * instead of treating a refusal as normal output.
 */
export const toolError = (message: string): never => {
  throw new ToolError({ message })
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
