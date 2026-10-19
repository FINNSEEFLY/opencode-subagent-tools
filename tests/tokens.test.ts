import { describe, expect, test } from "bun:test"
import { CONTEXT_USAGE, contextFromMessages, normalizeTokens } from "../src/tokens"

describe("tokens", () => {
  test("treats an object without numeric fields as missing", () => {
    expect(normalizeTokens(undefined)).toBeUndefined()
    expect(normalizeTokens(null)).toBeUndefined()
    expect(normalizeTokens({})).toBeUndefined()
    expect(normalizeTokens({ cache: {} })).toBeUndefined()
  })

  test("keeps a real zero and fills only the missing fields", () => {
    expect(normalizeTokens({ input: 0 })).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
    expect(normalizeTokens({ cache: { read: 0 } })).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
  })

  test("rejects malformed numeric fields", () => {
    expect(normalizeTokens({ input: "10", output: Number.NaN })).toBeUndefined()
    expect(normalizeTokens({ input: 10, output: Number.POSITIVE_INFINITY })).toEqual({
      input: 10,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
  })

  test("distinguishes an empty context from missing token data", () => {
    const empty = contextFromMessages([
      { id: "cmp_1", type: "compaction", status: "completed" },
    ])
    expect(empty).toEqual({ kind: CONTEXT_USAGE.empty })

    const missing = contextFromMessages([{ id: "msg_1", type: "assistant", tokens: {} }])
    expect(missing).toEqual({ kind: CONTEXT_USAGE.missing })

    const zero = contextFromMessages([
      { id: "msg_1", type: "assistant", tokens: { input: 0 } },
    ])
    expect(zero?.kind).toBe(CONTEXT_USAGE.usage)
    if (zero?.kind === CONTEXT_USAGE.usage) {
      expect(zero.total).toBe(0)
      expect(zero.lastRequest.total).toBe(0)
    }
  })
})
