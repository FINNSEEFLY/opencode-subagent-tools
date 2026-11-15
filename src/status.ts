import type { SessionInfoLike } from "./session";

export const RUN_STATUS = {
  running: "running",
  stopped: "stopped",
  failed: "failed",
  finished: "finished",
  unknown: "unknown",
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

export const OUTCOME = {
  interrupted: "interrupted",
  failed: "failed",
  succeeded: "succeeded",
} as const;

export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

export const RUN_STATUSES: readonly RunStatus[] = Object.values(RUN_STATUS);
const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES);

export const isRunStatus = (value: string): value is RunStatus =>
  RUN_STATUS_SET.has(value);

export interface RunStatusMeta {
  /** The run is over; no further step is expected without a resume. */
  terminal: boolean;
  /** Persisted usage may lag because the session is active or unresolved. */
  usageMayLag: boolean;
  /** Safe to treat a message with `resume: false` as pending. */
  idle: boolean;
}

export const RUN_STATUS_META: Readonly<Record<RunStatus, RunStatusMeta>> = {
  [RUN_STATUS.running]: { terminal: false, usageMayLag: true, idle: false },
  [RUN_STATUS.stopped]: { terminal: true, usageMayLag: false, idle: true },
  [RUN_STATUS.failed]: { terminal: true, usageMayLag: false, idle: true },
  [RUN_STATUS.finished]: { terminal: true, usageMayLag: false, idle: true },
  // `unknown` may still be running, so it is neither terminal nor idle.
  [RUN_STATUS.unknown]: { terminal: false, usageMayLag: true, idle: false },
};

const RUN_STATUS_META_MAP: ReadonlyMap<RunStatus, RunStatusMeta> = new Map(
  Object.entries(RUN_STATUS_META) as Array<[RunStatus, RunStatusMeta]>,
);

export const runStatusMeta = (status: RunStatus): RunStatusMeta =>
  RUN_STATUS_META_MAP.get(status) ?? RUN_STATUS_META[RUN_STATUS.unknown];

export const runStatusUsageMayLag = (status: RunStatus): boolean =>
  runStatusMeta(status).usageMayLag;

export const runStatusIsIdle = (status: RunStatus | undefined): boolean =>
  status !== undefined && runStatusMeta(status).idle;

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(
  RUN_STATUSES.filter((status) => runStatusMeta(status).terminal),
);

export const OUTCOMES: readonly Outcome[] = Object.values(OUTCOME);
const OUTCOME_SET: ReadonlySet<string> = new Set(OUTCOMES);

export const isOutcome = (value: unknown): value is Outcome =>
  typeof value === "string" && OUTCOME_SET.has(value);

export const OUTCOME_RUN_STATUS: Readonly<Record<Outcome, RunStatus>> = {
  [OUTCOME.interrupted]: RUN_STATUS.stopped,
  [OUTCOME.failed]: RUN_STATUS.failed,
  [OUTCOME.succeeded]: RUN_STATUS.finished,
};

const OUTCOME_RUN_STATUS_MAP: ReadonlyMap<Outcome, RunStatus> = new Map(
  Object.entries(OUTCOME_RUN_STATUS) as Array<[Outcome, RunStatus]>,
);

const runStatusFromOutcome = (outcome: unknown): RunStatus | undefined => {
  if (outcome === undefined) return undefined;
  if (!isOutcome(outcome)) return RUN_STATUS.unknown;
  return OUTCOME_RUN_STATUS_MAP.get(outcome);
};

export const OPENCODE_SESSION_STATUS = {
  busy: "busy",
  retry: "retry",
  idle: "idle",
} as const;

export const BUSY_SESSION_STATUSES: ReadonlySet<string> = new Set([
  OPENCODE_SESSION_STATUS.busy,
  OPENCODE_SESSION_STATUS.retry,
]);

/**
 * Derive a state from a session record. `busy`/`idle` describe the current
 * execution; `outcome` describes the last completed one. A resumed child can be
 * running while its outcome is still the previous run's.
 */
export const runStatusFromSession = (info: SessionInfoLike): RunStatus | undefined => {
  const idle = info.time?.idle;
  const busy = info.time?.busy;
  const outcomeStatus = runStatusFromOutcome(info.outcome);

  // A terminal outcome is recorded at `time.idle`. Without that marker, the
  // outcome is the most reliable evidence we have.
  if (idle === undefined) {
    if (outcomeStatus) return outcomeStatus;
    return typeof busy === "number" ? RUN_STATUS.running : undefined;
  }

  // `busy`/`idle` describe the current execution; `outcome` describes the last
  // completed one. A resumed child can have a stale outcome while busy > idle.
  if (typeof busy === "number" && busy > idle) return RUN_STATUS.running;
  if (outcomeStatus) return outcomeStatus;
  // An unrecognised outcome stays `unknown` instead of falling back to a
  // timestamp heuristic that may claim the session is running.
  return (info.time?.updated ?? 0) > idle ? RUN_STATUS.running : undefined;
};
