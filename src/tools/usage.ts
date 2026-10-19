import type { Plugin } from "@opencode/plugin"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import type { Access } from "../access"
import type { Config } from "../config"
import type { Discovery } from "../discovery"
import { errorMessage, toolError } from "../errors"
import { compactNumber, formatCost } from "../format"
import type { LiveStore } from "../live-state"
import type {
  ModelInfoLike,
  ModelRefLike,
  SessionInfoLike,
  UsageMessage,
} from "../session"
import { CHILD_STATUSES, STATUS, statusUsageMayLag, type ChildStatus } from "../status"
import {
  CONTEXT_USAGE,
  TOKEN_USAGE_SCHEMA,
  addTokens,
  contextFromMessages,
  normalizeTokens,
  tokensUsed,
  type LastRequestUsage,
  type TokenUsage,
} from "../tokens"
import { readToolInput, requireSessionID } from "./input"
import { TOOL } from "./names"
import { formatPropertyDescription, resolveToolOutputStrategy } from "./output"

export interface TreeUsage {
  /** Total sessions in the tree rooted at the target, including the target. */
  sessions: number
  /** Sessions below the target; excludes the target. */
  descendants: number
  costUSD: number
  tokens?: TokenUsage
  /** Omitted when no session in the tree reported token data. */
  tokensUsed?: number
  /** Whether discovery walked the whole descendant subtree. */
  discoveryComplete: boolean
  /** True when at least one descendant is running or unknown. */
  descendantsMayLag?: boolean
  warning?: string
}

export interface UsageOutput {
  sessionID: string
  parentID?: string
  status: ChildStatus
  /** Usage is as of the last persisted step; running/unknown sessions may lag. */
  usageMayLag?: boolean
  costUSD?: number
  tokens?: TokenUsage
  tokensUsed?: number
  contextTokens?: number
  contextLimit?: number
  contextPercent?: number
  lastRequest?: LastRequestUsage
  model?: ModelRefLike
  tree?: TreeUsage
  warning?: string
}

const USAGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    parentID: { type: "string" },
    status: {
      type: "string",
      enum: [...CHILD_STATUSES],
      description: "Observed status; the calling session is reported as running.",
    },
    usageMayLag: {
      type: "boolean",
      description: "True when the session is running or unknown; usage may lag.",
    },
    costUSD: { type: "number" },
    tokens: TOKEN_USAGE_SCHEMA,
    tokensUsed: { type: "integer" },
    contextTokens: { type: "integer" },
    contextLimit: { type: "integer" },
    contextPercent: { type: "number" },
    lastRequest: {
      type: "object",
      properties: {
        input: { type: "integer" },
        output: { type: "integer" },
        reasoning: { type: "integer" },
        cacheRead: { type: "integer" },
        cacheWrite: { type: "integer" },
        total: { type: "integer" },
      },
      required: ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"],
      additionalProperties: false,
    },
    model: {
      type: "object",
      properties: {
        id: { type: "string" },
        providerID: { type: "string" },
        variant: { type: "string" },
      },
      additionalProperties: false,
    },
    tree: {
      type: "object",
      properties: {
        sessions: {
          type: "integer",
          description: "Sessions in the tree, including the target.",
        },
        descendants: {
          type: "integer",
          description: "Sessions below the target.",
        },
        costUSD: { type: "number" },
        tokens: TOKEN_USAGE_SCHEMA,
        tokensUsed: { type: "integer" },
        discoveryComplete: {
          type: "boolean",
          description:
            "Whether discovery walked the whole descendant subtree; missing descendants are possible when false.",
        },
        descendantsMayLag: {
          type: "boolean",
          description:
            "True when at least one descendant is running or unknown; tree totals may lag, while top-level usageMayLag covers the target.",
        },
        warning: { type: "string" },
      },
      required: ["sessions", "descendants", "costUSD", "discoveryComplete"],
      additionalProperties: false,
    },
    warning: { type: "string" },
  },
  required: ["sessionID", "status"],
  additionalProperties: false,
} as const

export interface UsageDeps {
  config: Config
  access: Access
  discovery: Discovery
  live: LiveStore
  session: Plugin.Context["session"]
  model: Plugin.Context["model"]
}

export const registerUsageTool = (
  editor: ToolEditor,
  { config, access, discovery, live, session, model }: UsageDeps,
) => {
  const { allowedOutputFormats } = config
  const outputStrategy = resolveToolOutputStrategy(allowedOutputFormats, TOOL.usage)

  editor.add({
    name: TOOL.usage,
    description:
      "Read cost, tokens, current context, and status for a session. " +
      "Returns own cumulative cost and tokens, the current context footprint, the model context limit when available, and optional tree totals. " +
      "Read-only; any session ID is accepted. " +
      "Values are as of the last persisted step and may lag while the session is running or unknown.",
    input: {
      type: "object",
      properties: {
        sessionID: { type: "string", description: "Target session ID, e.g. ses_..." },
        includeDescendants: {
          type: "boolean",
          description: "Add tree totals for the target and its descendants.",
        },
        ...outputStrategy.formatProperty(
          formatPropertyDescription(outputStrategy, "a human-readable summary"),
        ),
      },
      required: ["sessionID"],
      additionalProperties: false,
    },
    output: outputStrategy.schema(USAGE_OUTPUT_SCHEMA),
    options: { namespace: config.namespace },
    execute: async (rawInput, context) => {
      const { input, format } = readToolInput(rawInput, outputStrategy)
      const sessionID = requireSessionID(input?.sessionID)

      let info: SessionInfoLike | undefined
      try {
        info = await access.readTarget(sessionID, context)
      } catch (error) {
        return toolError(errorMessage(error))
      }
      if (!info) {
        const fetched = await access.getSession(sessionID, context?.signal)
        if (!fetched.ok) {
          return toolError(
            `Usage unavailable for ${sessionID}: session could not be read.`,
          )
        }
        info = fetched.info
      }
      if (!info) {
        return toolError(`Usage unavailable for ${sessionID}: session not found.`)
      }
      if (context?.signal?.aborted) {
        return toolError("Aborted before usage was read.")
      }

      // A tool call proves the caller is executing, even when the last
      // persisted run ended earlier. Do not report a finished status for self.
      const status =
        context?.sessionID === sessionID
          ? STATUS.running
          : live.statusFor(info, sessionID)
      const usageMayLag = statusUsageMayLag(status)
      const ownTokens = normalizeTokens(info.tokens)
      const ownCost =
        typeof info.cost === "number" && Number.isFinite(info.cost)
          ? info.cost
          : undefined
      const warnings: string[] = []

      let messages: UsageMessage[] | undefined
      try {
        const result = await session.context({ sessionID }, { signal: context?.signal })
        if (Array.isArray(result)) {
          const raw = result as unknown[]
          if (raw.some((message) => !message || typeof message !== "object")) {
            warnings.push("context unavailable: server returned malformed messages")
          } else {
            messages = raw as UsageMessage[]
          }
        } else {
          warnings.push("context unavailable: server returned no message list")
        }
      } catch (error) {
        if (context?.signal?.aborted) {
          return toolError("Aborted while reading context.")
        }
        warnings.push(`context unavailable: ${errorMessage(error)}`)
      }
      const revertBoundaryMissing =
        messages !== undefined &&
        info.revert?.messageID !== undefined &&
        !messages.some((message) => message.id === info.revert?.messageID)
      if (revertBoundaryMissing) {
        warnings.push(
          "context unavailable: staged revert boundary is not present in the session context",
        )
      }
      const contextUsage =
        messages && !revertBoundaryMissing && messages.length > 0
          ? contextFromMessages(messages, info.revert?.messageID)
          : undefined
      if (contextUsage?.kind === CONTEXT_USAGE.missing) {
        warnings.push(
          "context unavailable: token data is missing from the last assistant step",
        )
      }
      const contextTokens =
        messages && !revertBoundaryMissing
          ? contextUsage?.kind === CONTEXT_USAGE.usage
            ? contextUsage.total
            : contextUsage?.kind === CONTEXT_USAGE.missing
              ? undefined
              : 0
          : undefined

      const modelRef =
        info.model ??
        (contextUsage?.kind === CONTEXT_USAGE.usage ? contextUsage.model : undefined)
      let contextLimit: number | undefined
      if (modelRef?.providerID && modelRef.id) {
        try {
          const catalog = (await model.list()) as { data?: ModelInfoLike[] }
          const models = catalog?.data ?? []
          const found = models.find(
            (item) =>
              item.providerID === modelRef.providerID &&
              (item.id === modelRef.id || item.modelID === modelRef.id),
          )
          if (typeof found?.limit?.context === "number" && found.limit.context > 0) {
            contextLimit = found.limit.context
          }
        } catch {
          // The model catalog is optional; usage still works without a limit.
        }
      }
      if (context?.signal?.aborted) {
        return toolError("Aborted while reading usage.")
      }
      const contextPercent =
        contextTokens !== undefined && contextLimit
          ? Math.round((contextTokens / contextLimit) * 100)
          : undefined

      let tree: TreeUsage | undefined
      if (input.includeDescendants === true) {
        const found = await discovery.discoverRows(sessionID, context?.signal)
        if (context?.signal?.aborted) {
          return toolError("Aborted while reading tree usage.")
        }
        let sessions = 1
        let descendants = 0
        let costUSD = ownCost ?? 0
        let tokens = ownTokens
        let descendantsMayLag = false
        for (const row of found.rows) {
          sessions++
          descendants++
          if (row.cost !== undefined) costUSD += row.cost
          if (row.tokens) tokens = addTokens(tokens, row.tokens)
          if (statusUsageMayLag(row.status)) descendantsMayLag = true
        }
        tree = {
          sessions,
          descendants,
          costUSD,
          discoveryComplete: found.complete,
        }
        if (tokens) {
          tree.tokens = tokens
          tree.tokensUsed = tokensUsed(tokens)
        }
        if (descendantsMayLag) tree.descendantsMayLag = true
        if (!found.complete) {
          tree.warning = "discovery was incomplete; some descendants may be missing."
        }
      }

      const output: UsageOutput = { sessionID, status }
      if (info.parentID) output.parentID = info.parentID
      if (usageMayLag) output.usageMayLag = true
      if (ownCost !== undefined) output.costUSD = ownCost
      if (ownTokens) {
        output.tokens = ownTokens
        output.tokensUsed = tokensUsed(ownTokens)
      }
      if (contextTokens !== undefined) output.contextTokens = contextTokens
      if (contextUsage?.kind === CONTEXT_USAGE.usage) {
        output.lastRequest = contextUsage.lastRequest
      }
      if (contextLimit !== undefined) output.contextLimit = contextLimit
      if (contextPercent !== undefined) output.contextPercent = contextPercent
      if (modelRef) {
        const modelOutput: ModelRefLike = {}
        if (modelRef.providerID) modelOutput.providerID = modelRef.providerID
        if (modelRef.id) modelOutput.id = modelRef.id
        if (modelRef.variant) modelOutput.variant = modelRef.variant
        if (Object.keys(modelOutput).length > 0) output.model = modelOutput
      }
      if (tree) {
        output.tree = tree
        if (tree.warning) warnings.push(tree.warning)
      }
      if (warnings.length > 0) output.warning = warnings.join("; ")

      const lines: string[] = [`Session ${sessionID}`]
      if (info.parentID) lines.push(`parent=${info.parentID}`)
      lines.push(`status=${status}${usageMayLag ? " (usage may lag)" : ""}`)
      if (ownCost !== undefined) lines.push(`cost=${formatCost(ownCost)}`)
      if (ownTokens) {
        lines.push(
          `used=${compactNumber(tokensUsed(ownTokens))} ` +
            `(input=${ownTokens.input}, output=${ownTokens.output}, reasoning=${ownTokens.reasoning}, ` +
            `cache.read=${ownTokens.cache.read}, cache.write=${ownTokens.cache.write})`,
        )
      }
      if (contextTokens !== undefined) {
        lines.push(
          `context=${compactNumber(contextTokens)}` +
            (contextLimit !== undefined ? ` / ${compactNumber(contextLimit)}` : "") +
            (contextPercent !== undefined ? ` (${contextPercent}%)` : ""),
        )
        if (contextUsage?.kind === CONTEXT_USAGE.usage) {
          lines.push(
            `last request: input=${contextUsage.lastRequest.input}, output=${contextUsage.lastRequest.output}, ` +
              `reasoning=${contextUsage.lastRequest.reasoning}, cache.read=${contextUsage.lastRequest.cacheRead}, ` +
              `cache.write=${contextUsage.lastRequest.cacheWrite}`,
          )
        }
      } else {
        lines.push("context=unavailable")
      }
      if (tree) {
        const treeUsed =
          tree.tokensUsed !== undefined ? compactNumber(tree.tokensUsed) : "unknown"
        lines.push(
          `tree: ${tree.sessions} session(s) (${tree.descendants} descendant(s)), cost=${formatCost(tree.costUSD)}, used=${treeUsed}` +
            (tree.descendantsMayLag ? " (descendant usage may lag)" : ""),
        )
      }
      if (warnings.length > 0) lines.push(`warning: ${warnings.join("; ")}`)
      const content = lines.join("\n")
      return outputStrategy.respond(content, output, format)
    },
  })
}
