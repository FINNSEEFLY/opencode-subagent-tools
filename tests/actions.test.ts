import { describe, expect, test } from "bun:test"
import { makeHarness, createChild, sessionInfo, cleanups } from "./harness"
describe("action structured output", () => {
  test("cancel returns structured output when requested", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel")
      .execute(
        { sessionID: "ses_child", reason: "stop", format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.sessionID).toBe("ses_child")
    expect(result.output.accepted).toBe(true)
    expect(result.output.interrupt).toBe("accepted")
    expect(result.output.status).toBe("stopped")
    expect(result.output.reason).toBe("stop")
    expect(result.output.readBackMayLag).toBe(false)
    expect(result.output.cancellationDoesNotCascade).toBe(true)
    expect(typeof result.content).toBe("string")
  })

  test("cancel reports a rejected interrupt in structured output", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    )
    cleanups.push(await h.setup())
    h.ctx.session.interrupt = async () => ({ interrupted: false })

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.interrupt).toBe("rejected")
    expect(result.output.accepted).toBe(false)
    expect(result.output.status).toBe("finished")
  })

  test("cancel defaults to text output", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(typeof result.output).toBe("string")
  })

  test("cancel_descendants returns structured output when requested", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ reason: "batch", format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.known).toBe(1)
    expect(result.output.considered).toBe(1)
    expect(result.output.running).toBe(1)
    expect(result.output.targets).toEqual([
      {
        sessionID: "ses_child",
        interrupt: "accepted",
        readBack: "ok",
        status: "stopped",
      },
    ])
    expect(result.output.remaining).toBe(0)
    expect(result.output.aborted).toBe(false)
  })

  test("cancel_descendants defaults to json output", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({}, { sessionID: "ses_parent" })
    expect(result.output.known).toBe(1)
    expect(result.output.targets).toHaveLength(1)
  })

  test("cancel_descendants returns text when requested", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "text" }, { sessionID: "ses_parent" })
    expect(typeof result.output).toBe("string")
  })

  test("steer returns structured output when requested", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("steer")
      .execute(
        { sessionID: "ses_child", text: "go", format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.sessionID).toBe("ses_child")
    expect(result.output.delivery).toBe("steer")
    expect(result.output.chars).toBe(2)
    expect(result.output.messageID).toBe("inbox_user")
  })

  test("context returns structured output with pending state", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("context")
      .execute(
        { sessionID: "ses_child", text: "note", description: "state", format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.delivery).toBe("next-step")
    expect(result.output.chars).toBe(4)
    expect(result.output.description).toBe("state")
    expect(result.output.status).toBe("finished")
    expect(result.output.pending).toBe(true)
    expect(result.output.messageID).toBe("inbox_synthetic")
  })

  test("an unknown status is not treated as idle for pending", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        time: { created: 1, updated: 1, busy: undefined },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("steer")
      .execute(
        { sessionID: "ses_child", text: "go", resume: false, format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.status).toBe("unknown")
    expect(result.output.pending).toBeUndefined()
  })

  test("an unknown status with resume true is not pending", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        time: { created: 1, updated: 1, busy: undefined },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("steer")
      .execute(
        { sessionID: "ses_child", text: "go", resume: true, format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.status).toBe("unknown")
    expect(result.output.pending).toBeUndefined()
  })

  test("a running status is not treated as idle for pending", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("steer")
      .execute(
        { sessionID: "ses_child", text: "go", resume: false, format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.status).toBe("running")
    expect(result.output.pending).toBeUndefined()
  })

  test("a finished status with resume false is pending", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("steer")
      .execute(
        { sessionID: "ses_child", text: "go", resume: false, format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.status).toBe("finished")
    expect(result.output.pending).toBe(true)
  })

  test("allowedOutputFormats text omits action output", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["text"] } })
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output).toBeUndefined()
    expect(h.tools.get("cancel").output).toBeUndefined()
  })
})
