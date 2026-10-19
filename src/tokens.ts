import {
  MESSAGE_STATUS,
  MESSAGE_TYPE,
  type ModelRefLike,
  type TokenUsageLike,
  type UsageMessage,
} from "./session"

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface LastRequestUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

export const normalizeTokens = (value: unknown): TokenUsage | undefined => {
  if (!value || typeof value !== "object") return undefined
  const tokens = value as TokenUsageLike
  const input = isNumber(tokens.input) ? tokens.input : undefined
  const output = isNumber(tokens.output) ? tokens.output : undefined
  const reasoning = isNumber(tokens.reasoning) ? tokens.reasoning : undefined
  const cacheRead = isNumber(tokens.cache?.read) ? tokens.cache.read : undefined
  const cacheWrite = isNumber(tokens.cache?.write) ? tokens.cache.write : undefined

  // An object with no numeric token fields is missing data, not zero usage.
  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined
  }

  return {
    input: input ?? 0,
    output: output ?? 0,
    reasoning: reasoning ?? 0,
    cache: {
      read: cacheRead ?? 0,
      write: cacheWrite ?? 0,
    },
  }
}

export const tokensUsed = (tokens: TokenUsage): number =>
  tokens.input + tokens.output + tokens.reasoning

export const tokensTotal = (tokens: TokenUsage): number =>
  tokensUsed(tokens) + tokens.cache.read + tokens.cache.write

export const addTokens = (
  left?: TokenUsage,
  right?: TokenUsage,
): TokenUsage | undefined => {
  if (!left) return right
  if (!right) return left
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cache: {
      read: left.cache.read + right.cache.read,
      write: left.cache.write + right.cache.write,
    },
  }
}

export const CONTEXT_USAGE = {
  usage: "usage",
  empty: "empty",
  missing: "missing",
} as const

export type ContextUsage =
  | {
      kind: typeof CONTEXT_USAGE.usage
      total: number
      lastRequest: LastRequestUsage
      model?: ModelRefLike
    }
  | { kind: typeof CONTEXT_USAGE.empty }
  | { kind: typeof CONTEXT_USAGE.missing }

/**
 * Reproduce the UI's context number: the last assistant step after the last
 * completed compaction and before the staged-revert boundary. All five token
 * fields are included, matching the OpenCode UI.
 *
 * `empty` means there is no assistant step after compaction; `missing` means
 * the step exists but its token data is unavailable. The two are not the same
 * as a real zero.
 */
export const contextFromMessages = (
  messages: readonly UsageMessage[],
  revertMessageID?: string,
): ContextUsage | undefined => {
  let end = messages.length
  if (revertMessageID) {
    const boundary = messages.findIndex((message) => message?.id === revertMessageID)
    if (boundary === -1) return undefined
    end = boundary
  }

  let compactionIndex = -1
  for (let index = end - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) continue
    if (
      message.type === MESSAGE_TYPE.compaction &&
      message.status === MESSAGE_STATUS.completed
    ) {
      compactionIndex = index
      break
    }
  }

  for (let index = end - 1; index > compactionIndex; index--) {
    const message = messages[index]
    if (!message || message.type !== MESSAGE_TYPE.assistant) continue
    const tokens = normalizeTokens(message.tokens)
    if (!tokens) return { kind: CONTEXT_USAGE.missing }
    return {
      kind: CONTEXT_USAGE.usage,
      total: tokensTotal(tokens),
      lastRequest: {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: tokens.cache.read,
        cacheWrite: tokens.cache.write,
        total: tokensTotal(tokens),
      },
      model: message.model,
    }
  }
  return { kind: CONTEXT_USAGE.empty }
}

export const TOKEN_USAGE_SCHEMA = {
  type: "object",
  properties: {
    input: { type: "integer" },
    output: { type: "integer" },
    reasoning: { type: "integer" },
    cache: {
      type: "object",
      properties: {
        read: { type: "integer" },
        write: { type: "integer" },
      },
      required: ["read", "write"],
      additionalProperties: false,
    },
  },
  required: ["input", "output", "reasoning", "cache"],
  additionalProperties: false,
} as const
