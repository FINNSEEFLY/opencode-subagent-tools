import { describe, expect, test } from "bun:test"
import { makeHarness, createChild, cleanups } from "./harness"
describe("permissions", () => {
  test("approval is on by default and guards every mutation", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    await h.tools
      .get("steer")
      .execute({ sessionID: "ses_child", text: "go" }, { sessionID: "ses_parent" })
    await h.tools
      .get("queue")
      .execute({ sessionID: "ses_child", text: "next" }, { sessionID: "ses_parent" })
    await h.tools
      .get("context")
      .execute({ sessionID: "ses_child", text: "note" }, { sessionID: "ses_parent" })

    expect(h.calls.permission).toHaveLength(4)
    expect(h.calls.permission.every((call) => call.action === "subagent.control")).toBe(
      true,
    )
    expect(h.calls.permission.every((call) => call.resources.length === 1)).toBe(true)
  })

  test("enforcePermissions false skips the permission API", async () => {
    const h = makeHarness({ options: { enforcePermissions: false } })
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(h.calls.permission).toHaveLength(0)
    expect(h.calls.interrupt).toHaveLength(1)
  })

  test("a permission denial surfaces as a tool error and blocks the mutation", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.ctx.permission.assert = async () => {
      throw new Error("permission denied by policy")
    }

    let error: unknown
    try {
      await h.tools
        .get("cancel")
        .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    } catch (caught) {
      error = caught
    }
    expect(String(error)).toContain("permission denied by policy")
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("passes the originating tool call to the permission API", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    await h.tools
      .get("cancel")
      .execute(
        { sessionID: "ses_child" },
        { sessionID: "ses_parent", agent: "build", messageID: "msg_1", id: "call_1" },
      )

    expect(h.calls.permission[0].sessionID).toBe("ses_parent")
    expect(h.calls.permission[0].agent).toBe("build")
    expect(h.calls.permission[0].source).toEqual({
      type: "tool",
      messageID: "msg_1",
      id: "call_1",
    })
    expect(h.calls.permission[0].resources).toEqual(["ses_child"])
  })

  test("permission errors from send tools are not re-wrapped", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    const denied = new Error("plain permission rejection")
    h.ctx.permission.assert = async () => {
      throw denied
    }

    for (const [tool, input] of [
      ["steer", { sessionID: "ses_child", text: "go" }],
      ["queue", { sessionID: "ses_child", text: "next" }],
      ["context", { sessionID: "ses_child", text: "note" }],
    ] as const) {
      let caught: unknown
      try {
        await h.tools.get(tool).execute(input, { sessionID: "ses_parent" })
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(denied)
    }

    expect(h.calls.prompt).toHaveLength(0)
    expect(h.calls.synthetic).toHaveLength(0)
  })

  test("cancel does not interrupt after the signal is aborted during permission evaluation", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    const controller = new AbortController()
    h.ctx.permission.assert = async () => {
      controller.abort()
    }

    await expect(
      h.tools
        .get("cancel")
        .execute(
          { sessionID: "ses_child" },
          { sessionID: "ses_parent", signal: controller.signal },
        ),
    ).rejects.toThrow("Aborted before the interrupt")
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("steer does not admit after the signal is aborted during permission evaluation", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    const controller = new AbortController()
    h.ctx.permission.assert = async () => {
      controller.abort()
    }

    await expect(
      h.tools
        .get("steer")
        .execute(
          { sessionID: "ses_child", text: "go" },
          { sessionID: "ses_parent", signal: controller.signal },
        ),
    ).rejects.toThrow("Aborted before the message")
    expect(h.calls.prompt).toHaveLength(0)
  })

  test("permission denial blocks steer and context", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.ctx.permission.assert = async () => {
      throw new Error("denied")
    }

    let steerError: unknown
    try {
      await h.tools
        .get("steer")
        .execute({ sessionID: "ses_child", text: "go" }, { sessionID: "ses_parent" })
    } catch (caught) {
      steerError = caught
    }
    expect(String(steerError)).toContain("denied")

    let contextError: unknown
    try {
      await h.tools
        .get("context")
        .execute({ sessionID: "ses_child", text: "note" }, { sessionID: "ses_parent" })
    } catch (caught) {
      contextError = caught
    }
    expect(String(contextError)).toContain("denied")
    expect(h.calls.prompt).toHaveLength(0)
    expect(h.calls.synthetic).toHaveLength(0)
  })
})
