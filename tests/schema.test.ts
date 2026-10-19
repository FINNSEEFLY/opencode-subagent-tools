import { describe, expect, test } from "bun:test"
import { cleanups, createChild, makeHarness } from "./harness"
import { validateSchema } from "./schema"

const calls: Array<[string, Record<string, unknown>]> = [
  ["list", {}],
  ["usage", { sessionID: "ses_child", includeDescendants: true }],
  ["steer", { sessionID: "ses_child", text: "go" }],
  ["queue", { sessionID: "ses_child", text: "next" }],
  ["context", { sessionID: "ses_child", text: "note" }],
  ["cancel_descendants", {}],
  ["cancel", { sessionID: "ses_child" }],
]

describe("tool output schemas", () => {
  test("representative outputs match the registered schemas", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    createChild(h, "ses_grand", "ses_child")
    cleanups.push(await h.setup())

    const context = { sessionID: "ses_parent" }
    for (const [name, input] of calls) {
      const tool = h.tools.get(name)
      const result = await tool.execute({ ...input, format: "json" }, context)
      expect(result.output).toBeDefined()
      expect(validateSchema(result.output, tool.output)).toEqual([])
    }
  })

  test("validates the direct schema in json-only mode", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["json"] } })
    createChild(h, "ses_child", "ses_parent")
    createChild(h, "ses_grand", "ses_child")
    cleanups.push(await h.setup())

    const context = { sessionID: "ses_parent" }
    for (const [name, input] of calls) {
      const tool = h.tools.get(name)
      expect(tool.output.anyOf).toBeUndefined()
      const result = await tool.execute(input, context)
      expect(validateSchema(result.output, tool.output)).toEqual([])
    }
  })

  test("the validator catches missing, wrong, and extra fields", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    }
    expect(validateSchema({ id: "x" }, schema)).toEqual([])
    expect(validateSchema({}, schema)).not.toEqual([])
    expect(validateSchema({ id: 1 }, schema)).not.toEqual([])
    expect(validateSchema({ id: "x", extra: true }, schema)).not.toEqual([])
  })
})
