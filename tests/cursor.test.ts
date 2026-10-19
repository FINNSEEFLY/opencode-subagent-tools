import { describe, expect, test } from "bun:test"
import {
  CURSOR_VERSION,
  MAX_CURSOR_LENGTH,
  encodeCursor,
  readCursor,
} from "../src/cursor"
import { TOOL } from "../src/tools/names"

const scope = { tool: TOOL.list, root: "ses_parent", filter: "running" }
const row = { launchedAt: 10, id: "ses_child" }

const payload = (value: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

describe("cursor", () => {
  test("accepts a cursor for the same tool, root, and filter", () => {
    const cursor = encodeCursor(row, scope)
    expect(readCursor(cursor, scope)).toEqual({
      cursor: { launchedAt: 10, id: "ses_child" },
    })
  })

  test("rejects a cursor for another tool, root, or filter", () => {
    const cursor = encodeCursor(row, scope)
    expect(readCursor(cursor, { ...scope, tool: TOOL.cancelDescendants })).toEqual({
      error: expect.stringContaining("Invalid cursor"),
    })
    expect(readCursor(cursor, { ...scope, root: "ses_other" })).toEqual({
      error: expect.stringContaining("Invalid cursor"),
    })
    expect(readCursor(cursor, { ...scope, filter: "finished" })).toEqual({
      error: expect.stringContaining("Invalid cursor"),
    })
  })

  test("rejects an unknown version or tool", () => {
    const unknownVersion = payload({
      v: CURSOR_VERSION + 1,
      tool: TOOL.list,
      root: "ses_parent",
      launchedAt: 10,
      id: "ses_child",
    })
    expect(readCursor(unknownVersion, scope)).toEqual({
      error: expect.stringContaining("Invalid cursor"),
    })

    for (const tool of ["usage", "toString", "__proto__"]) {
      const unknownTool = payload({
        v: CURSOR_VERSION,
        tool,
        root: "ses_parent",
        launchedAt: 10,
        id: "ses_child",
      })
      expect(readCursor(unknownTool, scope)).toEqual({
        error: expect.stringContaining("Invalid cursor"),
      })
    }
  })

  test("rejects malformed input and accepts an omitted cursor", () => {
    expect(readCursor(undefined, scope)).toEqual({})
    expect(readCursor("", scope)).toEqual({
      error: expect.stringContaining("Invalid cursor"),
    })
    expect(readCursor("x".repeat(MAX_CURSOR_LENGTH + 1), scope)).toEqual({
      error: expect.stringContaining("Invalid cursor"),
    })
    expect(readCursor({ id: "ses_child" }, scope)).toEqual({
      error: expect.stringContaining("Invalid cursor"),
    })
  })
})
