import type { OutputFormat } from "../config"
import { REQUIRED_SESSION_ID, REQUIRED_TEXT, toolError } from "../errors"
import { normalizeSessionID } from "../session"
import { clipText, maxLengthError } from "../text"
import type { OutputStrategy } from "./output"

export const MAX_REASON_LENGTH = 500
export const MAX_DESCRIPTION_LENGTH = 200

export type ResponseFormat = OutputFormat

export interface ToolInput {
  sessionID?: string
  parentID?: string
  text?: string
  reason?: string
  description?: string
  statuses?: string[]
  limit?: number
  cursor?: string
  format?: ResponseFormat
  includeDescendants?: boolean
  resume?: boolean
}

export interface ToolCtx {
  sessionID?: string
  agent?: string
  messageID?: string
  id?: string
  signal?: AbortSignal
}

export const requireSessionID = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return toolError(REQUIRED_SESSION_ID)
  }
  const sessionID = normalizeSessionID(value)
  if (!sessionID) {
    return toolError("sessionID is invalid; use the exact ID reported by the server.")
  }
  return sessionID
}

export const readOptionalSessionID = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  return normalizeSessionID(value)
}

export const requireText = (value: unknown, max: number): string => {
  const text = clipText(value, max)
  if (!text) return toolError(REQUIRED_TEXT)
  return text
}

export const readTextField = (
  value: unknown,
  max: number,
  field: string,
): { text?: string; error?: string } => {
  const error = maxLengthError(value, max, field)
  if (error) return { error }
  return { text: clipText(value, max) }
}

export const readToolInput = (
  rawInput: unknown,
  outputStrategy: OutputStrategy,
): { input: ToolInput; format: ResponseFormat } => {
  const input = (rawInput ?? {}) as ToolInput
  return { input, format: outputStrategy.selectFormat(input.format) }
}
