import type { ResolvedLimits } from "./config"
import { compareRows } from "./cursor"
import type { LiveStore } from "./live-state"
import {
  normalizeSessionID,
  readSessionListPage,
  type SessionInfoLike,
  type SessionList,
  type SessionListResult,
} from "./session"
import { rowFromInfo, type SessionRow } from "./session-row"

export const MAX_DISCOVERY_PAGE_SIZE = 100

export interface DiscoveryResult {
  items: SessionInfoLike[]
  complete: boolean
}

export interface DiscoveryDeps {
  sessionList: SessionList
  live: LiveStore
  limits: Pick<
    ResolvedLimits,
    "maxDiscoveryNodes" | "maxDiscoveryDepth" | "maxDiscoveryPages"
  >
}

export const createDiscovery = ({ sessionList, live, limits }: DiscoveryDeps) => {
  const { maxDiscoveryNodes, maxDiscoveryDepth, maxDiscoveryPages } = limits

  const listChildren = async (
    parentID: string,
    signal?: AbortSignal,
  ): Promise<DiscoveryResult> => {
    const items: SessionInfoLike[] = []
    let cursor: string | undefined
    let complete = true
    for (let pageIndex = 0; pageIndex < maxDiscoveryPages; pageIndex++) {
      if (signal?.aborted) return { items, complete: false }
      let result: SessionListResult | undefined
      try {
        result = await sessionList(
          {
            parentID,
            limit: MAX_DISCOVERY_PAGE_SIZE,
            order: "desc",
            archived: false,
            ...(cursor ? { cursor } : {}),
          },
          { signal },
        )
      } catch {
        return { items, complete: false }
      }
      if (signal?.aborted) return { items, complete: false }
      const page = readSessionListPage(result)
      if (!page.valid) complete = false
      items.push(...page.items)
      const previousCursor = cursor
      cursor = page.cursor
      if (!cursor) {
        // A full page without a cursor may still be truncated; a short page
        // without a cursor is a clean end.
        if (page.items.length >= MAX_DISCOVERY_PAGE_SIZE) complete = false
        return { items, complete }
      }
      // A cursor is the primary signal that more rows exist. Do not stop on a
      // short page: a proxy or server may cap the page below the requested
      // limit and still return a cursor.
      if (cursor === previousCursor) {
        // A repeated cursor cannot make progress.
        complete = false
        return { items, complete }
      }
      if (pageIndex === maxDiscoveryPages - 1) complete = false
    }
    return { items, complete }
  }

  /**
   * Refresh a subtree from the server. The parentID filter is applied
   * server-side and checked again so an ignored filter cannot pull in
   * unrelated sessions. `complete` reports whether a limit, failure, or
   * cancellation may have truncated the walk.
   */
  const discoverSubtree = async (
    root: string,
    signal?: AbortSignal,
  ): Promise<DiscoveryResult> => {
    const seen = new Set<string>([root])
    const queue: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }]
    const items: SessionInfoLike[] = []
    let complete = true
    let discovered = 0

    for (let index = 0; index < queue.length; index++) {
      if (signal?.aborted) return { items, complete: false }
      const current = queue[index]
      if (current.depth >= maxDiscoveryDepth) {
        // This node may have children we deliberately did not inspect.
        complete = false
        continue
      }
      const children = await listChildren(current.id, signal)
      if (!children.complete) complete = false
      for (const info of children.items) {
        if (discovered >= maxDiscoveryNodes) {
          complete = false
          break
        }
        const id = normalizeSessionID(info.id)
        if (!id) {
          complete = false
          continue
        }
        if (seen.has(id)) continue
        const parentID = normalizeSessionID(info.parentID)
        if (parentID !== current.id) {
          complete = false
          continue
        }
        seen.add(id)
        items.push(info)
        discovered++
        queue.push({ id, depth: current.depth + 1 })
      }
      if (discovered >= maxDiscoveryNodes) {
        complete = false
        break
      }
    }
    return { items, complete }
  }

  const discoverRows = async (
    root: string,
    signal?: AbortSignal,
  ): Promise<{ rows: SessionRow[]; complete: boolean }> => {
    const discovery = await discoverSubtree(root, signal)
    const rows = discovery.items
      .map((info) => rowFromInfo(live, info))
      .filter((row): row is SessionRow => row !== undefined)
      .toSorted(compareRows)
    return { rows, complete: discovery.complete }
  }

  return { listChildren, discoverSubtree, discoverRows }
}

export type Discovery = ReturnType<typeof createDiscovery>
