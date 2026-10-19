import type { ToolEditor } from "@opencode/plugin/promise/tool"
import type { Config } from "../config"
import { toolError } from "../errors"
import {
  CONTEXT_DELIVERY,
  DELIVERY,
  SEND_KIND,
  SendAdmissionError,
  applySendResult,
  type Delivery,
  type SendMessage,
  type SendResultFields,
} from "../messages"
import { CHILD_STATUSES } from "../status"
import { maxLengthError, textLength } from "../text"
import {
  MAX_DESCRIPTION_LENGTH,
  readTextField,
  readToolInput,
  requireSessionID,
  requireText,
} from "./input"
import { TOOL } from "./names"
import {
  formatPropertyDescription,
  resolveToolOutputStrategy,
  type OutputStrategy,
} from "./output"

export interface SendOutput extends SendResultFields {
  sessionID: string
  delivery: Delivery
  chars: number
  resume: boolean
}

export interface ContextOutput extends SendResultFields {
  sessionID: string
  delivery: typeof CONTEXT_DELIVERY
  chars: number
  description?: string
}

const SEND_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    messageID: { type: "string" },
    delivery: { type: "string", enum: Object.values(DELIVERY) },
    chars: { type: "integer" },
    resume: {
      type: "boolean",
      description: "Whether the message could wake an idle child.",
    },
    status: {
      type: "string",
      enum: [...CHILD_STATUSES],
      description:
        "Status observed before the message was accepted; a wake may not be reflected yet.",
    },
    pending: {
      type: "boolean",
      description: "True when the message was accepted without waking an idle child.",
    },
  },
  required: ["sessionID", "delivery", "chars", "resume"],
  additionalProperties: false,
} as const

const CONTEXT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    messageID: { type: "string" },
    delivery: { type: "string", enum: [CONTEXT_DELIVERY] },
    chars: { type: "integer" },
    description: { type: "string" },
    status: {
      type: "string",
      enum: [...CHILD_STATUSES],
      description:
        "Status observed before the message was accepted; context does not wake the child.",
    },
    pending: { type: "boolean" },
  },
  required: ["sessionID", "delivery", "chars"],
  additionalProperties: false,
} as const

export interface PromptSendConfig {
  delivery: Delivery
  failureLabel: string
  outputStrategy: OutputStrategy
}

const ADMITTED_LABEL: Record<Delivery, string> = {
  [DELIVERY.steer]: "Steering message sent to",
  [DELIVERY.queue]: "Message queued for",
}

export interface SendDeps {
  config: Config
  sendMessage: SendMessage
}

/**
 * Shared execute path for the two prompt-delivery tools. The requested
 * delivery is fixed per tool; the output uses the delivery reported for the
 * accepted message when provided.
 */
const runPromptSend = async (
  rawInput: unknown,
  context: Parameters<SendMessage>[1],
  config: PromptSendConfig,
  { config: pluginConfig, sendMessage }: SendDeps,
) => {
  const { limits } = pluginConfig
  const { outputStrategy } = config
  const { input, format } = readToolInput(rawInput, outputStrategy)
  const textError = maxLengthError(input.text, limits.maxTextLength, "text")
  if (textError) return toolError(textError)
  const sessionID = requireSessionID(input.sessionID)
  const text = requireText(input.text, limits.maxTextLength)
  const resume = input.resume === undefined ? true : input.resume === true
  try {
    const result = await sendMessage(
      {
        sessionID,
        text,
        kind: SEND_KIND.prompt,
        delivery: config.delivery,
        resume,
      },
      context,
      config.failureLabel,
    )
    const delivery = result.admitted?.delivery ?? config.delivery
    const admittedLabel = ADMITTED_LABEL[delivery]
    const chars = textLength(result.admitted?.text ?? text)
    const output: SendOutput = {
      sessionID,
      delivery,
      chars,
      resume,
    }
    applySendResult(output, result)
    return outputStrategy.respond(
      `${admittedLabel} ${sessionID}` +
        (result.admitted?.id ? ` as ${result.admitted.id}` : "") +
        ` (delivery=${delivery}, resume=${resume}, ${chars} chars).`,
      output,
      format,
    )
  } catch (error) {
    if (error instanceof SendAdmissionError) return toolError(error.message)
    throw error
  }
}

const sendInputSchema = (
  outputStrategy: OutputStrategy,
  maxTextLength: number,
  textDescription: string,
  resumeDescription: string,
) => ({
  type: "object",
  properties: {
    sessionID: {
      type: "string",
      description: "Target session ID, e.g. ses_...",
    },
    text: {
      type: "string",
      description: `${textDescription} Maximum ${maxTextLength} characters; longer input is rejected.`,
    },
    resume: {
      type: "boolean",
      description: resumeDescription,
    },
    ...outputStrategy.formatProperty(
      formatPropertyDescription(outputStrategy, "structured output"),
    ),
  },
  required: ["sessionID", "text"],
  additionalProperties: false,
})

export const registerSteerTool = (editor: ToolEditor, deps: SendDeps) => {
  const { allowedOutputFormats, limits } = deps.config
  const outputStrategy = resolveToolOutputStrategy(allowedOutputFormats, TOOL.steer)
  editor.add({
    name: TOOL.steer,
    description:
      "Send an instruction into a session at its next model request. " +
      "Use it to correct course, add a constraint, or forbid a step. " +
      "It does not interrupt current work: the message is delivered before the next request. " +
      "By default an idle child is woken; set resume:false to accept the message without waking it. " +
      "Use queue instead when the message should wait until the current task settles.",
    input: sendInputSchema(
      outputStrategy,
      limits.maxTextLength,
      "Instruction for the child.",
      "Default true: wake an idle child and start a new turn. Set false to accept without waking; an idle child keeps the message pending until its next run.",
    ),
    output: outputStrategy.schema(SEND_OUTPUT_SCHEMA),
    options: { namespace: deps.config.namespace },
    execute: async (rawInput, context) =>
      runPromptSend(
        rawInput,
        context,
        {
          delivery: DELIVERY.steer,
          failureLabel: "Steer",
          outputStrategy,
        },
        deps,
      ),
  })
}

export const registerQueueTool = (editor: ToolEditor, deps: SendDeps) => {
  const { allowedOutputFormats, limits } = deps.config
  const outputStrategy = resolveToolOutputStrategy(allowedOutputFormats, TOOL.queue)
  editor.add({
    name: TOOL.queue,
    description:
      "Queue a message for a session as its next independent turn. " +
      "Unlike steer, it does not join the current run: it waits until the current task settles, then starts a separate turn. " +
      "Use it for 'do this next' work. By default an idle child is woken; set resume:false to accept the message without waking it. " +
      "Use steer instead to correct the current run.",
    input: sendInputSchema(
      outputStrategy,
      limits.maxTextLength,
      "Follow-up message.",
      "Default true: wake an idle child and start the queued turn. Set false to accept without waking; an idle child keeps the message pending until its next run.",
    ),
    output: outputStrategy.schema(SEND_OUTPUT_SCHEMA),
    options: { namespace: deps.config.namespace },
    execute: async (rawInput, context) =>
      runPromptSend(
        rawInput,
        context,
        {
          delivery: DELIVERY.queue,
          failureLabel: "Queue",
          outputStrategy,
        },
        deps,
      ),
  })
}

export const registerContextTool = (editor: ToolEditor, deps: SendDeps) => {
  const { allowedOutputFormats, limits } = deps.config
  const outputStrategy = resolveToolOutputStrategy(allowedOutputFormats, TOOL.context)
  const { sendMessage } = deps

  editor.add({
    name: TOOL.context,
    description:
      "Inject context into a session without asking for a turn: a synthetic message. " +
      "Delivered at the child's next step boundary; an idle child keeps it pending until it runs again. " +
      "Use it for facts and intermediate results, not for instructions. " +
      "For an instruction without waking, use steer with resume:false; for a follow-up turn, use queue.",
    input: {
      type: "object",
      properties: {
        sessionID: {
          type: "string",
          description: "Target session ID, e.g. ses_...",
        },
        text: {
          type: "string",
          description: `Context text. Maximum ${limits.maxTextLength} characters; longer input is rejected.`,
        },
        description: {
          type: "string",
          description: `Short label shown in the transcript. Maximum ${MAX_DESCRIPTION_LENGTH} characters.`,
        },
        ...outputStrategy.formatProperty(
          formatPropertyDescription(outputStrategy, "structured output"),
        ),
      },
      required: ["sessionID", "text"],
      additionalProperties: false,
    },
    output: outputStrategy.schema(CONTEXT_OUTPUT_SCHEMA),
    options: { namespace: deps.config.namespace },
    execute: async (rawInput, context) => {
      const { input, format } = readToolInput(rawInput, outputStrategy)
      const textError = maxLengthError(input?.text, limits.maxTextLength, "text")
      if (textError) return toolError(textError)
      const descriptionField = readTextField(
        input?.description,
        MAX_DESCRIPTION_LENGTH,
        "description",
      )
      if (descriptionField.error) return toolError(descriptionField.error)
      const sessionID = requireSessionID(input?.sessionID)
      const text = requireText(input?.text, limits.maxTextLength)
      const description = descriptionField.text
      try {
        const result = await sendMessage(
          {
            sessionID,
            text,
            kind: SEND_KIND.synthetic,
            resume: false,
            description,
          },
          context,
          "Context injection",
        )
        const chars = textLength(result.admitted?.text ?? text)
        const output: ContextOutput = {
          sessionID,
          delivery: CONTEXT_DELIVERY,
          chars,
        }
        if (description) output.description = description
        applySendResult(output, result)
        return outputStrategy.respond(
          `Context injected into ${sessionID}` +
            (result.admitted?.id ? ` as ${result.admitted.id}` : "") +
            ` (${chars} chars).`,
          output,
          format,
        )
      } catch (error) {
        if (error instanceof SendAdmissionError) return toolError(error.message)
        throw error
      }
    },
  })
}
