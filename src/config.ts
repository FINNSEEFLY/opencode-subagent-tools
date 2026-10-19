import { clipText } from "./text"

export const DEFAULT_NAMESPACE = "subagent"
export const MAX_NAMESPACE_LENGTH = 64

export const SESSION_CONTROL_POLICY = {
  /** Only the calling session's subtree. */
  descendants: "descendants",
  /** Any session except the calling session's ancestors. */
  allExceptAncestors: "all-except-ancestors",
  /** Any session except the calling session itself. */
  all: "all",
} as const

export type SessionControlPolicy =
  (typeof SESSION_CONTROL_POLICY)[keyof typeof SESSION_CONTROL_POLICY]

export const SESSION_CONTROL_POLICIES: readonly SessionControlPolicy[] =
  Object.values(SESSION_CONTROL_POLICY)

export const isSessionControlPolicy = (value: unknown): value is SessionControlPolicy =>
  typeof value === "string" &&
  (SESSION_CONTROL_POLICIES as readonly string[]).includes(value)

export const OUTPUT_FORMAT = {
  text: "text",
  json: "json",
} as const

export type OutputFormat = (typeof OUTPUT_FORMAT)[keyof typeof OUTPUT_FORMAT]

export const OUTPUT_FORMATS: readonly OutputFormat[] = Object.values(OUTPUT_FORMAT)

export const isOutputFormat = (value: unknown): value is OutputFormat =>
  typeof value === "string" && (OUTPUT_FORMATS as readonly string[]).includes(value)

export const DEFAULT_ALLOWED_OUTPUT_FORMATS: readonly OutputFormat[] = OUTPUT_FORMATS

export const normalizeOutputFormats = (value: unknown): readonly OutputFormat[] => {
  if (!Array.isArray(value)) return DEFAULT_ALLOWED_OUTPUT_FORMATS
  const allowed = new Set<OutputFormat>()
  for (const item of value) {
    if (isOutputFormat(item)) allowed.add(item)
  }
  if (allowed.size === 0) return DEFAULT_ALLOWED_OUTPUT_FORMATS
  return OUTPUT_FORMATS.filter((format) => allowed.has(format))
}

export const LIMIT_SPECS = {
  /** Maximum nodes visited during one server discovery pass. */
  maxDiscoveryNodes: { default: 200, min: 1, max: 5000 },
  /** Maximum parent-chain depth walked during discovery and verification. */
  maxDiscoveryDepth: { default: 8, min: 1, max: 32 },
  /** Maximum session.list pages requested per parent. */
  maxDiscoveryPages: { default: 5, min: 1, max: 50 },
  /** Maximum rows returned by list per call. */
  maxListRows: { default: 20, min: 1, max: 50 },
  /** Maximum children interrupted by cancel_descendants per call. */
  maxCancelBatch: { default: 20, min: 1, max: 50 },
  /** Maximum characters accepted by steer, queue, and context. */
  maxTextLength: { default: 16000, min: 1, max: 32000 },
} as const

export type LimitKey = keyof typeof LIMIT_SPECS

export const LIMIT_KEYS = Object.keys(LIMIT_SPECS) as readonly LimitKey[]

export type Limits = { [Key in LimitKey]?: number }

export type ResolvedLimits = { [Key in LimitKey]: number }

export interface Options {
  /**
   * Route mutations through `ctx.permission.assert` with action
   * `subagent.control`. Defaults to true; set false to skip permission
   * evaluation entirely.
   */
  enforcePermissions?: boolean
  /**
   * Who mutating tools may target. Defaults to `"descendants"` (the calling
   * session's subtree). `"all-except-ancestors"` allows foreign sessions but
   * refuses the caller's parent chain. `"all"` allows any session except the
   * caller itself. Read-only tools are not restricted by this option.
   */
  sessionControlPolicy?: SessionControlPolicy | string
  /** Tool namespace; tools become `<namespace>_list`, `<namespace>_cancel`, ... */
  namespace?: string
  /**
   * Output formats the tools may return. `"text"` returns only the
   * human-readable content; `"json"` also returns a structured output object.
   * Include both to allow a per-call `format` choice. Defaults to
   * ["text", "json"]. Unknown values are ignored; an empty or invalid list
   * falls back to the default.
   */
  allowedOutputFormats?: readonly string[]
  /** Register the bundled SKILL.md as a model-facing skill. Defaults to true. */
  registerSkill?: boolean
  /** Optional tuning limits. See docs/configuration.md. */
  limits?: Limits
}

export interface Config {
  namespace: string
  enforcePermissions: boolean
  sessionControlPolicy: SessionControlPolicy
  allowedOutputFormats: readonly OutputFormat[]
  registerSkill: boolean
  limits: ResolvedLimits
}

export const limitInteger = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

const resolveLimits = (value: unknown): ResolvedLimits => {
  const raw = (value ?? {}) as Record<string, unknown>
  const resolved = {} as ResolvedLimits
  for (const key of LIMIT_KEYS) {
    const spec = LIMIT_SPECS[key]
    resolved[key] = limitInteger(raw[key], spec.default, spec.min, spec.max)
  }
  return resolved
}

export const resolveConfig = (raw: unknown): Config => {
  const options = (raw ?? {}) as Options
  return {
    namespace: clipText(options.namespace, MAX_NAMESPACE_LENGTH) ?? DEFAULT_NAMESPACE,
    enforcePermissions: options.enforcePermissions !== false,
    sessionControlPolicy: isSessionControlPolicy(options.sessionControlPolicy)
      ? options.sessionControlPolicy
      : SESSION_CONTROL_POLICY.descendants,
    allowedOutputFormats: normalizeOutputFormats(options.allowedOutputFormats),
    registerSkill: options.registerSkill !== false,
    limits: resolveLimits(options.limits),
  }
}
