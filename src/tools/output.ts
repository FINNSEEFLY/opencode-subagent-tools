import type { JsonSchema } from "effect"
import { OUTPUT_FORMAT, normalizeOutputFormats, type OutputFormat } from "../config"
import { TOOL, type ToolName } from "./names"

export interface OutputResult {
  readonly content: string
  readonly output?: unknown
}

export interface OutputFormatProperty {
  readonly format?: {
    readonly type: "string"
    readonly enum: readonly OutputFormat[]
    readonly description: string
  }
}

type ResponseFactory = (content: string, output: unknown) => OutputResult

interface FormatHandler {
  /** Response when this format is the only allowed one. */
  readonly solo: ResponseFactory
  /** Response when this format is selected among several allowed formats. */
  readonly combined: ResponseFactory
  /** Output schema when this format is the only allowed one. */
  readonly soloSchema: (
    schema: JsonSchema.JsonSchema,
  ) => JsonSchema.JsonSchema | undefined
  /** Output schema contribution when several formats are allowed. */
  readonly combinedSchema: (schema: JsonSchema.JsonSchema) => JsonSchema.JsonSchema
}

const TEXT_HANDLER: FormatHandler = {
  solo: (content) => ({ content }),
  combined: (content) => ({ content, output: content }),
  soloSchema: () => undefined,
  combinedSchema: () => ({ type: "string" }),
}

const JSON_HANDLER: FormatHandler = {
  solo: (content, output) => ({ content, output }),
  combined: (content, output) => ({ content, output }),
  soloSchema: (schema) => schema,
  combinedSchema: (schema) => schema,
}

const FORMAT_HANDLERS: Readonly<Record<OutputFormat, FormatHandler>> = {
  [OUTPUT_FORMAT.text]: TEXT_HANDLER,
  [OUTPUT_FORMAT.json]: JSON_HANDLER,
}

const FORMAT_HANDLER_MAP: ReadonlyMap<OutputFormat, FormatHandler> = new Map(
  Object.entries(FORMAT_HANDLERS) as Array<[OutputFormat, FormatHandler]>,
)

export interface OutputStrategy {
  /** Formats this strategy accepts, in canonical order. */
  readonly formats: readonly OutputFormat[]
  /** The effective default when format is omitted or invalid. */
  readonly defaultFormat: OutputFormat
  /** The per-call format input property, or an empty object when there is no choice. */
  readonly formatProperty: (description: string) => OutputFormatProperty
  /** The tool output schema, or undefined when output is text-only. */
  readonly schema: (schema: JsonSchema.JsonSchema) => JsonSchema.JsonSchema | undefined
  /** Resolve the effective format for this call. */
  readonly selectFormat: (requested: unknown) => OutputFormat
  /** Build the tool result for the selected format. */
  readonly respond: (
    content: string,
    output: unknown,
    format: OutputFormat,
  ) => OutputResult
}

export const TOOL_FORMAT_DEFAULTS: Readonly<Record<ToolName, OutputFormat>> = {
  [TOOL.list]: OUTPUT_FORMAT.json,
  [TOOL.usage]: OUTPUT_FORMAT.json,
  [TOOL.cancelDescendants]: OUTPUT_FORMAT.json,
  [TOOL.cancel]: OUTPUT_FORMAT.text,
  [TOOL.steer]: OUTPUT_FORMAT.text,
  [TOOL.queue]: OUTPUT_FORMAT.text,
  [TOOL.context]: OUTPUT_FORMAT.text,
}

const TOOL_FORMAT_DEFAULT_MAP: ReadonlyMap<ToolName, OutputFormat> = new Map(
  Object.entries(TOOL_FORMAT_DEFAULTS) as Array<[ToolName, OutputFormat]>,
)

const NO_FORMAT_PROPERTY = (): OutputFormatProperty => ({})

const handlerFor = (format: OutputFormat): FormatHandler => {
  const handler = FORMAT_HANDLER_MAP.get(format)
  if (!handler) throw new Error(`Unsupported output format: ${format}`)
  return handler
}

export const resolveOutputStrategy = (
  allowedOutputFormats: readonly OutputFormat[],
  preferredFormat: OutputFormat,
): OutputStrategy => {
  // Invalid and empty inputs fall back to the default set. The config layer
  // uses the same normalizer, so a malformed option cannot widen the surface.
  const formats = normalizeOutputFormats(allowedOutputFormats)
  const handlers = formats.map(handlerFor)
  const defaultFormat = formats.includes(preferredFormat) ? preferredFormat : formats[0]

  if (formats.length === 1) {
    const format = formats[0]
    const handler = handlers[0]
    return {
      formats,
      defaultFormat,
      formatProperty: NO_FORMAT_PROPERTY,
      schema: handler.soloSchema,
      selectFormat: () => format,
      respond: (content, output) => handler.solo(content, output),
    }
  }

  const handlerByFormat = new Map(
    formats.map((format, index) => [format, handlers[index]] as const),
  )

  return {
    formats,
    defaultFormat,
    formatProperty: (description) => ({
      format: {
        type: "string",
        enum: [...formats],
        description,
      },
    }),
    schema: (schema) => ({
      anyOf: handlers.map((handler) => handler.combinedSchema(schema)),
    }),
    selectFormat: (requested) =>
      typeof requested === "string" && handlerByFormat.has(requested as OutputFormat)
        ? (requested as OutputFormat)
        : defaultFormat,
    respond: (content, output, format) => {
      const handler = handlerByFormat.get(format)
      if (!handler) throw new Error(`Unsupported output format: ${format}`)
      return handler.combined(content, output)
    },
  }
}

export const resolveToolOutputStrategy = (
  allowedOutputFormats: readonly OutputFormat[],
  tool: ToolName,
): OutputStrategy => {
  const preferred = TOOL_FORMAT_DEFAULT_MAP.get(tool)
  if (!preferred) throw new Error(`Unsupported tool: ${String(tool)}`)
  return resolveOutputStrategy(allowedOutputFormats, preferred)
}

export const otherOutputFormat = (strategy: OutputStrategy): OutputFormat | undefined =>
  strategy.formats.find((format) => format !== strategy.defaultFormat)

export const formatPropertyDescription = (
  strategy: OutputStrategy,
  otherHint: string,
): string => {
  const other = otherOutputFormat(strategy)
  return other
    ? `Response format. Defaults to ${strategy.defaultFormat}; use ${other} for ${otherHint}.`
    : `Response format. Defaults to ${strategy.defaultFormat}.`
}
