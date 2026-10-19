import type { SessionInfoLike } from "./session"

export const STATUS = {
  running: "running",
  stopped: "stopped",
  failed: "failed",
  finished: "finished",
  unknown: "unknown",
} as const

export type ChildStatus = (typeof STATUS)[keyof typeof STATUS]

export const OUTCOME = {
  interrupted: "interrupted",
  failed: "failed",
  succeeded: "succeeded",
} as const

export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME]

export const CHILD_STATUSES: readonly ChildStatus[] = Object.values(STATUS)
const CHILD_STATUS_SET: ReadonlySet<string> = new Set(CHILD_STATUSES)

export const isChildStatus = (value: string): value is ChildStatus =>
  CHILD_STATUS_SET.has(value)

export interface StatusMeta {
  /** The run is over; no further step is expected without a resume. */
  terminal: boolean
  /** Persisted usage may lag because the session is active or unresolved. */
  usageMayLag: boolean
  /** Safe to treat a message with `resume: false` as pending. */
  idle: boolean
}

export const STATUS_META: Readonly<Record<ChildStatus, StatusMeta>> = {
  [STATUS.running]: { terminal: false, usageMayLag: true, idle: false },
  [STATUS.stopped]: { terminal: true, usageMayLag: false, idle: true },
  [STATUS.failed]: { terminal: true, usageMayLag: false, idle: true },
  [STATUS.finished]: { terminal: true, usageMayLag: false, idle: true },
  // `unknown` may still be running, so it is neither terminal nor idle.
  [STATUS.unknown]: { terminal: false, usageMayLag: true, idle: false },
}

const STATUS_META_MAP: ReadonlyMap<ChildStatus, StatusMeta> = new Map(
  Object.entries(STATUS_META) as Array<[ChildStatus, StatusMeta]>,
)

export const statusMeta = (status: ChildStatus): StatusMeta =>
  STATUS_META_MAP.get(status) ?? STATUS_META[STATUS.unknown]

export const statusUsageMayLag = (status: ChildStatus): boolean =>
  statusMeta(status).usageMayLag

export const statusIsIdle = (status: ChildStatus | undefined): boolean =>
  status !== undefined && statusMeta(status).idle

export const TERMINAL_STATUSES: ReadonlySet<ChildStatus> = new Set(
  CHILD_STATUSES.filter((status) => statusMeta(status).terminal),
)

export const OUTCOMES: readonly Outcome[] = Object.values(OUTCOME)
const OUTCOME_SET: ReadonlySet<string> = new Set(OUTCOMES)

export const isOutcome = (value: unknown): value is Outcome =>
  typeof value === "string" && OUTCOME_SET.has(value)

export const OUTCOME_STATUS: Readonly<Record<Outcome, ChildStatus>> = {
  [OUTCOME.interrupted]: STATUS.stopped,
  [OUTCOME.failed]: STATUS.failed,
  [OUTCOME.succeeded]: STATUS.finished,
}

const OUTCOME_STATUS_MAP: ReadonlyMap<Outcome, ChildStatus> = new Map(
  Object.entries(OUTCOME_STATUS) as Array<[Outcome, ChildStatus]>,
)

const statusFromOutcome = (outcome: unknown): ChildStatus | undefined => {
  if (outcome === undefined) return undefined
  if (!isOutcome(outcome)) return STATUS.unknown
  return OUTCOME_STATUS_MAP.get(outcome)
}

export const SESSION_STATUS = {
  busy: "busy",
  retry: "retry",
  idle: "idle",
} as const

export const BUSY_SESSION_STATUSES: ReadonlySet<string> = new Set([
  SESSION_STATUS.busy,
  SESSION_STATUS.retry,
])

/**
 * Derive a state from a session record. `busy`/`idle` describe the current
 * execution; `outcome` describes the last completed one. A resumed child can be
 * running while its outcome is still the previous run's.
 */
export const statusFromSession = (info: SessionInfoLike): ChildStatus | undefined => {
  const idle = info.time?.idle
  const busy = info.time?.busy
  const outcomeStatus = statusFromOutcome(info.outcome)

  // A terminal outcome is recorded at `time.idle`. Without that marker, the
  // outcome is the most reliable evidence we have.
  if (idle === undefined) {
    if (outcomeStatus) return outcomeStatus
    return typeof busy === "number" ? STATUS.running : undefined
  }

  // `busy`/`idle` describe the current execution; `outcome` describes the last
  // completed one. A resumed child can have a stale outcome while busy > idle.
  if (typeof busy === "number" && busy > idle) return STATUS.running
  if (outcomeStatus) return outcomeStatus
  // An unrecognised outcome stays `unknown` instead of falling back to a
  // timestamp heuristic that may claim the session is running.
  return (info.time?.updated ?? 0) > idle ? STATUS.running : undefined
}
