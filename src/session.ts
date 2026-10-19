import { hasUnsafeIdCharacters } from "./text"

export const MAX_SESSION_ID_LENGTH = 80
export const MAX_AGENT_NAME_LENGTH = 80
export const MAX_TITLE_LENGTH = 200
export const MAX_PROMPT_PREVIEW_LENGTH = 60

export interface RequestOptions {
  signal?: AbortSignal
}

export interface TokenUsageLike {
  input?: unknown
  output?: unknown
  reasoning?: unknown
  cache?: { read?: unknown; write?: unknown }
}

export interface ModelRefLike {
  id?: string
  providerID?: string
  variant?: string
}

export interface ModelInfoLike {
  id?: string
  modelID?: string
  providerID?: string
  limit?: { context?: number }
}

export interface SessionInfoLike {
  id?: string
  parentID?: string
  agent?: string
  title?: string
  outcome?: string
  model?: ModelRefLike
  cost?: number
  tokens?: TokenUsageLike
  revert?: { messageID?: string }
  time?: {
    created?: number
    updated?: number
    busy?: number
    idle?: number
  }
}

/** Normalize a model- or server-provided session ID without silently truncating it. */
export const normalizeSessionID = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const id = value.trim()
  if (id.length === 0 || id.length > MAX_SESSION_ID_LENGTH || hasUnsafeIdCharacters(id)) {
    return undefined
  }
  return id
}

export const MESSAGE_TYPE = {
  assistant: "assistant",
  compaction: "compaction",
} as const

export const MESSAGE_STATUS = {
  completed: "completed",
} as const

export interface UsageMessage {
  id?: string
  type?: string
  status?: string
  tokens?: TokenUsageLike
  model?: ModelRefLike
}

export interface SessionListPage {
  data?: SessionInfoLike[]
  cursor?: { next?: string | null }
}

export type SessionListResult = SessionListPage | SessionInfoLike[]

export type SessionList = (
  input: {
    parentID?: string
    limit?: number
    order?: "asc" | "desc"
    archived?: boolean
    cursor?: string
  },
  options?: RequestOptions,
) => Promise<SessionListResult | undefined>

const isSessionInfoLike = (value: unknown): value is SessionInfoLike =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as SessionInfoLike).id === "string" &&
  (value as SessionInfoLike).id!.length > 0

export interface SessionListPageResult {
  items: SessionInfoLike[]
  cursor?: string
  /** False when the response or one of its items was malformed. */
  valid: boolean
}

/**
 * Accept both the current `{ data, cursor }` response and a bare array.
 * A malformed response is reported as invalid instead of looking like a
 * complete empty page.
 */
export const readSessionListPage = (
  value: SessionListResult | undefined,
): SessionListPageResult => {
  if (Array.isArray(value)) {
    const items = value.filter(isSessionInfoLike)
    return { items, valid: items.length === value.length }
  }
  if (!value || typeof value !== "object" || !Array.isArray(value.data)) {
    return { items: [], valid: false }
  }
  const items = value.data.filter(isSessionInfoLike)
  const cursorValue: unknown = value.cursor
  let cursor: string | undefined
  let cursorValid = true
  if (cursorValue !== undefined && cursorValue !== null) {
    if (typeof cursorValue !== "object" || Array.isArray(cursorValue)) {
      cursorValid = false
    } else {
      const next = (cursorValue as { next?: unknown }).next
      if (typeof next === "string" && next.length > 0) cursor = next
      else if (next !== undefined && next !== null) cursorValid = false
    }
  }
  return {
    items,
    cursor,
    valid: items.length === value.data.length && cursorValid,
  }
}
