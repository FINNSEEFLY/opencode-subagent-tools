import type { Plugin } from "@opencode/plugin"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import type { Access } from "../access"
import type { Config } from "../config"
import { errorMessage, toolError } from "../errors"
import { INTERRUPT_OUTCOME, interruptOutcome } from "../interrupt"
import type { LiveStore } from "../live-state"
import { guardTarget, type Guard } from "../permissions"
import type { SessionInfoLike } from "../session"
import { CHILD_STATUSES, STATUS, statusIsIdle, type ChildStatus } from "../status"
import {
  TOKEN_USAGE_SCHEMA,
  normalizeTokens,
  tokensUsed,
  type TokenUsage,
} from "../tokens"
import {
  MAX_REASON_LENGTH,
  readTextField,
  readToolInput,
  requireSessionID,
} from "./input"
import { TOOL } from "./names"
import { formatPropertyDescription, resolveToolOutputStrategy } from "./output"

export const CANCEL_OUTCOME = {
  accepted: INTERRUPT_OUTCOME.accepted,
  rejected: INTERRUPT_OUTCOME.rejected,
  unknown: INTERRUPT_OUTCOME.unknown,
} as const

export type CancelOutcome = (typeof CANCEL_OUTCOME)[keyof typeof CANCEL_OUTCOME]

const CANCEL_PREFIX: Readonly<
  Record<CancelOutcome, (sessionID: string, status: ChildStatus) => string>
> = {
  [CANCEL_OUTCOME.accepted]: (sessionID) => `Interrupt requested for ${sessionID}`,
  [CANCEL_OUTCOME.rejected]: (sessionID, status) =>
    statusIsIdle(status)
      ? `${sessionID} was not running; no interrupt was needed`
      : `Interrupt was not accepted for ${sessionID}`,
  [CANCEL_OUTCOME.unknown]: (sessionID) => `Interrupt outcome unknown for ${sessionID}`,
}

export interface CancelOutput {
  sessionID: string
  accepted: boolean
  interrupt: CancelOutcome
  status: ChildStatus
  reason?: string
  readBackMayLag: boolean
  cancellationDoesNotCascade: boolean
  costUSD?: number
  tokens?: TokenUsage
  tokensUsed?: number
}

const CANCEL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    accepted: {
      type: "boolean",
      description: 'Alias for interrupt === "accepted".',
    },
    interrupt: {
      type: "string",
      enum: Object.values(CANCEL_OUTCOME),
      description:
        "accepted: server accepted; rejected: no active execution; unknown: aborted or no definitive answer.",
    },
    status: { type: "string", enum: [...CHILD_STATUSES] },
    reason: { type: "string" },
    readBackMayLag: { type: "boolean" },
    cancellationDoesNotCascade: {
      type: "boolean",
      description: "Always true; cancellation does not cascade.",
    },
    costUSD: { type: "number" },
    tokens: TOKEN_USAGE_SCHEMA,
    tokensUsed: { type: "integer" },
  },
  required: [
    "sessionID",
    "accepted",
    "interrupt",
    "status",
    "readBackMayLag",
    "cancellationDoesNotCascade",
  ],
  additionalProperties: false,
} as const

export interface CancelDeps {
  config: Config
  access: Access
  guard: Guard
  live: LiveStore
  session: Plugin.Context["session"]
}

export const registerCancelTool = (
  editor: ToolEditor,
  { config, access, guard, live, session }: CancelDeps,
) => {
  const { allowedOutputFormats } = config
  const outputStrategy = resolveToolOutputStrategy(allowedOutputFormats, TOOL.cancel)

  editor.add({
    name: TOOL.cancel,
    description:
      "Stop one session by its session ID. " +
      "This is a soft interrupt: it stops only that session, does not cascade, and a long tool call may finish first. " +
      "Jobs owned by an idle session keep running. " +
      "OpenCode may wake the parent with a cancellation notice. " +
      "The reason is recorded in the result and is not delivered to the child.",
    input: {
      type: "object",
      properties: {
        sessionID: {
          type: "string",
          description: "Target session ID, e.g. ses_...",
        },
        reason: {
          type: "string",
          description: `Short reason, recorded in the result. Maximum ${MAX_REASON_LENGTH} characters.`,
        },
        ...outputStrategy.formatProperty(
          formatPropertyDescription(outputStrategy, "structured output"),
        ),
      },
      required: ["sessionID"],
      additionalProperties: false,
    },
    output: outputStrategy.schema(CANCEL_OUTPUT_SCHEMA),
    options: { namespace: config.namespace },
    execute: async (rawInput, context) => {
      const { input, format } = readToolInput(rawInput, outputStrategy)
      const reasonField = readTextField(input?.reason, MAX_REASON_LENGTH, "reason")
      if (reasonField.error) return toolError(reasonField.error)
      const sessionID = requireSessionID(input?.sessionID)
      let info: SessionInfoLike | undefined
      try {
        info = await access.authorize(sessionID, context)
      } catch (error) {
        return toolError(errorMessage(error))
      }
      const reason = reasonField.text
      if (context?.signal?.aborted) {
        return toolError("Aborted before the interrupt was requested.")
      }
      // Guard errors propagate unchanged: a denial surfaces as a tool error,
      // and a plain rejection still ends the step.
      await guard([guardTarget(info, sessionID)], context)
      if (context?.signal?.aborted) {
        return toolError("Aborted before the interrupt was requested.")
      }
      let result: { interrupted?: boolean } | undefined
      try {
        result = (await session.interrupt(
          { sessionID, resume: false },
          { signal: context?.signal },
        )) as { interrupted?: boolean } | undefined
      } catch (error) {
        if (context?.signal?.aborted) {
          const status = live.liveStatusFor(sessionID) ?? STATUS.unknown
          return toolError(
            `Interrupt outcome unknown for ${sessionID}: the call was aborted while the interrupt was in flight; it may or may not have been accepted. Last observed state: ${status}. Run ${config.namespace}_${TOOL.list} to confirm.`,
          )
        }
        return toolError(`Interrupt failed for ${sessionID}: ${errorMessage(error)}`)
      }
      const { info: after } = await access.getSession(sessionID, context?.signal)
      const status = after
        ? live.statusFor(after, sessionID)
        : (live.liveStatusFor(sessionID) ?? STATUS.unknown)
      const interrupt = interruptOutcome(result)
      const accepted = interrupt === CANCEL_OUTCOME.accepted
      const readBackMayLag = accepted && !statusIsIdle(status)
      const prefix = CANCEL_PREFIX[interrupt](sessionID, status)
      const output: CancelOutput = {
        sessionID,
        accepted,
        interrupt,
        status,
        readBackMayLag,
        cancellationDoesNotCascade: true,
      }
      if (reason) output.reason = reason
      if (typeof after?.cost === "number" && Number.isFinite(after.cost))
        output.costUSD = after.cost
      const afterTokens = normalizeTokens(after?.tokens)
      if (afterTokens) {
        output.tokens = afterTokens
        output.tokensUsed = tokensUsed(afterTokens)
      }
      const lagNote = readBackMayLag ? " Read-back may lag; re-run list to confirm." : ""
      return outputStrategy.respond(
        `${prefix}${reason ? ` (${reason})` : ""}. Reported state now: ${status}.${lagNote}`,
        output,
        format,
      )
    },
  })
}
