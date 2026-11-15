import {
  isSessionActive,
  type BackgroundJobInfo,
  type BackgroundJobStore,
} from "./background";
import type { LiveStore } from "./live-state";
import {
  MAX_AGENT_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeSessionID,
  type SessionInfoLike,
} from "./session";
import type { RunStatus } from "./status";
import { clip, textLength } from "./text";
import { normalizeTokens, type TokenUsage } from "./tokens";

export interface SessionRow {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  titleTruncated?: boolean;
  launchedAt: number;
  status: RunStatus;
  /** The session's own execution or background work. Descendants are excluded. */
  active: boolean;
  /** The session or any discovered descendant is active. */
  subtreeActive: boolean;
  /** True only when at least one discovered child is active in its subtree. */
  activeDescendants?: boolean;
  backgroundJob?: BackgroundJobInfo;
  cost?: number;
  tokens?: TokenUsage;
}

export const rowFromInfo = (
  live: LiveStore,
  background: BackgroundJobStore,
  info: SessionInfoLike,
  fallback?: SessionRow,
): SessionRow | undefined => {
  const id = normalizeSessionID(info.id) ?? fallback?.id;
  if (!id) return undefined;
  const created = info.time?.created;
  const updated = info.time?.updated;
  const launchedAt =
    typeof created === "number" && Number.isFinite(created)
      ? created
      : (fallback?.launchedAt ??
        (typeof updated === "number" && Number.isFinite(updated) ? updated : 0));
  const status = live.statusFor(info, id);
  const backgroundJob = background.backgroundJobFor(id);
  const active = isSessionActive(status, backgroundJob);
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
    status,
    active,
    subtreeActive: active,
    ...(backgroundJob ? { backgroundJob } : {}),
    cost:
      typeof info.cost === "number" && Number.isFinite(info.cost)
        ? info.cost
        : fallback?.cost,
    tokens: normalizeTokens(info.tokens) ?? fallback?.tokens,
  };
};

/**
 * Fill `subtreeActive` and `activeDescendants` after discovery built the rows.
 * Missing parents are treated as subtree roots; a malformed cycle stops at the
 * repeated row instead of recursing forever.
 */
export const applySubtreeActivity = (rows: SessionRow[]): void => {
  const children = new Map<string, SessionRow[]>();
  for (const row of rows) {
    if (!row.parentID) continue;
    const siblings = children.get(row.parentID) ?? [];
    siblings.push(row);
    children.set(row.parentID, siblings);
  }

  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();

  const subtreeActive = (row: SessionRow): boolean => {
    const cached = memo.get(row.id);
    if (cached !== undefined) return cached;
    // A malformed cycle is treated as active and stops recursion. This is
    // fail-closed and keeps the result independent of row order.
    if (visiting.has(row.id)) return true;
    visiting.add(row.id);
    const descendants = children.get(row.id) ?? [];
    const value = row.active || descendants.some((child) => subtreeActive(child));
    visiting.delete(row.id);
    memo.set(row.id, value);
    return value;
  };

  for (const row of rows) {
    row.subtreeActive = subtreeActive(row);
    const descendants = children.get(row.id) ?? [];
    if (descendants.some((child) => subtreeActive(child))) {
      row.activeDescendants = true;
    } else {
      delete row.activeDescendants;
    }
  }
};
