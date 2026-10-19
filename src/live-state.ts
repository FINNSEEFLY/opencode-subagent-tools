import type { SessionInfoLike } from "./session"
import { STATUS, TERMINAL_STATUSES, statusFromSession, type ChildStatus } from "./status"

export const MAX_LIVE_SESSIONS = 500

/** Process-local live evidence for a session. Never persisted. */
export interface LiveState {
  /** Last live start timestamp; 0 when the last observed transition was terminal. */
  activeAt: number
  status?: ChildStatus
  /** Last live start/terminal timestamp, used to drop out-of-order events. */
  lastStartedAt: number
  lastTerminalAt: number
}

export const lastTransitionAt = (state: LiveState | undefined): number =>
  Math.max(state?.lastStartedAt ?? 0, state?.lastTerminalAt ?? 0)

export const createLiveState = () => {
  const live = new Map<string, LiveState>()

  const rememberLive = (id: string, patch: Partial<LiveState>) => {
    const previous = live.get(id)
    // Re-insert so Map iteration order stays least-recently-used first.
    if (previous) live.delete(id)
    live.set(id, {
      activeAt: patch.activeAt ?? previous?.activeAt ?? 0,
      status: patch.status ?? previous?.status,
      lastStartedAt: patch.lastStartedAt ?? previous?.lastStartedAt ?? 0,
      lastTerminalAt: patch.lastTerminalAt ?? previous?.lastTerminalAt ?? 0,
    })
    while (live.size > MAX_LIVE_SESSIONS) {
      const oldest = live.keys().next().value
      if (oldest === undefined) break
      live.delete(oldest)
    }
  }

  const rememberStarted = (id: string, at: number) => {
    rememberLive(id, { activeAt: at, status: STATUS.running, lastStartedAt: at })
  }

  const rememberTerminal = (id: string, status: ChildStatus, at: number) => {
    rememberLive(id, { activeAt: 0, status, lastTerminalAt: at })
  }

  const liveStatusFor = (id: string): ChildStatus | undefined => {
    const state = live.get(id)
    if (!state) return undefined
    if (state.activeAt > 0) return STATUS.running
    return state.status
  }

  /**
   * Prefer a live start newer than the session marker (a resumed child with a
   * stale outcome), then a live terminal or idle event at least as new as the
   * marker. Everything else falls back to the session record.
   */
  const statusFor = (info: SessionInfoLike, id: string): ChildStatus => {
    const state = live.get(id)
    // `time.idle` is the canonical terminal marker. When it is absent, use
    // `time.updated` as a conservative marker so a stale live event cannot
    // override a newer session record.
    const marker = info.time?.idle ?? info.time?.updated ?? 0
    const activeAt = state?.activeAt ?? 0
    if (activeAt > 0 && (marker === 0 || activeAt > marker)) return STATUS.running

    const liveStatus = state?.status
    const liveAt = state?.lastTerminalAt ?? 0
    if (liveStatus !== undefined) {
      const terminal =
        TERMINAL_STATUSES.has(liveStatus) || (liveStatus === STATUS.unknown && liveAt > 0)
      if (terminal && (marker === 0 || liveAt >= marker)) return liveStatus
    }

    return statusFromSession(info) ?? STATUS.unknown
  }

  return {
    live,
    rememberLive,
    rememberStarted,
    rememberTerminal,
    liveStatusFor,
    statusFor,
    lastTransitionAt: (id: string) => lastTransitionAt(live.get(id)),
  }
}

export type LiveStore = ReturnType<typeof createLiveState>
