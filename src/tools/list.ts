import type { ToolEditor } from "@opencode/plugin/promise/tool"
import type { Access } from "../access"
import { limitInteger, type Config } from "../config"
import { encodeCursor, isAfterCursor, readCursor } from "../cursor"
import type { Discovery } from "../discovery"
import { toolError } from "../errors"
import { age, ageSeconds, compactNumber, formatCost } from "../format"
import { MAX_PROMPT_PREVIEW_LENGTH } from "../session"
import type { SessionRow } from "../session-row"
import {
  CHILD_STATUSES,
  isChildStatus,
  statusUsageMayLag,
  type ChildStatus,
} from "../status"
import { clip, isUnsafeControlCode } from "../text"
import { TOKEN_USAGE_SCHEMA, tokensUsed, type TokenUsage } from "../tokens"
import { readOptionalSessionID, readToolInput } from "./input"
import { TOOL } from "./names"
import { formatPropertyDescription, resolveToolOutputStrategy } from "./output"

const STATUS_COLUMN_WIDTH = Math.max(...CHILD_STATUSES.map((status) => status.length))
const DISCOVERY_WARNING = "discovery was incomplete; some subagents may be missing."
const DISCOVERY_WARNING_TEXT = `\nWarning: ${DISCOVERY_WARNING}`

export interface ListRowUsage {
  costUSD?: number
  tokens?: TokenUsage
  tokensUsed?: number
}

export interface ListRowOutput {
  id: string
  parentID?: string
  agent?: string
  title?: string
  titleTruncated?: boolean
  status: ChildStatus
  ageSeconds?: number
  launchedAt: number
  /** Usage is as of the last persisted step; running/unknown children may lag. */
  usageMayLag?: boolean
  usage?: ListRowUsage
}

export interface ListOutput {
  root: string
  statuses: ChildStatus[]
  discoveryComplete: boolean
  warning?: string
  known: number
  matching: number
  window: number
  remaining: number
  remainingPages: number
  cursor?: string
  counts: Record<ChildStatus, number>
  rows: ListRowOutput[]
}

const LIST_ROW_USAGE_SCHEMA = {
  type: "object",
  properties: {
    costUSD: { type: "number" },
    tokens: TOKEN_USAGE_SCHEMA,
    tokensUsed: { type: "integer" },
  },
  additionalProperties: false,
} as const

const LIST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    root: { type: "string" },
    statuses: {
      type: "array",
      items: { type: "string", enum: [...CHILD_STATUSES] },
    },
    discoveryComplete: {
      type: "boolean",
      description:
        "Whether discovery walked the whole subtree, not whether all rows fit on this page.",
    },
    warning: { type: "string" },
    known: {
      type: "integer",
      description: "All discovered sessions before the status filter and cursor.",
    },
    matching: {
      type: "integer",
      description:
        "Matching sessions in the current discovery snapshot, before the cursor.",
    },
    window: {
      type: "integer",
      description:
        "Matching sessions after the cursor; equals matching on the first page.",
    },
    remaining: {
      type: "integer",
      description: "Matching sessions in the window not returned on this page.",
    },
    remainingPages: {
      type: "integer",
      description: "Pages left in this cursor walk.",
    },
    cursor: { type: "string" },
    counts: {
      type: "object",
      description:
        "Counts for all discovered sessions, before the status filter and cursor.",
      properties: Object.fromEntries(
        CHILD_STATUSES.map((status) => [status, { type: "integer" }]),
      ),
      required: [...CHILD_STATUSES],
      additionalProperties: false,
    },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          parentID: { type: "string" },
          agent: { type: "string" },
          title: { type: "string" },
          titleTruncated: { type: "boolean" },
          status: { type: "string", enum: [...CHILD_STATUSES] },
          ageSeconds: { type: "integer" },
          launchedAt: { type: "number" },
          usageMayLag: {
            type: "boolean",
            description: "True when the session is running or unknown; usage may lag.",
          },
          usage: LIST_ROW_USAGE_SCHEMA,
        },
        required: ["id", "status", "launchedAt"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "root",
    "statuses",
    "discoveryComplete",
    "known",
    "matching",
    "window",
    "remaining",
    "remainingPages",
    "counts",
    "rows",
  ],
  additionalProperties: false,
} as const

const requestedStatuses = (
  value: unknown,
): { statuses: Set<ChildStatus>; invalid: string[]; error?: string } => {
  if (value === undefined) {
    return { statuses: new Set(CHILD_STATUSES), invalid: [] }
  }
  if (!Array.isArray(value)) {
    return {
      statuses: new Set<ChildStatus>(),
      invalid: [],
      error: "statuses must be an array of statuses; omit it to include all.",
    }
  }
  const valid: ChildStatus[] = []
  const invalid: string[] = []
  for (const raw of value) {
    if (typeof raw !== "string") {
      invalid.push(String(raw))
      continue
    }
    const status = raw.trim().toLowerCase()
    if (isChildStatus(status)) valid.push(status)
    else if (status.length > 0) invalid.push(raw)
  }
  return {
    statuses: new Set(valid),
    invalid,
  }
}

const statusesLabel = (statuses: Set<ChildStatus>): string =>
  statuses.size === CHILD_STATUSES.length ? "all" : [...statuses].join(", ")

const escapeText = (value: string): string =>
  Array.from(
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\r\n\t]/g, " "),
  )
    .map((char) => (isUnsafeControlCode(char.codePointAt(0) ?? 0) ? "?" : char))
    .join("")

const rowText = (row: SessionRow): string => {
  const usageMayLag = statusUsageMayLag(row.status)
  const title = clip(row.title, MAX_PROMPT_PREVIEW_LENGTH)
  return [
    escapeText(row.id),
    row.status.padEnd(STATUS_COLUMN_WIDTH),
    `agent=${escapeText(row.agent ?? "?")}`,
    `age=${row.launchedAt > 0 ? age(row.launchedAt) : "?"}`,
    row.cost !== undefined ? `cost=${formatCost(row.cost)}` : "",
    row.tokens ? `used=${compactNumber(tokensUsed(row.tokens))}` : "",
    usageMayLag ? "usage=lagging" : "",
    row.parentID ? `parent=${escapeText(row.parentID)}` : "parent=?",
    title ? `title="${escapeText(title)}"` : "",
  ]
    .filter(Boolean)
    .join("  ")
}

const countStatuses = (rows: readonly SessionRow[]): Record<ChildStatus, number> => {
  const counts = Object.fromEntries(
    CHILD_STATUSES.map((status) => [status, 0]),
  ) as Record<ChildStatus, number>
  for (const row of rows) counts[row.status]++
  return counts
}

const rowOutput = (row: SessionRow): ListRowOutput => {
  const output: ListRowOutput = {
    id: row.id,
    status: row.status,
    launchedAt: row.launchedAt,
  }
  if (row.parentID !== undefined) output.parentID = row.parentID
  if (row.agent !== undefined) output.agent = row.agent
  if (row.title !== undefined) output.title = row.title
  if (row.titleTruncated) output.titleTruncated = true
  if (row.launchedAt > 0) output.ageSeconds = ageSeconds(row.launchedAt)
  if (statusUsageMayLag(row.status)) {
    output.usageMayLag = true
  }
  if (row.cost !== undefined || row.tokens) {
    const usage: ListRowUsage = {}
    if (row.cost !== undefined) usage.costUSD = row.cost
    if (row.tokens) {
      usage.tokens = row.tokens
      usage.tokensUsed = tokensUsed(row.tokens)
    }
    output.usage = usage
  }
  return output
}

interface PaginationSummary {
  shown: number
  afterCursor: number
  allMatches: number
  limit: number
  remainingPages: number
  nextCursor?: string
  hasCursor: boolean
}

const paginationSummary = ({
  shown,
  afterCursor,
  allMatches,
  limit,
  remainingPages,
  nextCursor,
  hasCursor,
}: PaginationSummary): string => {
  const pageLabel =
    remainingPages === 0
      ? "last page"
      : `${remainingPages} ${remainingPages === 1 ? "page" : "pages"} remaining`
  if (nextCursor) {
    if (hasCursor) {
      return `\nShowing ${shown} of ${afterCursor} in this cursor window (${allMatches} matching total); ${pageLabel}. Use cursor ${nextCursor} to continue.`
    }
    return `\nShowing ${shown} of ${allMatches} matches (limit ${limit}); ${pageLabel}. Use cursor ${nextCursor} to continue.`
  }
  if (hasCursor) {
    return `\nShowing ${shown} of ${afterCursor} in this cursor window (${allMatches} matching total); ${pageLabel}.`
  }
  return ""
}

export interface ListDeps {
  config: Config
  access: Access
  discovery: Discovery
}

export const registerListTool = (
  editor: ToolEditor,
  { config, access, discovery }: ListDeps,
) => {
  const { allowedOutputFormats, limits } = config
  const outputStrategy = resolveToolOutputStrategy(allowedOutputFormats, TOOL.list)

  editor.add({
    name: TOOL.list,
    description:
      "List subagent sessions from the server's session tree, newest launch first, with observed status. " +
      "Defaults to the caller's subtree; pass parentID for any subtree. " +
      "By default all statuses are included; pass statuses to filter, and use limit/cursor to page through large sets. " +
      "Rows include status, age, cost, and cumulative token usage when available. " +
      "Discovery is limited, so results can be incomplete; a warning is included when that is possible.",
    input: {
      type: "object",
      properties: {
        parentID: {
          type: "string",
          description:
            "Parent session ID. Defaults to the calling session; any parent is accepted.",
        },
        statuses: {
          type: "array",
          minItems: 1,
          maxItems: CHILD_STATUSES.length,
          items: { type: "string", enum: [...CHILD_STATUSES] },
          description:
            "Statuses to include. Omit to include all statuses; pass one or more to filter. An empty array is rejected.",
        },
        ...outputStrategy.formatProperty(
          formatPropertyDescription(outputStrategy, "the human-readable table"),
        ),
        limit: {
          type: "integer",
          minimum: 1,
          maximum: limits.maxListRows,
          description: `Maximum rows to return. Defaults to ${limits.maxListRows}; values outside 1 to ${limits.maxListRows} are rejected.`,
        },
        cursor: {
          type: "string",
          description: "Cursor from a previous list call; pass it back unchanged.",
        },
      },
      additionalProperties: false,
    },
    output: outputStrategy.schema(LIST_OUTPUT_SCHEMA),
    options: { namespace: config.namespace },
    execute: async (rawInput, context) => {
      const { input, format } = readToolInput(rawInput, outputStrategy)
      const requested = readOptionalSessionID(input?.parentID)
      if (input?.parentID !== undefined && requested === undefined) {
        return toolError("parentID is invalid; use the exact ID reported by the server.")
      }
      const caller = context?.sessionID
      const statusFilter = requestedStatuses(input?.statuses)
      if (statusFilter.error) {
        return toolError(statusFilter.error)
      }
      if (statusFilter.invalid.length > 0) {
        const shown = statusFilter.invalid.slice(0, 5).join(", ")
        const more =
          statusFilter.invalid.length > 5
            ? `, and ${statusFilter.invalid.length - 5} more`
            : ""
        return toolError(
          `Unknown status(es): ${shown}${more}. Use one or more of: ${CHILD_STATUSES.join(", ")}.`,
        )
      }
      const statuses = statusFilter.statuses
      if (statuses.size === 0) {
        return toolError(
          `statuses must contain at least one status. Omit statuses to include all, or pass one or more of: ${CHILD_STATUSES.join(", ")}.`,
        )
      }
      const limit = limitInteger(input?.limit, limits.maxListRows, 1, limits.maxListRows)

      if (requested && requested !== caller) {
        const parent = await access.getSession(requested, context?.signal)
        if (context?.signal?.aborted) {
          return toolError("Aborted before the parent could be read.")
        }
        if (!parent.ok || !parent.info) {
          return toolError(`Parent session ${requested} could not be read.`)
        }
      }

      const root = requested ?? caller
      if (!root) {
        return toolError(
          "Refusing: the calling session is unknown; pass parentID or call from a session.",
        )
      }
      const filterKey = [...statuses].toSorted().join(",")
      const cursorResult = readCursor(input?.cursor, {
        tool: TOOL.list,
        root,
        filter: filterKey,
      })
      if (cursorResult.error) {
        return toolError(cursorResult.error)
      }
      const cursor = cursorResult.cursor
      if (context?.signal?.aborted) {
        return toolError("Aborted before discovery.")
      }

      const found = await discovery.discoverRows(root, context?.signal)
      if (context?.signal?.aborted) {
        return toolError("Aborted during discovery.")
      }
      const warning = found.complete ? "" : DISCOVERY_WARNING_TEXT
      const allMatches = found.rows.filter((row) => statuses.has(row.status))
      const afterCursor = cursor
        ? allMatches.filter((row) => isAfterCursor(row, cursor))
        : allMatches

      const outputFor = (
        page: readonly SessionRow[],
        matching: number,
        window: number,
        remaining: number,
        remainingPages: number,
        nextCursor?: string,
      ): ListOutput => {
        const output: ListOutput = {
          root,
          statuses: [...statuses],
          discoveryComplete: found.complete,
          known: found.rows.length,
          matching,
          window,
          remaining,
          remainingPages,
          counts: countStatuses(found.rows),
          rows: page.map(rowOutput),
        }
        if (!found.complete) {
          output.warning = DISCOVERY_WARNING
        }
        if (nextCursor) output.cursor = nextCursor
        return output
      }
      const respond = (content: string, output: ListOutput) =>
        outputStrategy.respond(content, output, format)

      if (found.rows.length === 0) {
        return respond(
          `No subagents discovered for ${root}.` + warning,
          outputFor([], 0, 0, 0, 0),
        )
      }

      const label = statusesLabel(statuses)
      if (allMatches.length === 0) {
        return respond(
          `${found.rows.length} known subagent(s) for ${root}, none match statuses: ${label}.` +
            warning,
          outputFor([], 0, 0, 0, 0),
        )
      }

      if (afterCursor.length === 0) {
        return respond(
          `Cursor is past the end: ${found.rows.length} known subagent(s) for ${root}.` +
            warning,
          outputFor([], allMatches.length, 0, 0, 0),
        )
      }

      const shown = afterCursor.slice(0, limit)
      const nextCursor =
        afterCursor.length > shown.length
          ? encodeCursor(shown[shown.length - 1], {
              tool: TOOL.list,
              root,
              filter: filterKey,
            })
          : undefined
      const remaining = Math.max(0, afterCursor.length - shown.length)
      const remainingPages = Math.ceil(remaining / limit)
      const beforeCursor = allMatches.length - afterCursor.length
      const summary = paginationSummary({
        shown: shown.length,
        afterCursor: afterCursor.length,
        allMatches: allMatches.length,
        limit,
        remainingPages,
        nextCursor,
        hasCursor: cursor !== undefined,
      })
      const beforeCursorNote =
        cursor && beforeCursor > 0
          ? `\nNote: ${beforeCursor} matching row(s) are before this cursor window (previous pages or new children); re-run without a cursor to include new children.`
          : ""
      return respond(
        shown.map(rowText).join("\n") + summary + beforeCursorNote + warning,
        outputFor(
          shown,
          allMatches.length,
          afterCursor.length,
          remaining,
          remainingPages,
          nextCursor,
        ),
      )
    },
  })
}
