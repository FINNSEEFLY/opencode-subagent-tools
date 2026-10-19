/** Truncate a string to a maximum number of Unicode code points. */
export const clip = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined
  const chars = Array.from(value)
  return chars.length > max ? chars.slice(0, max).join("") : value
}

/** Clip a model-provided string, trimming surrounding whitespace and rejecting blank input. */
export const clipText = (value: unknown, max: number): string | undefined => {
  const text = clip(value, max)?.trim()
  return text && text.length > 0 ? text : undefined
}

/** Count characters by Unicode code point, matching JSON Schema maxLength. */
export const textLength = (value: string): number => Array.from(value).length

/** C0/C1 controls, DEL, and Unicode line/paragraph separators. */
export const isUnsafeControlCode = (code: number): boolean =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029

/** Reject spaces and control characters in identifiers. */
export const hasUnsafeIdCharacters = (value: string): boolean =>
  Array.from(value).some((char) => {
    const code = char.codePointAt(0) ?? 0
    return code <= 0x20 || isUnsafeControlCode(code)
  })

/**
 * Reject over-long input with a short message instead of letting the tool
 * runtime echo the whole argument back in a schema-validation error.
 */
export const maxLengthError = (
  value: unknown,
  max: number,
  field: string,
): string | undefined => {
  if (typeof value !== "string") return undefined
  const length = textLength(value)
  return length > max
    ? `${field} is ${length} characters; maximum is ${max}. Shorten it and retry.`
    : undefined
}
