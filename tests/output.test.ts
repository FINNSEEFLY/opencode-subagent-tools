import { describe, expect, test } from "bun:test"
import { OUTPUT_FORMAT } from "../src/config"
import { TOOL } from "../src/tools/names"
import {
  TOOL_FORMAT_DEFAULTS,
  formatPropertyDescription,
  resolveOutputStrategy,
  resolveToolOutputStrategy,
} from "../src/tools/output"

const schema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
} as const

const output = { value: "x" }

describe("resolveOutputStrategy", () => {
  test("text only", () => {
    const strategy = resolveOutputStrategy([OUTPUT_FORMAT.text], OUTPUT_FORMAT.text)

    expect(strategy.formats).toEqual([OUTPUT_FORMAT.text])
    expect(strategy.defaultFormat).toBe(OUTPUT_FORMAT.text)
    expect(strategy.formatProperty("unused")).toEqual({})
    expect(strategy.schema(schema)).toBeUndefined()
    expect(strategy.selectFormat(OUTPUT_FORMAT.json)).toBe(OUTPUT_FORMAT.text)
    expect(strategy.respond("content", output, OUTPUT_FORMAT.text)).toEqual({
      content: "content",
    })
  })

  test("json only", () => {
    const strategy = resolveOutputStrategy([OUTPUT_FORMAT.json], OUTPUT_FORMAT.text)

    expect(strategy.formats).toEqual([OUTPUT_FORMAT.json])
    expect(strategy.defaultFormat).toBe(OUTPUT_FORMAT.json)
    expect(strategy.formatProperty("unused")).toEqual({})
    expect(strategy.schema(schema)).toBe(schema)
    expect(strategy.selectFormat(OUTPUT_FORMAT.text)).toBe(OUTPUT_FORMAT.json)
    expect(strategy.respond("content", output, OUTPUT_FORMAT.json)).toEqual({
      content: "content",
      output,
    })
  })

  test("text and json with a text preference", () => {
    const strategy = resolveOutputStrategy(
      [OUTPUT_FORMAT.text, OUTPUT_FORMAT.json],
      OUTPUT_FORMAT.text,
    )

    expect(strategy.formats).toEqual([OUTPUT_FORMAT.text, OUTPUT_FORMAT.json])
    expect(strategy.defaultFormat).toBe(OUTPUT_FORMAT.text)
    expect(strategy.formatProperty("choose")).toEqual({
      format: {
        type: "string",
        enum: [OUTPUT_FORMAT.text, OUTPUT_FORMAT.json],
        description: "choose",
      },
    })
    expect(strategy.schema(schema)).toEqual({
      anyOf: [{ type: "string" }, schema],
    })
    expect(strategy.selectFormat(OUTPUT_FORMAT.json)).toBe(OUTPUT_FORMAT.json)
    expect(strategy.selectFormat(OUTPUT_FORMAT.text)).toBe(OUTPUT_FORMAT.text)
    expect(strategy.selectFormat("bogus")).toBe(OUTPUT_FORMAT.text)
    expect(strategy.respond("content", output, OUTPUT_FORMAT.text)).toEqual({
      content: "content",
      output: "content",
    })
    expect(strategy.respond("content", output, OUTPUT_FORMAT.json)).toEqual({
      content: "content",
      output,
    })
  })

  test("text and json with a json preference", () => {
    const strategy = resolveOutputStrategy(
      [OUTPUT_FORMAT.text, OUTPUT_FORMAT.json],
      OUTPUT_FORMAT.json,
    )

    expect(strategy.defaultFormat).toBe(OUTPUT_FORMAT.json)
    expect(strategy.selectFormat("bogus")).toBe(OUTPUT_FORMAT.json)
  })

  test("normalizes order and duplicates", () => {
    const reordered = resolveOutputStrategy(
      [OUTPUT_FORMAT.json, OUTPUT_FORMAT.text],
      OUTPUT_FORMAT.text,
    )
    expect(reordered.formats).toEqual([OUTPUT_FORMAT.text, OUTPUT_FORMAT.json])

    const duplicate = resolveOutputStrategy(
      [OUTPUT_FORMAT.json, OUTPUT_FORMAT.json],
      OUTPUT_FORMAT.text,
    )
    expect(duplicate.formats).toEqual([OUTPUT_FORMAT.json])
    expect(duplicate.defaultFormat).toBe(OUTPUT_FORMAT.json)
  })

  test("falls back to the default for empty or unknown input", () => {
    const empty = resolveOutputStrategy([], OUTPUT_FORMAT.text)
    expect(empty.formats).toEqual([OUTPUT_FORMAT.text, OUTPUT_FORMAT.json])

    const unknown = resolveOutputStrategy(["xml"] as never, OUTPUT_FORMAT.text)
    expect(unknown.formats).toEqual([OUTPUT_FORMAT.text, OUTPUT_FORMAT.json])
  })

  test("is safe for prototype keys", () => {
    const strategy = resolveOutputStrategy(
      [OUTPUT_FORMAT.text, OUTPUT_FORMAT.json],
      OUTPUT_FORMAT.text,
    )

    for (const key of ["toString", "constructor", "__proto__"]) {
      expect(strategy.selectFormat(key)).toBe(OUTPUT_FORMAT.text)
    }
    expect(() => strategy.respond("content", output, "toString" as never)).toThrow(
      "Unsupported output format",
    )
  })

  test("single format ignores a conflicting preferred format", () => {
    const text = resolveOutputStrategy([OUTPUT_FORMAT.text], OUTPUT_FORMAT.json)
    expect(text.defaultFormat).toBe(OUTPUT_FORMAT.text)
    expect(text.selectFormat(OUTPUT_FORMAT.json)).toBe(OUTPUT_FORMAT.text)

    const json = resolveOutputStrategy([OUTPUT_FORMAT.json], OUTPUT_FORMAT.text)
    expect(json.defaultFormat).toBe(OUTPUT_FORMAT.json)
    expect(json.selectFormat(OUTPUT_FORMAT.text)).toBe(OUTPUT_FORMAT.json)
  })

  test("keeps the per-tool defaults in one table", () => {
    expect(TOOL_FORMAT_DEFAULTS).toEqual({
      [TOOL.list]: OUTPUT_FORMAT.json,
      [TOOL.usage]: OUTPUT_FORMAT.json,
      [TOOL.cancelDescendants]: OUTPUT_FORMAT.json,
      [TOOL.cancel]: OUTPUT_FORMAT.text,
      [TOOL.steer]: OUTPUT_FORMAT.text,
      [TOOL.queue]: OUTPUT_FORMAT.text,
      [TOOL.context]: OUTPUT_FORMAT.text,
    })
  })

  test("describes the other format from the strategy", () => {
    const both = resolveOutputStrategy(
      [OUTPUT_FORMAT.text, OUTPUT_FORMAT.json],
      OUTPUT_FORMAT.text,
    )
    expect(formatPropertyDescription(both, "structured output")).toBe(
      "Response format. Defaults to text; use json for structured output.",
    )

    const single = resolveOutputStrategy([OUTPUT_FORMAT.text], OUTPUT_FORMAT.text)
    expect(formatPropertyDescription(single, "structured output")).toBe(
      "Response format. Defaults to text.",
    )
  })

  test("rejects prototype keys as tool names", () => {
    for (const key of ["toString", "constructor", "__proto__"]) {
      expect(() =>
        resolveToolOutputStrategy([OUTPUT_FORMAT.text, OUTPUT_FORMAT.json], key as never),
      ).toThrow("Unsupported tool")
    }
  })

  test("ignores prototype keys in the allowed format list", () => {
    for (const key of ["toString", "constructor", "__proto__"]) {
      const strategy = resolveOutputStrategy([key] as never, OUTPUT_FORMAT.text)
      expect(strategy.formats).toEqual([OUTPUT_FORMAT.text, OUTPUT_FORMAT.json])
      expect(strategy.selectFormat(key)).toBe(OUTPUT_FORMAT.text)
    }
  })

  test("single-format respond ignores a conflicting format", () => {
    const strategy = resolveOutputStrategy([OUTPUT_FORMAT.text], OUTPUT_FORMAT.text)
    expect(strategy.respond("content", output, OUTPUT_FORMAT.json)).toEqual({
      content: "content",
    })
  })
})
