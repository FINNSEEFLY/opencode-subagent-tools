import type { Plugin } from "@opencode/plugin"
import {
  SESSION_CONTROL_POLICY,
  type ResolvedLimits,
  type SessionControlPolicy,
} from "./config"
import { toolError } from "./errors"
import { normalizeSessionID, type SessionInfoLike } from "./session"
import type { ToolCtx } from "./tools/input"
import { TOOL } from "./tools/names"

export const OWNERSHIP = {
  owned: "owned",
  foreign: "foreign",
  unknown: "unknown",
} as const

export type Ownership = (typeof OWNERSHIP)[keyof typeof OWNERSHIP]

export interface GetSessionResult {
  info?: SessionInfoLike
  ok: boolean
}

export interface AccessDeps {
  session: Plugin.Context["session"]
  limits: Pick<ResolvedLimits, "maxDiscoveryDepth">
  policy: SessionControlPolicy
  namespace: string
}

const PARENT_WALK = {
  match: "match",
  root: "root",
  unknown: "unknown",
} as const

type ParentWalk = (typeof PARENT_WALK)[keyof typeof PARENT_WALK]

export const createAccess = ({ session, limits, policy, namespace }: AccessDeps) => {
  const getSession = async (
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<GetSessionResult> => {
    try {
      return {
        info: (await session.get({ sessionID }, { signal })) as
          | SessionInfoLike
          | undefined,
        ok: true,
      }
    } catch {
      return { ok: false }
    }
  }

  /**
   * Walk a parent chain until `matches` accepts a parent ID or the chain ends.
   * A chain that is deeper than `maxDiscoveryDepth` or malformed is reported as
   * unknown, never as a clean end. `startInfo` is the record for the first ID.
   */
  const walkParents = async (
    start: string,
    signal: AbortSignal | undefined,
    matches: (parentID: string) => boolean,
  ): Promise<{ relation: ParentWalk; startInfo?: SessionInfoLike }> => {
    const seen = new Set<string>()
    let current = start
    let startInfo: SessionInfoLike | undefined

    for (let depth = 0; depth < limits.maxDiscoveryDepth; depth++) {
      if (signal?.aborted) return { relation: PARENT_WALK.unknown, startInfo }
      if (seen.has(current)) return { relation: PARENT_WALK.unknown, startInfo }
      seen.add(current)
      const { info, ok } = await getSession(current, signal)
      if (!ok || !info) return { relation: PARENT_WALK.unknown, startInfo }
      if (current === start) startInfo = info
      const parentID = normalizeSessionID(info.parentID)
      if (info.parentID !== undefined && parentID === undefined) {
        return { relation: PARENT_WALK.unknown, startInfo }
      }
      if (!parentID) return { relation: PARENT_WALK.root, startInfo }
      if (matches(parentID)) return { relation: PARENT_WALK.match, startInfo }
      current = parentID
    }
    return { relation: PARENT_WALK.unknown, startInfo }
  }

  /**
   * Confirm that the caller is an ancestor of `target`. A chain that is too
   * deep or malformed is reported as unknown, never as foreign.
   */
  const verifyDescendant = async (
    target: string,
    caller: string,
    signal?: AbortSignal,
  ): Promise<{ ownership: Ownership; info?: SessionInfoLike }> => {
    const result = await walkParents(target, signal, (parentID) => parentID === caller)
    const ownership =
      result.relation === PARENT_WALK.match
        ? OWNERSHIP.owned
        : result.relation === PARENT_WALK.root
          ? OWNERSHIP.foreign
          : OWNERSHIP.unknown
    return { ownership, info: result.startInfo }
  }

  /**
   * Report whether `target` is an ancestor of `caller`. The result is unknown
   * when the chain is too deep, cyclic, or cannot be read.
   */
  const findAncestor = async (
    target: string,
    caller: string,
    signal?: AbortSignal,
  ): Promise<"ancestor" | "not-ancestor" | "unknown"> => {
    const result = await walkParents(caller, signal, (parentID) => parentID === target)
    return result.relation === PARENT_WALK.match
      ? "ancestor"
      : result.relation === PARENT_WALK.root
        ? "not-ancestor"
        : "unknown"
  }

  const aborted = (): never => toolError("Aborted before the target could be verified.")

  const readAuthorizedTarget = async (
    target: string,
    context: ToolCtx,
  ): Promise<SessionInfoLike> => {
    const { info, ok } = await getSession(target, context.signal)
    if (context?.signal?.aborted) return aborted()
    if (!ok || !info) {
      return toolError(`Refusing: ${target} could not be read from the server.`)
    }
    return info
  }

  type PolicyHandler = (
    target: string,
    caller: string,
    context: ToolCtx,
  ) => Promise<SessionInfoLike | undefined>

  const policyHandlers: Readonly<Record<SessionControlPolicy, PolicyHandler>> = {
    [SESSION_CONTROL_POLICY.descendants]: async (target, caller, context) => {
      const result = await verifyDescendant(target, caller, context.signal)
      if (context?.signal?.aborted) return aborted()
      if (result.ownership === OWNERSHIP.owned) return result.info
      if (result.ownership === OWNERSHIP.foreign) {
        return toolError(
          `Refusing: ${target} is not a descendant of the calling session (${caller}).`,
        )
      }
      return toolError(
        `Refusing: ${target} could not be verified through the server's session tree. Run ${namespace}_${TOOL.list} and use an ID it reports.`,
      )
    },
    [SESSION_CONTROL_POLICY.allExceptAncestors]: async (target, caller, context) => {
      const info = await readAuthorizedTarget(target, context)
      const relation = await findAncestor(target, caller, context.signal)
      if (context?.signal?.aborted) return aborted()
      if (relation === "ancestor") {
        return toolError(
          `Refusing: ${target} is an ancestor of the calling session (${caller}); sessionControlPolicy is all-except-ancestors.`,
        )
      }
      if (relation === "unknown") {
        return toolError(
          `Refusing: ${target} could not be verified through the server's session tree. Run ${namespace}_${TOOL.list} and use an ID it reports.`,
        )
      }
      return info
    },
    [SESSION_CONTROL_POLICY.all]: (target, _caller, context) =>
      readAuthorizedTarget(target, context),
  }

  const policyHandlerMap: ReadonlyMap<SessionControlPolicy, PolicyHandler> = new Map(
    Object.entries(policyHandlers) as Array<[SessionControlPolicy, PolicyHandler]>,
  )

  const authorize = async (
    target: string,
    context: ToolCtx,
  ): Promise<SessionInfoLike | undefined> => {
    const caller = context?.sessionID
    if (context?.signal?.aborted) return aborted()
    if (caller && target === caller) {
      return toolError("Refusing: a session cannot control itself.")
    }
    if (!caller) {
      return toolError(
        "Refusing: the calling session is unknown, so ownership of the target cannot be verified.",
      )
    }

    const handler = policyHandlerMap.get(policy)
    if (!handler) {
      return toolError(
        `Refusing: unknown sessionControlPolicy "${String(policy)}"; the target was not authorized.`,
      )
    }
    return handler(target, caller, context)
  }

  /**
   * Read-only resolution for `usage`. Reading is intentionally unrestricted by
   * `sessionControlPolicy`: the caller may read any session, including itself.
   */
  const readUsageTarget = async (
    target: string,
    context: ToolCtx,
  ): Promise<SessionInfoLike | undefined> => {
    if (context?.signal?.aborted) {
      return toolError("Aborted before usage was read.")
    }
    const { info, ok } = await getSession(target, context.signal)
    if (context?.signal?.aborted) {
      return toolError("Aborted before usage was read.")
    }
    if (!ok || !info) {
      return toolError(`Usage unavailable for ${target}: session could not be read.`)
    }
    return info
  }

  return {
    getSession,
    verifyDescendant,
    authorize,
    readTarget: readUsageTarget,
  }
}

export type Access = ReturnType<typeof createAccess>
