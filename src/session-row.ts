import type { LiveStore } from "./live-state"
import {
  MAX_AGENT_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeSessionID,
  type SessionInfoLike,
} from "./session"
import type { ChildStatus } from "./status"
import { clip, textLength } from "./text"
import { normalizeTokens, type TokenUsage } from "./tokens"

export interface SessionRow {
  id: string
  parentID?: string
  agent?: string
  title?: string
  titleTruncated?: boolean
  launchedAt: number
  status: ChildStatus
  cost?: number
  tokens?: TokenUsage
}

export const rowFromInfo = (
  live: LiveStore,
  info: SessionInfoLike,
  fallback?: SessionRow,
): SessionRow | undefined => {
  const id = normalizeSessionID(info.id) ?? fallback?.id
  if (!id) return undefined
  const created = info.time?.created
  const updated = info.time?.updated
  const launchedAt =
    typeof created === "number" && Number.isFinite(created)
      ? created
      : (fallback?.launchedAt ??
        (typeof updated === "number" && Number.isFinite(updated) ? updated : 0))
  return {
    id,
    parentID: normalizeSessionID(info.parentID) ?? fallback?.parentID,
    agent: clip(info.agent, MAX_AGENT_NAME_LENGTH) ?? fallback?.agent,
    title: clip(info.title, MAX_TITLE_LENGTH) ?? fallback?.title,
    titleTruncated:
      typeof info.title === "string"
        ? textLength(info.title) > MAX_TITLE_LENGTH
        : fallback?.titleTruncated,
    launchedAt,
    status: live.statusFor(info, id),
    cost:
      typeof info.cost === "number" && Number.isFinite(info.cost)
        ? info.cost
        : fallback?.cost,
    tokens: normalizeTokens(info.tokens) ?? fallback?.tokens,
  }
}
