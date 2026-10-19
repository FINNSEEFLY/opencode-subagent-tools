import { describe, expect, test } from "bun:test"
import { makeHarness, createChild, startChild, sessionInfo, cleanups } from "./harness"
describe("ownership and mutations", () => {
  test("cancel interrupts a descendant and reports the reason", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "interrupted",
        time: { created: 1, updated: 3, idle: 3 },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel")
      .execute(
        { sessionID: "ses_child", reason: "wrong direction" },
        { sessionID: "ses_parent" },
      )
    expect(h.calls.interrupt).toEqual([{ sessionID: "ses_child", resume: false }])
    expect(result.content).toContain("Interrupt requested")
    expect(result.content).toContain("wrong direction")
  })

  test("cancel refuses an unknown target", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_foreign" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("could not be verified")
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("a sibling cannot control another session's child", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_other_parent")
    createChild(h, "ses_other_parent", "ses_root")
    h.sessions.set("ses_root", {
      id: "ses_root",
      agent: "general",
      title: "Root",
      time: { created: 1, updated: 2 },
    })
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_child" }, { sessionID: "ses_sibling" }),
    ).rejects.toThrow("not a descendant")
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("cancel verifies an unobserved descendant through the parent chain", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    createChild(h, "ses_grandchild", "ses_child")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_grandchild" }, { sessionID: "ses_parent" })
    expect(h.calls.interrupt).toEqual([{ sessionID: "ses_grandchild", resume: false }])
    expect(result.content).toContain("Interrupt requested")
  })

  test("a descendant beyond maxDiscoveryDepth is unverified, not foreign", async () => {
    const h = makeHarness({ options: { limits: { maxDiscoveryDepth: 2 } } })
    createChild(h, "ses_child", "ses_parent")
    createChild(h, "ses_grandchild", "ses_child")
    createChild(h, "ses_great", "ses_grandchild")
    cleanups.push(await h.setup())

    try {
      await h.tools
        .get("cancel")
        .execute({ sessionID: "ses_great" }, { sessionID: "ses_parent" })
      throw new Error("expected a refusal")
    } catch (error) {
      expect(String(error)).toContain("could not be verified")
      expect(String(error)).not.toContain("not a descendant")
    }
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("a session cannot control itself", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_parent" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("cannot control itself")
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("cancel reports an unknown outcome when aborted mid-interrupt", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    const controller = new AbortController()
    h.ctx.session.interrupt = async () => {
      controller.abort()
      throw new Error("aborted")
    }

    await expect(
      h.tools
        .get("cancel")
        .execute(
          { sessionID: "ses_child" },
          { sessionID: "ses_parent", signal: controller.signal },
        ),
    ).rejects.toThrow("may or may not have been accepted")
  })

  test("cancel reports an interrupt failure", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.ctx.session.interrupt = async () => {
      throw new Error("cannot interrupt")
    }

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Interrupt failed for ses_child")
  })

  test("cancel does not claim success for a malformed interrupt response", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.ctx.session.interrupt = async () => undefined

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.accepted).toBe(false)
    expect(result.output.interrupt).toBe("unknown")
    expect(result.content).toContain("Interrupt outcome unknown")
  })

  test("cancel reports read-back lag when the target still looks running", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    startChild(h, "ses_child")
    await h.tick()

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.status).toBe("running")
    expect(result.output.readBackMayLag).toBe(true)
  })

  test("cancel reports when the target was not running", async () => {
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
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.content).toContain("was not running")
    expect(result.content).toContain("finished")
  })

  test("mutations refuse an unknown calling session", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    await expect(
      h.tools.get("cancel").execute({ sessionID: "ses_child" }, {}),
    ).rejects.toThrow("calling session is unknown")
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("sessionControlPolicy all permits a foreign target but still requires a caller", async () => {
    const h = makeHarness({ options: { sessionControlPolicy: "all" } })
    createChild(h, "ses_foreign", "ses_other_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_foreign" }, { sessionID: "ses_parent" })
    expect(h.calls.interrupt).toEqual([{ sessionID: "ses_foreign", resume: false }])
    expect(result.content).toContain("Interrupt requested")

    await expect(
      h.tools.get("cancel").execute({ sessionID: "ses_foreign" }, {}),
    ).rejects.toThrow("calling session is unknown")
    expect(h.calls.interrupt).toHaveLength(1)
  })

  test("steer admits an instruction and warns for a finished child", async () => {
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
      .get("steer")
      .execute(
        { sessionID: "ses_child", text: "use the smaller fix", format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(h.calls.prompt).toEqual([
      {
        sessionID: "ses_child",
        text: "use the smaller fix",
        delivery: "steer",
        resume: true,
      },
    ])
    expect(result.content).toContain("Steering message sent to")
    expect(result.output.status).toBe("finished")
    expect(result.output.resume).toBe(true)
  })

  test("reports the delivery and text admitted by the server", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.ctx.session.prompt = async () => ({
      id: "inbox_user",
      delivery: "queue",
      payload: { text: "rewritten" },
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("steer")
      .execute(
        { sessionID: "ses_child", text: "original", format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.delivery).toBe("queue")
    expect(result.output.chars).toBe(9)
    expect(result.content).toContain("Message queued for")
    expect(result.content).toContain("delivery=queue")
    expect(result.content).toContain("9 chars")
  })

  test("reports the text admitted for context", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.ctx.session.synthetic = async () => ({
      id: "inbox_synthetic",
      payload: { text: "rewritten" },
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("context")
      .execute(
        { sessionID: "ses_child", text: "original", format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.delivery).toBe("next-step")
    expect(result.output.chars).toBe(9)
    expect(result.content).toContain("9 chars")
  })

  test("steer can admit without waking an idle child", async () => {
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

    const result = await h.tools.get("steer").execute(
      {
        sessionID: "ses_child",
        text: "use the smaller fix",
        resume: false,
        format: "json",
      },
      { sessionID: "ses_parent" },
    )
    expect(h.calls.prompt).toEqual([
      {
        sessionID: "ses_child",
        text: "use the smaller fix",
        delivery: "steer",
        resume: false,
      },
    ])
    expect(result.output.resume).toBe(false)
    expect(result.output.pending).toBe(true)
  })

  test("queue admits a follow-up turn with delivery queue", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("queue")
      .execute(
        { sessionID: "ses_child", text: "run the benchmark next", format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(h.calls.prompt).toEqual([
      {
        sessionID: "ses_child",
        text: "run the benchmark next",
        delivery: "queue",
        resume: true,
      },
    ])
    expect(result.content).toContain("Message queued for")
    expect(result.output.delivery).toBe("queue")
    expect(result.output.resume).toBe(true)
  })

  test("queue can admit without waking an idle child", async () => {
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

    const result = await h.tools.get("queue").execute(
      {
        sessionID: "ses_child",
        text: "run the benchmark next",
        resume: false,
        format: "json",
      },
      { sessionID: "ses_parent" },
    )
    expect(h.calls.prompt).toEqual([
      {
        sessionID: "ses_child",
        text: "run the benchmark next",
        delivery: "queue",
        resume: false,
      },
    ])
    expect(result.output.pending).toBe(true)
  })

  test("queue reports the observed status for a finished child", async () => {
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
      .get("queue")
      .execute(
        { sessionID: "ses_child", text: "run the benchmark next", format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.delivery).toBe("queue")
    expect(result.output.status).toBe("finished")
    expect(result.output.resume).toBe(true)
  })

  test("non-boolean resume values do not wake an idle child", async () => {
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

    const result = await h.tools.get("steer").execute(
      {
        sessionID: "ses_child",
        text: "stay idle",
        resume: "false",
        format: "json",
      },
      { sessionID: "ses_parent" },
    )
    expect(h.calls.prompt[0].resume).toBe(false)
    expect(result.output.resume).toBe(false)
  })

  test("send tools count chars by Unicode code point", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("steer")
      .execute(
        { sessionID: "ses_child", text: "🙂🙂", format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.chars).toBe(2)
    expect(result.content).toContain("2 chars")
  })

  test("context injects a synthetic message", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("context")
      .execute(
        { sessionID: "ses_child", text: "migration applied", description: "state" },
        { sessionID: "ses_parent" },
      )
    expect(h.calls.synthetic).toEqual([
      {
        sessionID: "ses_child",
        text: "migration applied",
        description: "state",
        resume: false,
      },
    ])
    expect(result.content).toContain("Context injected")
  })

  test("reports steer and context failures", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.ctx.session.prompt = async () => {
      throw new Error("child is gone")
    }
    h.ctx.session.synthetic = async () => {
      throw new Error("inbox closed")
    }

    await expect(
      h.tools
        .get("steer")
        .execute({ sessionID: "ses_child", text: "hello" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Steer failed for ses_child")

    await expect(
      h.tools
        .get("context")
        .execute({ sessionID: "ses_child", text: "note" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Context injection failed")
  })

  test("tools validate required input and reject over-long text with a short error", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    await expect(
      h.tools.get("cancel").execute({}, { sessionID: "ses_parent" }),
    ).rejects.toThrow("sessionID is required")
    await expect(
      h.tools
        .get("steer")
        .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("text is required")

    const longText = "x".repeat(16001)
    await expect(
      h.tools
        .get("steer")
        .execute({ sessionID: "ses_child", text: longText }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("text is 16001 characters; maximum is 16000")
    expect(h.calls.prompt).toHaveLength(0)

    const reason = "r".repeat(600)
    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_child", reason }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("reason is 600 characters; maximum is 500")
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("context rejects over-long text without echoing the payload", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const longText = "secret-marker-" + "x".repeat(16000)
    await expect(
      h.tools
        .get("context")
        .execute({ sessionID: "ses_child", text: longText }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("text is 16014 characters; maximum is 16000")
    expect(h.calls.synthetic).toHaveLength(0)

    await expect(
      h.tools
        .get("context")
        .execute(
          { sessionID: "ses_child", text: "note", description: "d".repeat(201) },
          { sessionID: "ses_parent" },
        ),
    ).rejects.toThrow("description is 201 characters; maximum is 200")
    expect(h.calls.synthetic).toHaveLength(0)
  })

  test("trims model-provided text and rejects blank text", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("steer")
        .execute({ sessionID: "ses_child", text: "   " }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("text is required")

    await h.tools
      .get("steer")
      .execute({ sessionID: "ses_child", text: "  go  " }, { sessionID: "ses_parent" })
    expect(h.calls.prompt[0].text).toBe("go")
  })

  test("applies a custom maxTextLength to rejection", async () => {
    const h = makeHarness({ options: { limits: { maxTextLength: 5 } } })
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("steer")
        .execute(
          { sessionID: "ses_child", text: "abcdefgh" },
          { sessionID: "ses_parent" },
        ),
    ).rejects.toThrow("text is 8 characters; maximum is 5")
    expect(h.calls.prompt).toHaveLength(0)
  })
})
