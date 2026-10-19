import type { SessionRow } from "./session-row"
import { TOOL, type ToolName } from "./tools/names"

export const MAX_CURSOR_LENGTH = 512
export const CURSOR_VERSION = 1

const CURSOR_TOOLS: ReadonlySet<ToolName> = new Set([TOOL.list, TOOL.cancelDescendants])

const isCursorTool = (value: unknown): value is ToolName =>
  typeof value === "string" && CURSOR_TOOLS.has(value as ToolName)

export interface CursorScope {
  tool: ToolName
  root: string
  filter?: string
}

export interface PageCursor {
  launchedAt: number
  id: string
}

interface CursorPayload extends PageCursor {
  v: typeof CURSOR_VERSION
  tool: ToolName
  root: string
  filter?: string
}

const encodePayload = (payload: CursorPayload): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")

const decodePayload = (value: string): CursorPayload | undefined => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown
    if (!parsed || typeof parsed !== "object") return undefined
    const payload = parsed as Record<string, unknown>
    if (payload.v !== CURSOR_VERSION) return undefined
    if (!isCursorTool(payload.tool)) return undefined
    if (typeof payload.root !== "string" || payload.root.length === 0) return undefined
    if (payload.filter !== undefined && typeof payload.filter !== "string")
      return undefined
    if (
      typeof payload.launchedAt !== "number" ||
      !Number.isFinite(payload.launchedAt) ||
      payload.launchedAt < 0
    ) {
      return undefined
    }
    if (typeof payload.id !== "string" || payload.id.length === 0) return undefined
    return {
      v: CURSOR_VERSION,
      tool: payload.tool,
      root: payload.root,
      filter: payload.filter as string | undefined,
      launchedAt: payload.launchedAt,
      id: payload.id,
    }
  } catch {
    return undefined
  }
}

export const encodeCursor = (
  row: Pick<SessionRow, "launchedAt" | "id">,
  scope: CursorScope,
): string =>
  encodePayload({
    v: CURSOR_VERSION,
    tool: scope.tool,
    root: scope.root,
    filter: scope.filter,
    launchedAt: row.launchedAt,
    id: row.id,
  })

const invalidCursorMessage = (toolName: ToolName): string =>
  `Invalid cursor. Re-run the previous ${toolName} call and use the cursor it reported.`

export const readCursor = (
  value: unknown,
  scope: CursorScope,
): { cursor?: PageCursor; error?: string } => {
  if (value === undefined) return {}
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH
  ) {
    return { error: invalidCursorMessage(scope.tool) }
  }
  const payload = decodePayload(value)
  if (
    !payload ||
    payload.tool !== scope.tool ||
    payload.root !== scope.root ||
    (payload.filter ?? "") !== (scope.filter ?? "")
  ) {
    return { error: invalidCursorMessage(scope.tool) }
  }
  return { cursor: { launchedAt: payload.launchedAt, id: payload.id } }
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Newest launch first, then a deterministic ID tie-break for stable paging. */
export const compareRows = (a: SessionRow, b: SessionRow): number =>
  (b.launchedAt ?? 0) - (a.launchedAt ?? 0) || compareIds(a.id, b.id)

export const isAfterCursor = (row: SessionRow, cursor: PageCursor): boolean =>
  row.launchedAt < cursor.launchedAt ||
  (row.launchedAt === cursor.launchedAt && compareIds(row.id, cursor.id) > 0)
