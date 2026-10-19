import type { LiveStore } from "./live-state"
import { normalizeSessionID } from "./session"
import { BUSY_SESSION_STATUSES, SESSION_STATUS, STATUS, type ChildStatus } from "./status"

export const EVENT = {
  status: "session.status",
  executionStarted: "session.execution.started",
  executionSucceeded: "session.execution.succeeded",
  executionFailed: "session.execution.failed",
  executionInterrupted: "session.execution.interrupted",
  deleted: "session.deleted",
  idle: "session.idle",
} as const

export type EventType = (typeof EVENT)[keyof typeof EVENT]

export const SERVER_CONNECTED_EVENT = "server.connected"

const EVENT_KIND = {
  status: "status",
  started: "started",
  terminal: "terminal",
} as const

type EventMeta =
  | { kind: typeof EVENT_KIND.status }
  | { kind: typeof EVENT_KIND.started }
  | { kind: typeof EVENT_KIND.terminal; status: ChildStatus }

export const EVENT_META: Readonly<Record<EventType, EventMeta>> = {
  [EVENT.status]: { kind: EVENT_KIND.status },
  [EVENT.executionStarted]: { kind: EVENT_KIND.started },
  [EVENT.executionSucceeded]: { kind: EVENT_KIND.terminal, status: STATUS.finished },
  [EVENT.executionFailed]: { kind: EVENT_KIND.terminal, status: STATUS.failed },
  [EVENT.executionInterrupted]: { kind: EVENT_KIND.terminal, status: STATUS.stopped },
  [EVENT.deleted]: { kind: EVENT_KIND.terminal, status: STATUS.stopped },
  [EVENT.idle]: { kind: EVENT_KIND.terminal, status: STATUS.unknown },
}

const EVENT_META_MAP: ReadonlyMap<string, EventMeta> = new Map(
  Object.entries(EVENT_META) as Array<[string, EventMeta]>,
)

export const EVENT_TYPES: readonly EventType[] = Object.keys(EVENT_META) as EventType[]

export const TERMINAL_EVENT_STATUS: ReadonlyMap<string, ChildStatus> = new Map(
  Object.entries(EVENT_META)
    .filter(
      (entry): entry is [string, Extract<EventMeta, { kind: "terminal" }>] =>
        entry[1].kind === EVENT_KIND.terminal,
    )
    .map(([type, meta]) => [type, meta.status]),
)

export const EVENT_RETRY_BASE_MS = 500
export const EVENT_RETRY_MAX_MS = 30_000

export interface EventLike {
  type?: string
  created?: number
  data?: {
    sessionID?: unknown
    status?: { type?: unknown }
  }
}

export interface EventSubscriptionOptions {
  signal: AbortSignal
  types?: readonly EventType[]
  onActivity?: () => void
}

export interface EventApi {
  subscribe?: (options: EventSubscriptionOptions) => AsyncIterable<EventLike>
}

export const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    let onAbort: () => void
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
    // Abort may have fired between the initial check and addEventListener.
    if (signal.aborted) onAbort()
  })

export const handleEvent = (live: LiveStore, event: EventLike) => {
  const type = event?.type
  const data = event?.data ?? {}
  const id = normalizeSessionID(data.sessionID)
  if (!id) return
  const meta = type ? EVENT_META_MAP.get(type) : undefined
  if (!meta) return
  const eventAt =
    typeof event?.created === "number" &&
    Number.isFinite(event.created) &&
    event.created > 0
      ? event.created
      : Date.now()
  const previous = live.live.get(id)

  if (meta.kind === EVENT_KIND.status) {
    const kind = data.status?.type
    if (typeof kind !== "string") return
    if (BUSY_SESSION_STATUSES.has(kind)) {
      if (eventAt <= live.lastTransitionAt(id)) return
      live.rememberStarted(id, eventAt)
    } else if (kind === SESSION_STATUS.idle) {
      if (eventAt < live.lastTransitionAt(id)) return
      if ((previous?.activeAt ?? 0) > 0 || previous?.status === STATUS.running) {
        live.rememberTerminal(id, STATUS.unknown, eventAt)
      }
    }
    return
  }

  if (meta.kind === EVENT_KIND.started) {
    if (eventAt <= live.lastTransitionAt(id)) return
    live.rememberStarted(id, eventAt)
    return
  }

  if (eventAt < live.lastTransitionAt(id)) return
  if (
    meta.status === STATUS.unknown &&
    (previous?.activeAt ?? 0) === 0 &&
    previous?.status !== STATUS.running
  )
    return
  live.rememberTerminal(id, meta.status, eventAt)
}

export interface EventStreamDeps {
  event: EventApi | undefined
  live: LiveStore
  signal: AbortSignal
}

/**
 * Start the event stream only after tool registration succeeded, so a setup
 * failure cannot leave a background subscriber behind. OpenCode's shared
 * event stream does not reconnect after a failure, so recreate it here;
 * `onActivity` also covers keepalive frames.
 */
export const startEventStream = ({ event, live, signal }: EventStreamDeps) => {
  const subscribe = event?.subscribe
  if (typeof subscribe !== "function") return

  const subscribeBound = subscribe.bind(event)
  void (async () => {
    let attempt = 0
    while (!signal.aborted) {
      let healthy = false
      const connectedAt = Date.now()
      try {
        const stream = subscribeBound({
          signal,
          types: EVENT_TYPES,
          onActivity: () => {
            // Ignore the initial server.connected frame; only transport
            // activity after a short grace period proves the stream is live.
            if (Date.now() - connectedAt < EVENT_RETRY_BASE_MS) return
            healthy = true
            attempt = 0
          },
        })
        for await (const incoming of stream) {
          if (incoming.type === SERVER_CONNECTED_EVENT) continue
          healthy = true
          attempt = 0
          handleEvent(live, incoming)
        }
      } catch (error) {
        if (signal.aborted) return
        console.error("subagent-tools: event stream stopped", error)
      }
      if (signal.aborted) return
      const delay = Math.min(EVENT_RETRY_MAX_MS, EVENT_RETRY_BASE_MS * 2 ** attempt)
      if (!healthy) attempt++
      await sleep(delay, signal)
    }
  })()
}
