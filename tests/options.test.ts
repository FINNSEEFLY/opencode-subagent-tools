import { describe, expect, test } from "bun:test"
import {
  makeHarness,
  ALL_STATUSES,
  createChild,
  sessionInfo,
  listOf,
  waitFor,
  cleanups,
} from "./harness"
describe("options and events", () => {
  test("applies a custom namespace", async () => {
    const h = makeHarness({ options: { namespace: "agentctl" } })
    cleanups.push(await h.setup())

    expect(h.namespaces).toEqual([
      {
        name: "agentctl",
        description: "Inspect, stop, steer and feed context to subagent sessions.",
      },
    ])
    for (const tool of h.tools.values()) expect(tool.options.namespace).toBe("agentctl")

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_foreign" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("agentctl_list")
  })

  test("falls back to the default namespace for a blank namespace", async () => {
    const h = makeHarness({ options: { namespace: "   " } })
    cleanups.push(await h.setup())

    expect(h.namespaces[0].name).toBe("subagent")
    for (const tool of h.tools.values()) expect(tool.options.namespace).toBe("subagent")
  })

  test("registers the bundled SKILL.md as a skill", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    const skill = h.skills.get("subagent-tools")
    expect(skill).toBeDefined()
    expect(skill.name).toBe("subagent-tools")
    expect(skill.description).toContain("subagent")
    expect(skill.content).toContain("cancel_descendants")
    expect(skill.path).toContain("SKILL.md")
  })

  test("registerSkill false skips the skill", async () => {
    const h = makeHarness({ options: { registerSkill: false } })
    cleanups.push(await h.setup())

    expect(h.skills.size).toBe(0)
  })

  test("subscribes only to the event types it consumes", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())
    await h.tick()

    expect(h.eventSubscribeCalls).toHaveLength(1)
    expect([...h.eventSubscribeCalls[0].types].toSorted()).toEqual(
      [
        "session.deleted",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.execution.started",
        "session.execution.succeeded",
        "session.idle",
        "session.status",
      ].toSorted(),
    )
    expect(typeof h.eventSubscribeCalls[0].onActivity).toBe("function")
  })

  test("ignores a non-function event subscriber", async () => {
    const h = makeHarness()
    h.ctx.event.subscribe = 42
    cleanups.push(await h.setup())
    await h.tick()

    expect(h.eventSubscribeCalls).toHaveLength(0)
  })

  test("logs and survives an event stream failure", async () => {
    const logged: any[][] = []
    const original = console.error
    console.error = (...args: any[]) => {
      logged.push(args)
    }
    try {
      const h = makeHarness({ eventError: new Error("stream broke") })
      cleanups.push(await h.setup())
      await h.tick()
      expect(
        logged.some((args) => String(args[0]).includes("event stream stopped")),
      ).toBe(true)
    } finally {
      console.error = original
    }
  })

  test("reconnects after a transient event stream failure", async () => {
    const original = console.error
    console.error = () => undefined
    try {
      const h = makeHarness({ eventError: new Error("stream broke"), eventFailures: 1 })
      h.sessions.set(
        "ses_child",
        sessionInfo("ses_child", "ses_parent", {
          outcome: "succeeded",
          time: { created: 1, updated: 10, idle: 10 },
        }),
      )
      cleanups.push(await h.setup())
      h.emit({
        type: "session.execution.started",
        data: { sessionID: "ses_child" },
        created: 20,
      })

      const result = await waitFor(
        () =>
          h.tools.get("list").execute({}, { sessionID: "ses_parent" }) as Promise<{
            content: string
          }>,
        (value: { content: string }) =>
          listOf(value, "ses_child")?.includes("running") ?? false,
      )
      expect(listOf(result, "ses_child")).toContain("running")
    } finally {
      console.error = original
    }
  })

  test("works when the build exposes no event stream", async () => {
    const h = makeHarness()
    delete (h.ctx as any).event
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(result.content).toContain("ses_child")
  })

  test("cleanup aborts the event stream and disposes tools", async () => {
    const h = makeHarness()
    const cleanup = await h.setup()
    expect(h.tools.size).toBe(7)

    await cleanup()
    expect(h.tools.size).toBe(0)
    h.emit({ type: "session.execution.started", data: { sessionID: "ses_child" } })
    await h.tick()
  })

  test("refuses to start work when the tool signal is already aborted", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    const controller = new AbortController()
    controller.abort()
    const signal = controller.signal
    const context = { sessionID: "ses_parent", signal }

    await expect(h.tools.get("list").execute({}, context)).rejects.toThrow(
      "Aborted before discovery",
    )
    await expect(
      h.tools.get("cancel").execute({ sessionID: "ses_child" }, context),
    ).rejects.toThrow("Aborted before the target could be verified")
    await expect(h.tools.get("cancel_descendants").execute({}, context)).rejects.toThrow(
      "Aborted before discovery",
    )
    await expect(
      h.tools.get("steer").execute({ sessionID: "ses_child", text: "go" }, context),
    ).rejects.toThrow("Aborted before the target could be verified")
    await expect(
      h.tools.get("context").execute({ sessionID: "ses_child", text: "note" }, context),
    ).rejects.toThrow("Aborted before the target could be verified")
    expect(h.calls.interrupt).toHaveLength(0)
    expect(h.calls.prompt).toHaveLength(0)
    expect(h.calls.synthetic).toHaveLength(0)
    expect(h.calls.permission).toHaveLength(0)
  })

  test("sessionControlPolicy all applies to steer and context", async () => {
    const h = makeHarness({ options: { sessionControlPolicy: "all" } })
    createChild(h, "ses_foreign", "ses_other_parent")
    cleanups.push(await h.setup())

    await h.tools
      .get("steer")
      .execute({ sessionID: "ses_foreign", text: "go" }, { sessionID: "ses_parent" })
    await h.tools
      .get("context")
      .execute({ sessionID: "ses_foreign", text: "note" }, { sessionID: "ses_parent" })
    expect(h.calls.prompt).toHaveLength(1)
    expect(h.calls.synthetic).toHaveLength(1)
  })
})

describe("allowedOutputFormats", () => {
  test("defaults to text and json with per-tool defaults", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const list = h.tools.get("list")
    expect(list.input.properties.format).toEqual({
      type: "string",
      enum: ["text", "json"],
      description: expect.any(String),
    })
    expect(list.output.anyOf).toBeDefined()

    const cancel = h.tools.get("cancel")
    expect(cancel.input.properties.format).toBeDefined()
    expect(cancel.output.anyOf).toBeDefined()

    const listed = await list.execute({}, { sessionID: "ses_parent" })
    expect(typeof listed.output).toBe("object")

    const cancelled = await cancel.execute(
      { sessionID: "ses_child" },
      { sessionID: "ses_parent" },
    )
    expect(typeof cancelled.output).toBe("string")
  })

  test("applies the per-tool default output format", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const list = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(typeof list.output).toBe("object")

    const usage = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(typeof usage.output).toBe("object")

    const cancelDescendants = await h.tools
      .get("cancel_descendants")
      .execute({}, { sessionID: "ses_parent" })
    expect(typeof cancelDescendants.output).toBe("object")

    const cancel = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(typeof cancel.output).toBe("string")

    const steer = await h.tools
      .get("steer")
      .execute({ sessionID: "ses_child", text: "go" }, { sessionID: "ses_parent" })
    expect(typeof steer.output).toBe("string")

    const queue = await h.tools
      .get("queue")
      .execute({ sessionID: "ses_child", text: "next" }, { sessionID: "ses_parent" })
    expect(typeof queue.output).toBe("string")

    const context = await h.tools
      .get("context")
      .execute({ sessionID: "ses_child", text: "note" }, { sessionID: "ses_parent" })
    expect(typeof context.output).toBe("string")
  })

  test("text only omits format and structured output", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["text"] } })
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    for (const tool of h.tools.values()) {
      expect(tool.input.properties.format).toBeUndefined()
      expect(tool.output).toBeUndefined()
    }

    const listed = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(listed.output).toBeUndefined()
    expect(listed.content).toContain("ses_child")

    const cancelled = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" })
    expect(cancelled.output).toBeUndefined()
    expect(cancelled.content).toContain("Interrupt requested")
  })

  test("json only omits format and always returns an object output", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["json"] } })
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    for (const tool of h.tools.values()) {
      expect(tool.input.properties.format).toBeUndefined()
      expect(tool.output).toBeDefined()
      expect(tool.output.anyOf).toBeUndefined()
    }

    const listed = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(typeof listed.output).toBe("object")
    expect(listed.output.root).toBe("ses_parent")
    expect(typeof listed.content).toBe("string")

    const cancelled = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "text" }, { sessionID: "ses_parent" })
    expect(typeof cancelled.output).toBe("object")
    expect(cancelled.output.sessionID).toBe("ses_child")
    expect(typeof cancelled.content).toBe("string")
  })

  test("invalid, empty, non-array, and duplicate entries are resolved", async () => {
    const invalid = makeHarness({ options: { allowedOutputFormats: ["bogus"] } })
    cleanups.push(await invalid.setup())
    expect(invalid.tools.get("list").input.properties.format).toBeDefined()

    const empty = makeHarness({ options: { allowedOutputFormats: [] } })
    cleanups.push(await empty.setup())
    expect(empty.tools.get("list").input.properties.format).toBeDefined()

    const notArray = makeHarness({ options: { allowedOutputFormats: "json" } })
    cleanups.push(await notArray.setup())
    expect(notArray.tools.get("list").input.properties.format).toBeDefined()

    const duplicate = makeHarness({
      options: { allowedOutputFormats: ["json", "json"] },
    })
    cleanups.push(await duplicate.setup())
    expect(duplicate.tools.get("list").input.properties.format).toBeUndefined()
    expect(duplicate.tools.get("list").output.anyOf).toBeUndefined()

    const mixed = makeHarness({
      options: { allowedOutputFormats: ["json", "bogus"] },
    })
    cleanups.push(await mixed.setup())
    expect(mixed.tools.get("list").input.properties.format).toBeUndefined()
  })
})
