import type { Plugin } from "@opencode/plugin"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import type { Access } from "../access"
import type { Config } from "../config"
import { encodeCursor, isAfterCursor, readCursor } from "../cursor"
import type { Discovery } from "../discovery"
import { errorMessage, toolError } from "../errors"
import { INTERRUPT_OUTCOME, interruptOutcome } from "../interrupt"
import type { LiveStore } from "../live-state"
import { guardTarget, type Guard } from "../permissions"
import { CHILD_STATUSES, STATUS, TERMINAL_STATUSES, type ChildStatus } from "../status"
import { MAX_REASON_LENGTH, readTextField, readToolInput } from "./input"
import { TOOL } from "./names"
import { formatPropertyDescription, resolveToolOutputStrategy } from "./output"

export const CANCEL_INTERRUPT = INTERRUPT_OUTCOME

export type CancelInterrupt = (typeof CANCEL_INTERRUPT)[keyof typeof CANCEL_INTERRUPT]

export const CANCEL_READ_BACK = {
  ok: "ok",
  failed: "failed",
  notRead: "not-read",
} as const

export type CancelReadBack = (typeof CANCEL_READ_BACK)[keyof typeof CANCEL_READ_BACK]

export interface CancelDescendantsTarget {
  sessionID: string
  interrupt: CancelInterrupt
  readBack: CancelReadBack
  status?: ChildStatus
  error?: string
}

export interface CancelDescendantsOutput {
  known: number
  considered: number
  running: number
  beforeCursorRunning?: number
  targets: CancelDescendantsTarget[]
  remaining: number
  aborted: boolean
  reason?: string
  cursor?: string
  warning?: string
}

const CANCEL_DESCENDANTS_TARGET_SCHEMA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    interrupt: {
      type: "string",
      enum: Object.values(CANCEL_INTERRUPT),
      description:
        "accepted: server accepted; rejected: no active execution; failed: call threw; unknown: aborted or no definitive answer.",
    },
    readBack: {
      type: "string",
      enum: Object.values(CANCEL_READ_BACK),
      description:
        "ok: status check succeeded and status is set; failed: status check failed; not-read: not attempted or aborted.",
    },
    status: { type: "string", enum: [...CHILD_STATUSES] },
    error: { type: "string" },
  },
  required: ["sessionID", "interrupt", "readBack"],
  additionalProperties: false,
} as const

const CANCEL_DESCENDANTS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    known: {
      type: "integer",
      description:
        "All discovered descendants in the current pass, before the cursor is applied.",
    },
    considered: {
      type: "integer",
      description: "Descendants after the cursor.",
    },
    running: {
      type: "integer",
      description: "Running descendants among considered.",
    },
    beforeCursorRunning: {
      type: "integer",
      description:
        "Running descendants before the cursor window; re-run without a cursor to include them.",
    },
    targets: {
      type: "array",
      description: "Attempted targets, newest launch first.",
      items: CANCEL_DESCENDANTS_TARGET_SCHEMA,
    },
    remaining: {
      type: "integer",
      description: "Running targets not attempted; use cursor to continue.",
    },
    aborted: {
      type: "boolean",
      description:
        "True when the call stopped before the batch completed; inspect targets and remaining, then retry.",
    },
    reason: { type: "string" },
    cursor: { type: "string" },
    warning: { type: "string" },
  },
  required: ["known", "considered", "running", "targets", "remaining", "aborted"],
  additionalProperties: false,
} as const

const isTerminalTarget = (target: CancelDescendantsTarget): boolean =>
  target.readBack === CANCEL_READ_BACK.ok &&
  target.status !== undefined &&
  TERMINAL_STATUSES.has(target.status)

const INTERRUPT_SUMMARY_LABEL: Readonly<Record<CancelInterrupt, string>> = {
  [CANCEL_INTERRUPT.accepted]: "interrupt accepted",
  [CANCEL_INTERRUPT.rejected]: "interrupt rejected",
  [CANCEL_INTERRUPT.failed]: "interrupt failed",
  [CANCEL_INTERRUPT.unknown]: "interrupt outcome unknown",
}

const INTERRUPT_SUMMARY_ORDER: readonly CancelInterrupt[] = Object.values(
  CANCEL_INTERRUPT,
).filter((outcome) => outcome !== CANCEL_INTERRUPT.accepted)

const READ_BACK_SUMMARY_LABEL: Readonly<Record<CancelReadBack, string>> = {
  [CANCEL_READ_BACK.ok]: "read-back ok",
  [CANCEL_READ_BACK.failed]: "read-back failed",
  [CANCEL_READ_BACK.notRead]: "read-back not completed",
}

const countInterrupts = (
  targets: readonly CancelDescendantsTarget[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>(
    Object.values(CANCEL_INTERRUPT).map((outcome) => [outcome, 0]),
  )
  for (const target of targets) {
    counts.set(target.interrupt, (counts.get(target.interrupt) ?? 0) + 1)
  }
  return counts
}

const countReadBacks = (
  targets: readonly CancelDescendantsTarget[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>(
    Object.values(CANCEL_READ_BACK).map((outcome) => [outcome, 0]),
  )
  for (const target of targets) {
    counts.set(target.readBack, (counts.get(target.readBack) ?? 0) + 1)
  }
  return counts
}

const READ_BACK_DETAIL: ReadonlyMap<CancelReadBack, string> = new Map([
  [CANCEL_READ_BACK.failed, READ_BACK_SUMMARY_LABEL[CANCEL_READ_BACK.failed]],
  [CANCEL_READ_BACK.notRead, READ_BACK_SUMMARY_LABEL[CANCEL_READ_BACK.notRead]],
])

type TargetDetail = (target: CancelDescendantsTarget) => string | undefined

const INTERRUPT_DETAIL: ReadonlyMap<CancelInterrupt, TargetDetail> = new Map([
  [
    CANCEL_INTERRUPT.accepted,
    (target: CancelDescendantsTarget) => READ_BACK_DETAIL.get(target.readBack),
  ],
  [
    CANCEL_INTERRUPT.rejected,
    (target: CancelDescendantsTarget) =>
      READ_BACK_DETAIL.get(target.readBack) ??
      (target.status === STATUS.running
        ? "interrupt rejected; state still says running"
        : undefined),
  ],
  [
    CANCEL_INTERRUPT.failed,
    (target: CancelDescendantsTarget) =>
      `interrupt failed: ${target.error ?? "unknown error"}`,
  ],
  [CANCEL_INTERRUPT.unknown, () => "interrupt outcome unknown"],
])

const targetDetail = (target: CancelDescendantsTarget): string => {
  const detail = INTERRUPT_DETAIL.get(target.interrupt)?.(target)
  if (detail) return detail
  if (target.status === STATUS.running) return "still running"
  if (target.status === STATUS.unknown) return "status unknown"
  return target.status ?? "status unavailable"
}

export const summarizeCancelDescendants = (
  targets: readonly CancelDescendantsTarget[],
  remaining: number,
  cursor?: string,
): string => {
  if (targets.length === 0) {
    if (remaining === 0) return "No running subagents needed an interrupt."
    return `No interrupts were attempted; ${remaining} running subagent(s) left${
      cursor ? `; use cursor ${cursor} to continue` : "; retry with the same cursor"
    }.`
  }

  const interruptCounts = countInterrupts(targets)
  const readBackCounts = countReadBacks(targets)
  const terminal = targets.filter(isTerminalTarget).length
  const stillRunning = targets.filter(
    (target) =>
      target.readBack === CANCEL_READ_BACK.ok && target.status === STATUS.running,
  ).length
  const readBackNotRead = targets.filter(
    (target) =>
      target.readBack === CANCEL_READ_BACK.notRead &&
      (target.interrupt === CANCEL_INTERRUPT.accepted ||
        target.interrupt === CANCEL_INTERRUPT.rejected),
  ).length
  const statusUnknown = targets.filter(
    (target) =>
      target.readBack === CANCEL_READ_BACK.ok && target.status === STATUS.unknown,
  ).length

  const accepted = interruptCounts.get(CANCEL_INTERRUPT.accepted) ?? 0
  const parts: string[] = [
    `Interrupt accepted for ${accepted} of ${targets.length} target(s)`,
  ]
  for (const outcome of INTERRUPT_SUMMARY_ORDER) {
    const count = interruptCounts.get(outcome) ?? 0
    if (count > 0) parts.push(`${count} ${INTERRUPT_SUMMARY_LABEL[outcome]}`)
  }
  const knownInterrupts = new Set<string>(Object.values(CANCEL_INTERRUPT))
  for (const [outcome, count] of interruptCounts) {
    if (!knownInterrupts.has(outcome) && count > 0) {
      parts.push(`${count} interrupt ${outcome}`)
    }
  }
  if (terminal > 0) parts.push(`${terminal} terminal`)
  if (stillRunning > 0) parts.push(`${stillRunning} still running`)
  const readBackFailed = readBackCounts.get(CANCEL_READ_BACK.failed) ?? 0
  if (readBackFailed > 0) {
    parts.push(`${readBackFailed} ${READ_BACK_SUMMARY_LABEL[CANCEL_READ_BACK.failed]}`)
  }
  if (readBackNotRead > 0) {
    parts.push(`${readBackNotRead} ${READ_BACK_SUMMARY_LABEL[CANCEL_READ_BACK.notRead]}`)
  }
  const knownReadBacks = new Set<string>(Object.values(CANCEL_READ_BACK))
  for (const [outcome, count] of readBackCounts) {
    if (!knownReadBacks.has(outcome) && count > 0) {
      parts.push(`${count} read-back ${outcome}`)
    }
  }
  if (statusUnknown > 0) parts.push(`${statusUnknown} status unknown`)

  let text = `${parts[0]}${parts.length > 1 ? `: ${parts.slice(1).join(", ")}` : ""}.`
  if (remaining > 0) {
    text += ` ${remaining} running subagent(s) left${
      cursor ? `; use cursor ${cursor} to continue` : "; retry with the same cursor"
    }.`
  }

  const details = targets
    .filter((target) => !isTerminalTarget(target))
    .map((target) => `${target.sessionID} (${targetDetail(target)})`)
  if (details.length > 0) text += `\n${details.join("\n")}`
  return text
}

export interface CancelDescendantsDeps {
  config: Config
  access: Access
  discovery: Discovery
  guard: Guard
  live: LiveStore
  session: Plugin.Context["session"]
}

export const registerCancelDescendantsTool = (
  editor: ToolEditor,
  { config, access, discovery, guard, live, session }: CancelDescendantsDeps,
) => {
  const { allowedOutputFormats, limits } = config
  const outputStrategy = resolveToolOutputStrategy(
    allowedOutputFormats,
    TOOL.cancelDescendants,
  )

  editor.add({
    name: TOOL.cancelDescendants,
    description:
      "Stop the running descendants of the calling session, including grandchildren, " +
      `up to ${limits.maxCancelBatch} at a time. ` +
      "There is no sessionID argument; it always stays in the caller's subtree. " +
      "The batch is checked in one permission request and reports each target in targets. " +
      "Use cursor while remaining is above 0. Cursor retries skip failed, unknown, rejected, and not-read targets. " +
      "Nested cancellation can wake an intermediate parent; re-run list and cancel it again if it resumed. " +
      "Discovery can miss running descendants. Use cancel for one target; this is a destructive batch and a soft interrupt, not a hard abort.",
    input: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: `Short reason, recorded in the result. Maximum ${MAX_REASON_LENGTH} characters.`,
        },
        cursor: {
          type: "string",
          description:
            "Cursor from a previous cancel_descendants call; pass it back unchanged.",
        },
        ...outputStrategy.formatProperty(
          formatPropertyDescription(outputStrategy, "a short summary"),
        ),
      },
      additionalProperties: false,
    },
    output: outputStrategy.schema(CANCEL_DESCENDANTS_OUTPUT_SCHEMA),
    options: { namespace: config.namespace },
    execute: async (rawInput, context) => {
      const { input, format } = readToolInput(rawInput, outputStrategy)
      const reasonField = readTextField(input?.reason, MAX_REASON_LENGTH, "reason")
      if (reasonField.error) return toolError(reasonField.error)
      const reason = reasonField.text
      const reasonText = reason ? ` (${reason})` : ""
      const caller = context?.sessionID
      if (!caller) {
        return toolError(
          "Refusing: the calling session is unknown, so the subtree to cancel cannot be determined.",
        )
      }
      const cursorResult = readCursor(input?.cursor, {
        tool: TOOL.cancelDescendants,
        root: caller,
      })
      if (cursorResult.error) {
        return toolError(cursorResult.error)
      }
      const cursor = cursorResult.cursor
      if (context?.signal?.aborted) {
        return toolError("Aborted before discovery.")
      }

      const respond = (content: string, output: CancelDescendantsOutput) =>
        outputStrategy.respond(content, output, format)

      const found = await discovery.discoverRows(caller, context?.signal)
      const warningMessage =
        "discovery was incomplete; some running subagents may not have been stopped."
      const warning = found.complete ? "" : `\nWarning: ${warningMessage}`
      const known = found.rows
      const afterCursor = cursor
        ? known.filter((row) => isAfterCursor(row, cursor))
        : known
      const running = afterCursor.filter((row) => row.status === STATUS.running)
      const beforeCursorRunning = cursor
        ? known.filter(
            (row) =>
              !(row.launchedAt === cursor.launchedAt && row.id === cursor.id) &&
              !isAfterCursor(row, cursor) &&
              row.status === STATUS.running,
          ).length
        : 0
      const cursorNote =
        beforeCursorRunning > 0
          ? `\nNote: ${beforeCursorRunning} running subagent(s) are before this cursor window; re-run without a cursor to include them.`
          : ""

      const emptyOutput = (aborted = false): CancelDescendantsOutput => ({
        known: known.length,
        considered: afterCursor.length,
        running: running.length,
        ...(beforeCursorRunning > 0 ? { beforeCursorRunning } : {}),
        targets: [],
        remaining: running.length,
        aborted,
        ...(reason ? { reason } : {}),
      })
      const finish = (content: string, output: CancelDescendantsOutput) =>
        found.complete
          ? respond(content + cursorNote, output)
          : respond(content + cursorNote + warning, {
              ...output,
              warning: warningMessage,
            })
      const abortBeforeInterrupts = () =>
        finish(
          `Aborted before any interrupt was requested.${reasonText}`,
          emptyOutput(true),
        )

      if (context?.signal?.aborted) return abortBeforeInterrupts()

      if (known.length === 0) {
        return finish(
          `Nothing to stop for ${caller}: no subagents discovered. ` +
            `Run ${config.namespace}_${TOOL.list} to see discovered sessions.${reasonText}`,
          emptyOutput(),
        )
      }

      if (afterCursor.length === 0) {
        return finish(
          `Cursor is past the end: ${known.length} known subagent(s).${reasonText}`,
          emptyOutput(),
        )
      }

      if (running.length === 0) {
        return finish(
          `No running subagents among ${afterCursor.length} known${cursor ? " after the cursor" : ""}.${reasonText}`,
          emptyOutput(),
        )
      }

      const targets = running.slice(0, limits.maxCancelBatch)
      if (context?.signal?.aborted) return abortBeforeInterrupts()

      // Evaluate the whole batch before interrupting anything: a denial
      // must surface as a tool error without leaving a partial batch behind.
      await guard(
        targets.map((target) => guardTarget(target, target.id)),
        context,
      )
      if (context?.signal?.aborted) return abortBeforeInterrupts()

      const results: CancelDescendantsTarget[] = []
      let aborted = false

      for (const target of targets) {
        if (context?.signal?.aborted) {
          aborted = true
          break
        }

        let interrupt: CancelInterrupt
        try {
          const result = (await session.interrupt(
            { sessionID: target.id, resume: false },
            { signal: context?.signal },
          )) as { interrupted?: boolean } | undefined
          interrupt = interruptOutcome(result)
        } catch (error) {
          if (context?.signal?.aborted) {
            results.push({
              sessionID: target.id,
              interrupt: CANCEL_INTERRUPT.unknown,
              readBack: CANCEL_READ_BACK.notRead,
              error: "aborted during interrupt; outcome unknown",
            })
            aborted = true
            break
          }
          results.push({
            sessionID: target.id,
            interrupt: CANCEL_INTERRUPT.failed,
            readBack: CANCEL_READ_BACK.notRead,
            error: errorMessage(error),
          })
          continue
        }

        if (context?.signal?.aborted) {
          results.push({
            sessionID: target.id,
            interrupt,
            readBack: CANCEL_READ_BACK.notRead,
            error: "aborted before read-back; outcome unknown",
          })
          aborted = true
          break
        }
        const { info: after, ok } = await access.getSession(target.id, context?.signal)
        if (!ok || !after) {
          if (context?.signal?.aborted) {
            results.push({
              sessionID: target.id,
              interrupt,
              readBack: CANCEL_READ_BACK.notRead,
              error: "aborted during read-back; outcome unknown",
            })
            aborted = true
            break
          }
          results.push({
            sessionID: target.id,
            interrupt,
            readBack: CANCEL_READ_BACK.failed,
            error: "read-back failed",
          })
          continue
        }
        results.push({
          sessionID: target.id,
          interrupt,
          readBack: CANCEL_READ_BACK.ok,
          status: live.statusFor(after, target.id),
        })
      }

      const remaining = Math.max(0, running.length - results.length)
      const nextCursor =
        remaining > 0 && results.length > 0
          ? encodeCursor(targets[results.length - 1], {
              tool: TOOL.cancelDescendants,
              root: caller,
            })
          : undefined
      const output: CancelDescendantsOutput = {
        known: known.length,
        considered: afterCursor.length,
        running: running.length,
        ...(beforeCursorRunning > 0 ? { beforeCursorRunning } : {}),
        targets: results,
        remaining,
        aborted,
      }
      if (reason) output.reason = reason
      if (nextCursor) output.cursor = nextCursor

      const summary = summarizeCancelDescendants(results, remaining, nextCursor)
      const abortText = aborted ? " Aborted before the batch completed." : ""
      return finish(summary + reasonText + abortText, output)
    },
  })
}
