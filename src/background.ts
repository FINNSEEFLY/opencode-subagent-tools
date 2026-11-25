import { normalizeSessionID } from "./session";
import { RUN_STATUS, type RunStatus } from "./status";
import { isUnsafeControlCode } from "./text";

interface BackgroundJobSpec {
  /** Extract a normalized job key from an idle item. */
  key: (item: Record<string, unknown>) => string | undefined;
  /** Tool names whose running call proves this background kind. */
  tools: readonly string[];
}

const BACKGROUND_JOB_SPECS = {
  shell: {
    key: (item) => normalizeBackgroundKey(item.shellID),
    tools: ["shell"],
  },
  image: {
    key: (item) =>
      normalizeBackgroundKey(item.path) ?? normalizeBackgroundKey(item.model),
    tools: ["generate_image", "experimental_image_generate"],
  },
  video: {
    key: (item) => normalizeBackgroundKey(item.path),
    tools: ["generate_video"],
  },
  subagent: {
    key: (item) => normalizeSessionID(item.childSessionID),
    tools: ["subagent"],
  },
  codemode: {
    key: (item) => normalizeBackgroundKey(item.jobID),
    tools: [],
  },
} as const satisfies Record<string, BackgroundJobSpec>;

export type BackgroundJobKind = keyof typeof BACKGROUND_JOB_SPECS;

export const BACKGROUND_JOB_KINDS: readonly BackgroundJobKind[] = Object.keys(
  BACKGROUND_JOB_SPECS,
) as BackgroundJobKind[];

export const BACKGROUND_JOB_KIND = Object.fromEntries(
  BACKGROUND_JOB_KINDS.map((kind) => [kind, kind]),
) as { readonly [K in BackgroundJobKind]: K };

const BACKGROUND_JOB_KIND_SET: ReadonlySet<string> = new Set(BACKGROUND_JOB_KINDS);

const isBackgroundJobKind = (value: unknown): value is BackgroundJobKind =>
  typeof value === "string" && BACKGROUND_JOB_KIND_SET.has(value);

export interface BackgroundJobInfo {
  kinds: BackgroundJobKind[];
  mayRemain?: boolean;
  stateUnknown?: boolean;
}

export const BACKGROUND_JOB_SCHEMA = {
  type: "object",
  properties: {
    kinds: {
      type: "array",
      items: { type: "string", enum: [...BACKGROUND_JOB_KINDS] },
    },
    mayRemain: { type: "boolean" },
    stateUnknown: { type: "boolean" },
  },
  required: ["kinds"],
  additionalProperties: false,
} as const;

export const backgroundJobLabel = (job: BackgroundJobInfo): string => {
  const kinds = job.kinds.join(",");
  if (job.stateUnknown) return kinds ? `${kinds},?` : "unknown";
  return kinds || "unknown";
};

/** Own activity: running, unknown, or any observed background work. */
export const isSessionActive = (
  status: RunStatus | undefined,
  backgroundJob: BackgroundJobInfo | undefined,
): boolean =>
  status === undefined ||
  status === RUN_STATUS.running ||
  status === RUN_STATUS.unknown ||
  backgroundJob !== undefined;

export const MAX_BACKGROUND_SESSIONS = 500;
export const MAX_BACKGROUND_JOBS_PER_KIND = 100;
export const MAX_BACKGROUND_KEY_LENGTH = 500;

/** Validate a shell/image/video key without rejecting spaces in paths. */
export const normalizeBackgroundKey = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  if (key.length === 0 || key.length > MAX_BACKGROUND_KEY_LENGTH) return undefined;
  const unsafe = Array.from(key).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return isUnsafeControlCode(code);
  });
  return unsafe ? undefined : key;
};

interface BackgroundState {
  /** Jobs grouped by kind, then keyed by their normalized ID or path. */
  jobs: Map<BackgroundJobKind, Map<string, number>>;
  /** Last idle snapshot applied for this session, trusted or not. */
  snapshotAt: number;
  /** Whether an idle snapshot has ever been authoritative for this session. */
  hasAuthoritativeSnapshot: boolean;
  /** Descendant owners named by the last idle snapshot. */
  snapshotOwners: Set<string>;
  /** Evidence that background work remains but its kind is unknown. */
  unknownAt: number;
}

const createState = (): BackgroundState => ({
  jobs: new Map(),
  snapshotAt: 0,
  hasAuthoritativeSnapshot: false,
  snapshotOwners: new Set(),
  unknownAt: 0,
});

const stateJobMap = (
  state: BackgroundState,
  kind: BackgroundJobKind,
): Map<string, number> => {
  const existing = state.jobs.get(kind);
  if (existing) return existing;
  const map = new Map<string, number>();
  state.jobs.set(kind, map);
  return map;
};

const trimMap = (map: Map<string, number>, limit: number) => {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
};

const trimSet = (set: Set<string>, limit: number) => {
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
};

const clearAtOrBefore = (state: BackgroundState, at: number) => {
  for (const map of state.jobs.values()) {
    for (const [key, startedAt] of map) {
      if (startedAt <= at) map.delete(key);
    }
  }
  if (state.unknownAt > 0 && state.unknownAt <= at) state.unknownAt = 0;
};

const addJob = (
  state: BackgroundState,
  kind: BackgroundJobKind,
  key: string,
  at: number,
) => {
  const map = stateJobMap(state, kind);
  const existing = map.get(key);
  if (existing !== undefined && existing > at) return;
  map.delete(key);
  map.set(key, at);
  trimMap(map, MAX_BACKGROUND_JOBS_PER_KIND);
};

const removeJob = (
  state: BackgroundState,
  kind: BackgroundJobKind,
  key: string,
  at: number,
) => {
  const map = stateJobMap(state, kind);
  const existing = map.get(key);
  if (existing === undefined || at < existing) return;
  map.delete(key);
};

const markUnknown = (state: BackgroundState, at: number) => {
  state.unknownAt = Math.max(state.unknownAt, at);
};

interface ParsedIdleItem {
  kind: BackgroundJobKind;
  key: string;
  owner: string;
}

type IdleItemParse = { ok: true; item: ParsedIdleItem } | { ok: false; owner?: string };

const parseIdleItem = (value: unknown): IdleItemParse => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false };
  }
  const item = value as Record<string, unknown>;
  const owner = normalizeSessionID(item.sessionID);
  if (!isBackgroundJobKind(item.kind)) {
    return owner ? { ok: false, owner } : { ok: false };
  }
  if (!owner) return { ok: false };

  const key = BACKGROUND_JOB_SPECS[item.kind].key(item);
  return key ? { ok: true, item: { kind: item.kind, key, owner } } : { ok: false, owner };
};

export interface BackgroundContextSession {
  context: (
    input: { sessionID: string },
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
}

export interface BackgroundProbeInput {
  session: BackgroundContextSession;
  targetID: string;
  signal?: AbortSignal;
}

export interface BackgroundProbeResult {
  backgroundJob?: BackgroundJobInfo;
  subtreeActive: boolean;
  failed: boolean;
}

interface ProbeToolPart {
  type?: unknown;
  name?: unknown;
  state?: { status?: unknown };
}

interface ProbeMessage {
  type?: unknown;
  status?: unknown;
  content?: unknown;
}

interface ContextRead {
  messages: ProbeMessage[];
  failed: boolean;
}

const readContext = async (
  session: BackgroundContextSession,
  sessionID: string,
  signal?: AbortSignal,
): Promise<ContextRead> => {
  try {
    const result = await session.context({ sessionID }, { signal });
    if (!Array.isArray(result)) return { messages: [], failed: true };
    const messages: ProbeMessage[] = [];
    let failed = false;
    for (const item of result) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        failed = true;
        continue;
      }
      messages.push(item as ProbeMessage);
    }
    return { messages, failed };
  } catch {
    return { messages: [], failed: true };
  }
};

/** Tool names whose running call proves the session owns that background kind. */
const RUNNING_TOOL_KIND: ReadonlyMap<string, BackgroundJobKind> = new Map(
  BACKGROUND_JOB_KINDS.flatMap((kind) =>
    BACKGROUND_JOB_SPECS[kind].tools.map((name) => [name, kind] as const),
  ),
);

const scanTargetMessages = (
  messages: readonly ProbeMessage[],
  kinds: Set<BackgroundJobKind>,
) => {
  for (const message of messages) {
    if (message.type === "shell" && message.status === "running") {
      kinds.add(BACKGROUND_JOB_KIND.shell);
    }
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue;
    for (const raw of message.content) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const part = raw as ProbeToolPart;
      if (part.type !== "tool" || part.state?.status !== "running") continue;
      const kind =
        typeof part.name === "string" ? RUNNING_TOOL_KIND.get(part.name) : undefined;
      if (kind) kinds.add(kind);
    }
  }
};

export const createBackgroundJobStore = () => {
  const states = new Map<string, BackgroundState>();
  const deletedAt = new Map<string, number>();

  const stateFor = (sessionID: string): BackgroundState => {
    const existing = states.get(sessionID);
    if (existing) {
      // Keep Map iteration order least-recently-used first.
      states.delete(sessionID);
      states.set(sessionID, existing);
      return existing;
    }
    const state = createState();
    states.set(sessionID, state);
    while (states.size > MAX_BACKGROUND_SESSIONS) {
      const oldest = states.keys().next().value;
      if (oldest === undefined) break;
      states.delete(oldest);
    }
    return state;
  };

  const isDeletedAtOrAfter = (sessionID: string, at: number): boolean =>
    at <= (deletedAt.get(sessionID) ?? 0);

  const rememberDeleted = (sessionID: string, at: number) => {
    const previous = deletedAt.get(sessionID) ?? 0;
    if (at < previous) return;
    deletedAt.delete(sessionID);
    deletedAt.set(sessionID, at);
    trimMap(deletedAt, MAX_BACKGROUND_SESSIONS);
  };

  const recordShellStarted = (sessionID: string, shellID: unknown, at: number) => {
    const id = normalizeSessionID(sessionID);
    const key = normalizeBackgroundKey(shellID);
    if (!id || !key || isDeletedAtOrAfter(id, at)) return;
    const state = stateFor(id);
    if (at < state.snapshotAt) return;
    addJob(state, BACKGROUND_JOB_KIND.shell, key, at);
  };

  const recordShellEnded = (sessionID: string, shellID: unknown, at: number) => {
    const id = normalizeSessionID(sessionID);
    const key = normalizeBackgroundKey(shellID);
    if (!id || !key || isDeletedAtOrAfter(id, at)) return;
    const state = states.get(id);
    if (!state || at < state.snapshotAt) return;
    removeJob(state, BACKGROUND_JOB_KIND.shell, key, at);
  };

  /**
   * Apply an `experimental.idle` snapshot. The hook lists work owned by the
   * idle session and its descendants; items are stored under their owner so a
   * descendant's job never makes the idle parent active. Code Mode scripts are
   * reported only through this hook; shell events do not cover them.
   *
   * The snapshot is authoritative only when every item can be parsed. An item
   * with a known owner preserves that owner's jobs and marks its state unknown;
   * an item with no usable owner preserves every known job, because its owner
   * cannot be proven. A future core job kind therefore cannot silently make a
   * session look idle.
   */
  const recordIdle = (input: unknown, at = Date.now()) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const value = input as { sessionID?: unknown; background?: unknown };
    const id = normalizeSessionID(value.sessionID);
    if (!id || !Array.isArray(value.background)) return;
    if (deletedAt.has(id) || isDeletedAtOrAfter(id, at)) return;
    const parentState = stateFor(id);
    if (at < parentState.snapshotAt) return;

    const grouped = new Map<string, ParsedIdleItem[]>();
    const invalidOwners = new Set<string>();
    let ownerUnknown = false;
    for (const raw of value.background) {
      const parsed = parseIdleItem(raw);
      if (!parsed.ok) {
        if (parsed.owner && !deletedAt.has(parsed.owner)) {
          invalidOwners.add(parsed.owner);
        } else if (!parsed.owner) {
          ownerUnknown = true;
        }
        continue;
      }
      // A tombstoned session cannot own or be the child of a live job, even
      // when a stale snapshot arrives with a later local timestamp.
      if (deletedAt.has(parsed.item.owner)) continue;
      if (
        parsed.item.kind === BACKGROUND_JOB_KIND.subagent &&
        deletedAt.has(parsed.item.key)
      ) {
        continue;
      }
      const items = grouped.get(parsed.item.owner) ?? [];
      items.push(parsed.item);
      grouped.set(parsed.item.owner, items);
    }

    if (ownerUnknown) {
      // The snapshot cannot prove that any job ended. Preserve every known job
      // and mark the idle session's subtree state unknown.
      const owners = new Set<string>([
        id,
        ...parentState.snapshotOwners,
        ...grouped.keys(),
        ...invalidOwners,
      ]);
      for (const owner of owners) {
        if (deletedAt.has(owner) || isDeletedAtOrAfter(owner, at)) continue;
        const state = stateFor(owner);
        if (at < state.snapshotAt) continue;
        state.snapshotAt = at;
        markUnknown(state, at);
      }
      for (const [owner, items] of grouped) {
        if (deletedAt.has(owner) || isDeletedAtOrAfter(owner, at)) continue;
        const state = stateFor(owner);
        if (at < state.snapshotAt) continue;
        for (const item of items) addJob(state, item.kind, item.key, at);
      }
      const nextOwners = new Set<string>([
        ...parentState.snapshotOwners,
        ...grouped.keys(),
        ...invalidOwners,
      ]);
      nextOwners.delete(id);
      parentState.snapshotOwners = nextOwners;
      trimSet(parentState.snapshotOwners, MAX_BACKGROUND_SESSIONS);
      return;
    }

    const nextOwners = new Set<string>([...grouped.keys(), ...invalidOwners]);
    nextOwners.delete(id);
    // The hook is authoritative for the whole subtree. Clear descendant owners
    // that disappeared from the snapshot unless their own newer snapshot wins.
    for (const owner of parentState.snapshotOwners) {
      if (nextOwners.has(owner) || isDeletedAtOrAfter(owner, at)) continue;
      const ownerState = states.get(owner);
      if (!ownerState || at < ownerState.snapshotAt) continue;
      clearAtOrBefore(ownerState, at);
      ownerState.snapshotAt = at;
      ownerState.hasAuthoritativeSnapshot = true;
    }

    const applyOwner = (
      owner: string,
      items: readonly ParsedIdleItem[],
      trusted: boolean,
    ) => {
      if (deletedAt.has(owner) || isDeletedAtOrAfter(owner, at)) return;
      const state = stateFor(owner);
      if (at < state.snapshotAt) return;
      if (trusted) {
        clearAtOrBefore(state, at);
        state.hasAuthoritativeSnapshot = true;
      }
      state.snapshotAt = at;
      for (const item of items) addJob(state, item.kind, item.key, at);
      if (!trusted) markUnknown(state, at);
    };

    // The idle session's own snapshot is authoritative even when it is empty,
    // unless one of its own items could not be parsed.
    applyOwner(id, grouped.get(id) ?? [], !invalidOwners.has(id));
    for (const [owner, items] of grouped) {
      if (owner === id) continue;
      applyOwner(owner, items, !invalidOwners.has(owner));
    }
    for (const owner of invalidOwners) {
      if (owner === id || grouped.has(owner)) continue;
      applyOwner(owner, [], false);
    }
    parentState.snapshotOwners = nextOwners;
    trimSet(parentState.snapshotOwners, MAX_BACKGROUND_SESSIONS);
  };

  const recordDeleted = (sessionID: string, at = Date.now()) => {
    const id = normalizeSessionID(sessionID);
    if (!id) return;
    rememberDeleted(id, at);
    states.delete(id);
    for (const state of states.values()) {
      state.jobs.get(BACKGROUND_JOB_KIND.subagent)?.delete(id);
      state.snapshotOwners.delete(id);
    }
  };

  const backgroundJobFor = (sessionID: string): BackgroundJobInfo | undefined => {
    const state = states.get(sessionID);
    if (!state) return undefined;
    const kinds = BACKGROUND_JOB_KINDS.filter(
      (kind) => (state.jobs.get(kind)?.size ?? 0) > 0,
    );
    const stateUnknown = state.unknownAt > 0;
    if (kinds.length === 0 && !stateUnknown) return undefined;
    return {
      kinds: [...kinds],
      ...(stateUnknown ? { stateUnknown: true } : {}),
    };
  };

  const isActive = (sessionID: string): boolean =>
    backgroundJobFor(sessionID) !== undefined;

  /** Whether an authoritative idle snapshot has ever applied to this session. */
  const hasSnapshot = (sessionID: string): boolean =>
    states.get(sessionID)?.hasAuthoritativeSnapshot === true;

  /**
   * Structured fallback when the store has no authoritative snapshot for the
   * target, such as after a restart. Running shell messages and running
   * shell/image/video/subagent tool parts are proof of work. Code Mode scripts
   * are not visible here, so they rely on the idle hook. A missing snapshot, or a
   * failed or malformed read, is unknown, never idle.
   */
  const probe = async ({
    session,
    targetID,
    signal,
  }: BackgroundProbeInput): Promise<BackgroundProbeResult> => {
    const target = normalizeSessionID(targetID);
    if (!target) return { subtreeActive: false, failed: true };

    const kinds = new Set<BackgroundJobKind>();
    // Without an authoritative idle snapshot, a clean context is not proof
    // that no job exists: the job may predate this process or have been missed.
    let failed = !hasSnapshot(target);

    const stored = backgroundJobFor(target);
    if (stored) {
      for (const kind of stored.kinds) kinds.add(kind);
      if (stored.stateUnknown) failed = true;
    }

    const own = await readContext(session, target, signal);
    if (own.failed) failed = true;
    scanTargetMessages(own.messages, kinds);

    // The idle snapshot names descendant owners, so known descendant jobs are
    // structured evidence that the target's subtree is still active.
    let subtreeActive = false;
    const state = states.get(target);
    if (state) {
      for (const owner of state.snapshotOwners) {
        if (owner === target) continue;
        if (backgroundJobFor(owner) !== undefined) {
          subtreeActive = true;
          break;
        }
      }
    }

    const observed = BACKGROUND_JOB_KINDS.filter((kind) => kinds.has(kind));
    const backgroundJob =
      observed.length > 0 || failed
        ? {
            kinds: [...observed],
            ...(failed ? { stateUnknown: true } : {}),
          }
        : undefined;
    return { backgroundJob, subtreeActive, failed };
  };

  return {
    recordShellStarted,
    recordShellEnded,
    recordIdle,
    recordDeleted,
    backgroundJobFor,
    hasSnapshot,
    isActive,
    probe,
  };
};

export type BackgroundJobStore = ReturnType<typeof createBackgroundJobStore>;

export interface IdleHookRegistration {
  dispose: () => Promise<void>;
}

type IdleHook = (
  name: string,
  callback: (input: unknown) => void | Promise<void>,
) => Promise<IdleHookRegistration>;

/**
 * Register the experimental idle hook when the build exposes it. The hook is
 * optional: shell events still provide partial coverage.
 */
export const registerIdleHook = async (
  session: unknown,
  store: BackgroundJobStore,
): Promise<IdleHookRegistration | undefined> => {
  const hook = (session as { hook?: unknown }).hook;
  if (typeof hook !== "function") return undefined;
  try {
    return await (hook as IdleHook).call(
      session,
      "experimental.idle",
      (input: unknown) => {
        try {
          store.recordIdle(input);
        } catch (error) {
          console.error("subagent-tools: idle hook failed", error);
        }
      },
    );
  } catch (error) {
    console.error("subagent-tools: idle hook unavailable", error);
    return undefined;
  }
};
