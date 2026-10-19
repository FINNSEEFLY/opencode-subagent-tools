import { describe, expect, test } from "bun:test"
import { summarizeCancelDescendants } from "../src/tools/cancel-descendants"
import { makeHarness, createChild, sessionInfo, cursorOf, cleanups } from "./harness"
describe("cancel_descendants", () => {
  test("interrupts running descendants but leaves finished ones alone", async () => {
    const h = makeHarness()
    createChild(h, "ses_run", "ses_parent")
    createChild(h, "ses_done", "ses_parent")
    h.sessions.set(
      "ses_done",
      sessionInfo("ses_done", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(h.calls.interrupt).toEqual([{ sessionID: "ses_run", resume: false }])
    expect(result.content).toContain("Interrupt accepted for 1 of 1 target(s)")
    expect(result.output.known).toBe(2)
    expect(result.output.considered).toBe(2)
    expect(result.output.running).toBe(1)
    expect(result.output.targets).toHaveLength(1)
    expect(result.output.remaining).toBe(0)
  })

  test("includes the reason in structured output", async () => {
    const h = makeHarness()
    createChild(h, "ses_run", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ reason: "batch cleanup", format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.reason).toBe("batch cleanup")
  })

  test("includes the reason when there is nothing to stop", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ reason: "nothing here", format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.reason).toBe("nothing here")
    expect(result.content).toContain("(nothing here)")
  })

  test("reports running children before the cursor window", async () => {
    const h = makeHarness({ options: { limits: { maxCancelBatch: 2 } } })
    createChild(h, "ses_1", "ses_parent")
    createChild(h, "ses_2", "ses_parent")
    createChild(h, "ses_3", "ses_parent")
    cleanups.push(await h.setup())

    const first = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    const cursor = first.output.cursor
    expect(cursor).toBeDefined()

    createChild(h, "ses_4", "ses_parent")
    const second = await h.tools
      .get("cancel_descendants")
      .execute({ cursor, format: "json" }, { sessionID: "ses_parent" })
    expect(second.output.beforeCursorRunning).toBe(1)
    expect(second.content).toContain("before this cursor window")
  })

  test("reaches grandchildren", async () => {
    const h = makeHarness()
    createChild(h, "ses_mid", "ses_parent")
    createChild(h, "ses_leaf", "ses_mid")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(h.calls.interrupt.map((call) => call.sessionID).toSorted()).toEqual([
      "ses_leaf",
      "ses_mid",
    ])
    expect(result.content).toContain("Interrupt accepted for 2 of 2 target(s)")
    expect(result.output.targets).toHaveLength(2)
  })

  test("stops at the batch limit and returns a cursor", async () => {
    const h = makeHarness()
    for (let i = 0; i < 25; i++) createChild(h, `ses_${i}`, "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(h.calls.interrupt).toHaveLength(20)
    expect(result.content).toContain(
      "Interrupt accepted for 20 of 20 target(s): 20 terminal",
    )
    expect(result.content).toContain("5 running subagent(s) left")
    expect(result.output.targets).toHaveLength(20)
    expect(result.output.remaining).toBe(5)
    expect(cursorOf(result)).toBeDefined()
  })

  test("continues with a cursor", async () => {
    const h = makeHarness()
    for (let i = 0; i < 25; i++) createChild(h, `ses_${i}`, "ses_parent")
    cleanups.push(await h.setup())

    let result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(h.calls.interrupt).toHaveLength(20)
    const cursor = cursorOf(result)
    expect(cursor).toBeDefined()

    result = await h.tools
      .get("cancel_descendants")
      .execute({ cursor, format: "json" }, { sessionID: "ses_parent" })
    expect(h.calls.interrupt).toHaveLength(25)
    expect(result.content).toContain("Interrupt accepted for 5 of 5 target(s)")
    expect(result.output.remaining).toBe(0)
  })

  test("a cursor continues through finished rows", async () => {
    const h = makeHarness({ options: { limits: { maxCancelBatch: 1 } } })
    for (let i = 1; i <= 6; i++) {
      h.addSession(`ses_${i}`, "ses_parent", {
        time: { created: i, updated: i },
        ...(i <= 2
          ? {}
          : { outcome: "interrupted", time: { created: i, updated: i, idle: i } }),
      })
    }
    cleanups.push(await h.setup())

    let result = await h.tools
      .get("cancel_descendants")
      .execute({}, { sessionID: "ses_parent" })
    expect(result.content).toContain("Interrupt accepted for 1 of 1 target(s)")
    expect(h.calls.interrupt.map((call) => call.sessionID)).toEqual(["ses_2"])
    const cursor = cursorOf(result)
    expect(cursor).toBeDefined()

    result = await h.tools
      .get("cancel_descendants")
      .execute({ cursor }, { sessionID: "ses_parent" })
    expect(result.content).toContain("Interrupt accepted for 1 of 1 target(s)")
    expect(h.calls.interrupt.map((call) => call.sessionID)).toEqual(["ses_2", "ses_1"])
  })

  test("a cursor continues after the last target while the set changes", async () => {
    const h = makeHarness({ options: { limits: { maxCancelBatch: 2 } } })
    for (const [id, created] of [
      ["ses_a", 4],
      ["ses_b", 3],
      ["ses_c", 2],
      ["ses_d", 1],
    ] as const) {
      h.addSession(id, "ses_parent", { time: { created, updated: created } })
    }
    cleanups.push(await h.setup())

    const first = await h.tools
      .get("cancel_descendants")
      .execute({}, { sessionID: "ses_parent" })
    expect(first.content).toContain("Interrupt accepted for 2 of 2 target(s)")
    const cursor = cursorOf(first)
    expect(cursor).toBeDefined()

    h.addSession("ses_e", "ses_parent", { time: { created: 99, updated: 99 } })
    const second = await h.tools
      .get("cancel_descendants")
      .execute({ cursor }, { sessionID: "ses_parent" })
    expect(second.content).toContain("Interrupt accepted for 2 of 2 target(s)")
    expect(h.calls.interrupt.map((call) => call.sessionID)).toEqual([
      "ses_a",
      "ses_b",
      "ses_c",
      "ses_d",
    ])
  })

  test("rejects an invalid cursor", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("cancel_descendants")
        .execute({ cursor: "not-a-cursor" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Invalid cursor")
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("explains when there is nothing known or nothing running", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    let result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.content).toContain("no subagents discovered")
    expect(result.output.known).toBe(0)
    expect(result.output.considered).toBe(0)
    expect(result.output.running).toBe(0)
    expect(result.output.targets).toEqual([])
    expect(result.output.remaining).toBe(0)

    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    )
    result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.content).toContain("No running subagents among 1 known")
    expect(result.output.known).toBe(1)
    expect(result.output.considered).toBe(1)
    expect(result.output.running).toBe(0)
    expect(result.output.targets).toEqual([])
    expect(result.output.remaining).toBe(0)
  })

  test("reports interrupt failures and still-running targets", async () => {
    const h = makeHarness()
    createChild(h, "ses_run", "ses_parent")
    createChild(h, "ses_bad", "ses_parent")
    cleanups.push(await h.setup())
    h.ctx.session.interrupt = async ({ sessionID }: { sessionID: string }) => {
      h.calls.interrupt.push({ sessionID, resume: false })
      if (sessionID === "ses_bad") throw new Error("nope")
      return { interrupted: true }
    }

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.content).toContain("Interrupt accepted for 1 of 2 target(s)")
    expect(result.content).toContain("1 interrupt failed, 1 still running")
    expect(result.content).toContain("ses_bad (interrupt failed: nope)")
    expect(result.content).toContain("ses_run (still running)")
    expect(result.output.targets).toHaveLength(2)
    expect(
      result.output.targets.find((target: any) => target.sessionID === "ses_bad")
        ?.interrupt,
    ).toBe("failed")
    expect(
      result.output.targets.find((target: any) => target.sessionID === "ses_run")?.status,
    ).toBe("running")
    expect(result.output.remaining).toBe(0)
  })

  test("a failed child after the interrupt is terminal, not still running", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.ctx.session.interrupt = async ({ sessionID }: { sessionID: string }) => {
      h.calls.interrupt.push({ sessionID, resume: false })
      h.sessions.set(
        sessionID,
        sessionInfo(sessionID, "ses_parent", {
          outcome: "failed",
          time: { created: 1, updated: 2, idle: 2 },
        }),
      )
      return { interrupted: true }
    }

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.content).toContain(
      "Interrupt accepted for 1 of 1 target(s): 1 terminal",
    )
    expect(result.content).not.toContain("still running")
    expect(result.output.targets).toHaveLength(1)
    expect(result.output.targets[0].status).toBe("failed")
    expect(result.output.targets[0].readBack).toBe("ok")
  })

  test("reports a read-back failure honestly", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.ctx.session.get = async () => {
      throw new Error("gone")
    }

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.content).toContain(
      "Interrupt accepted for 1 of 1 target(s): 1 read-back failed",
    )
    expect(result.content).toContain("ses_child (read-back failed)")
    expect(result.output.targets).toHaveLength(1)
    expect(result.output.targets[0].interrupt).toBe("accepted")
    expect(result.output.targets[0].readBack).toBe("failed")
    expect(result.output.targets[0].error).toBe("read-back failed")
  })

  test("aborts before any interrupt when permission aborts the signal", async () => {
    const h = makeHarness()
    createChild(h, "ses_a", "ses_parent")
    createChild(h, "ses_b", "ses_parent")
    cleanups.push(await h.setup())
    const controller = new AbortController()
    h.ctx.permission.assert = async () => {
      controller.abort()
    }

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent", signal: controller.signal })
    expect(h.calls.interrupt).toHaveLength(0)
    expect(result.content).toContain("Aborted before any interrupt was requested")
    expect(result.output.aborted).toBe(true)
    expect(result.output.targets).toEqual([])
    expect(result.output.running).toBe(2)
    expect(result.output.remaining).toBe(2)
    expect(result.output.cursor).toBeUndefined()
  })

  test("uses a read-back that completed before the abort", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    const controller = new AbortController()
    h.ctx.session.interrupt = async ({ sessionID }: { sessionID: string }) => {
      h.calls.interrupt.push({ sessionID, resume: false })
      return { interrupted: true }
    }
    h.ctx.session.get = async ({ sessionID }: { sessionID: string }) => {
      controller.abort()
      return h.sessions.get(sessionID)
    }

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent", signal: controller.signal })
    expect(result.output.aborted).toBe(false)
    expect(result.output.targets).toHaveLength(1)
    expect(result.output.targets[0].interrupt).toBe("accepted")
    expect(result.output.targets[0].readBack).toBe("ok")
    expect(result.output.targets[0].status).toBeDefined()
    expect(result.content).not.toContain("Aborted before the batch completed")
  })

  test("stops after a successful read-back when the abort arrives with targets left", async () => {
    const h = makeHarness()
    createChild(h, "ses_1", "ses_parent")
    createChild(h, "ses_2", "ses_parent")
    cleanups.push(await h.setup())
    const controller = new AbortController()
    let reads = 0
    h.ctx.session.interrupt = async ({ sessionID }: { sessionID: string }) => {
      h.calls.interrupt.push({ sessionID, resume: false })
      return { interrupted: true }
    }
    h.ctx.session.get = async ({ sessionID }: { sessionID: string }) => {
      reads++
      if (reads === 1) controller.abort()
      return h.sessions.get(sessionID)
    }

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent", signal: controller.signal })
    expect(result.output.aborted).toBe(true)
    expect(result.output.targets).toHaveLength(1)
    expect(result.output.targets[0].readBack).toBe("ok")
    expect(result.output.remaining).toBe(1)
    expect(result.output.cursor).toBeDefined()
    expect(result.content).toContain("Aborted before the batch completed")
  })

  test("marks an abort during a failed read-back as not-read", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    const controller = new AbortController()
    h.ctx.session.interrupt = async ({ sessionID }: { sessionID: string }) => {
      h.calls.interrupt.push({ sessionID, resume: false })
      return { interrupted: true }
    }
    h.ctx.session.get = async () => {
      controller.abort()
      throw new Error("aborted")
    }

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent", signal: controller.signal })
    expect(result.output.aborted).toBe(true)
    expect(result.output.targets).toHaveLength(1)
    expect(result.output.targets[0].interrupt).toBe("accepted")
    expect(result.output.targets[0].readBack).toBe("not-read")
    expect(result.output.targets[0].error).toContain("aborted during read-back")
    expect(result.content).toContain("1 read-back not completed")
    expect(result.content).toContain("ses_child (read-back not completed)")
    expect(result.content).toContain("Aborted before the batch completed")
  })

  test("marks an abort after the interrupt as not-read", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    const controller = new AbortController()
    h.ctx.session.interrupt = async ({ sessionID }: { sessionID: string }) => {
      h.calls.interrupt.push({ sessionID, resume: false })
      controller.abort()
      return { interrupted: true }
    }

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent", signal: controller.signal })
    expect(result.output.aborted).toBe(true)
    expect(result.output.targets).toHaveLength(1)
    expect(result.output.targets[0].interrupt).toBe("accepted")
    expect(result.output.targets[0].readBack).toBe("not-read")
    expect(result.output.targets[0].error).toContain("aborted before read-back")
    expect(result.content).toContain("read-back not completed")
    expect(result.content).toContain("Aborted before the batch completed")
  })

  test("does not claim success for a malformed interrupt response", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.ctx.session.interrupt = async () => undefined

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.targets).toHaveLength(1)
    expect(result.output.targets[0].interrupt).toBe("unknown")
    expect(result.output.targets[0].readBack).toBe("ok")
    expect(result.output.targets[0].status).toBe("running")
    expect(result.content).toContain("1 interrupt outcome unknown")
  })

  test("marks an interrupt aborted mid-flight as unknown", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    const controller = new AbortController()
    h.ctx.session.interrupt = async ({ sessionID }: { sessionID: string }) => {
      h.calls.interrupt.push({ sessionID, resume: false })
      controller.abort()
      throw new Error("aborted")
    }

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent", signal: controller.signal })
    expect(result.output.aborted).toBe(true)
    expect(result.output.targets).toHaveLength(1)
    expect(result.output.targets[0].interrupt).toBe("unknown")
    expect(result.output.targets[0].readBack).toBe("not-read")
    expect(result.output.targets[0].error).toContain("aborted during interrupt")
    expect(result.output.remaining).toBe(0)
    expect(result.content).toContain("1 interrupt outcome unknown")
    expect(result.content).toContain("Aborted before the batch completed")
  })

  test("records a rejected interrupt separately from a failure", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.ctx.session.interrupt = async ({ sessionID }: { sessionID: string }) => {
      h.calls.interrupt.push({ sessionID, resume: false })
      const current = h.sessions.get(sessionID)
      h.sessions.set(sessionID, {
        ...current,
        outcome: "succeeded",
        time: { ...current.time, idle: current.time.updated },
      })
      return { interrupted: false }
    }

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.targets[0].interrupt).toBe("rejected")
    expect(result.output.targets[0].readBack).toBe("ok")
    expect(result.output.targets[0].status).toBe("finished")
    expect(result.content).toContain("1 interrupt rejected")
  })

  test("reports batch invariants", async () => {
    const h = makeHarness()
    for (let i = 0; i < 25; i++) createChild(h, `ses_${i}`, "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.targets.length).toBeLessThanOrEqual(result.output.running)
    expect(result.output.remaining).toBe(
      result.output.running - result.output.targets.length,
    )
    expect(result.output.cursor).toBeDefined()
  })

  test("checks the whole batch in one permission call", async () => {
    const h = makeHarness()
    createChild(h, "ses_one", "ses_parent")
    createChild(h, "ses_two", "ses_parent")
    cleanups.push(await h.setup())

    await h.tools.get("cancel_descendants").execute({}, { sessionID: "ses_parent" })
    expect(h.calls.permission).toHaveLength(1)
    expect(h.calls.permission[0].resources.toSorted()).toEqual(["ses_one", "ses_two"])
    expect(h.calls.permission[0].metadata.count).toBe(2)
  })

  test("a permission denial blocks the whole batch", async () => {
    const h = makeHarness()
    createChild(h, "ses_one", "ses_parent")
    createChild(h, "ses_two", "ses_parent")
    cleanups.push(await h.setup())
    h.ctx.permission.assert = async () => {
      throw new Error("batch denied")
    }

    let error: unknown
    try {
      await h.tools.get("cancel_descendants").execute({}, { sessionID: "ses_parent" })
    } catch (caught) {
      error = caught
    }
    expect(String(error)).toContain("batch denied")
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("sessionControlPolicy does not widen cancel_descendants", async () => {
    const h = makeHarness({ options: { sessionControlPolicy: "all" } })
    createChild(h, "ses_other", "ses_other_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({}, { sessionID: "ses_parent" })
    expect(result.content).toContain("no subagents discovered")
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("refuses cancel_descendants without a caller", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(h.tools.get("cancel_descendants").execute({}, {})).rejects.toThrow(
      "calling session is unknown",
    )
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("warns when discovery is incomplete", async () => {
    const h = makeHarness({ options: { limits: { maxDiscoveryNodes: 2 } } })
    for (let i = 0; i < 5; i++) createChild(h, `ses_${i}`, "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({}, { sessionID: "ses_parent" })
    expect(result.content).toContain("discovery was incomplete")
    expect(h.calls.interrupt).toHaveLength(2)
  })

  test("names future interrupt and read-back outcomes instead of dropping them", () => {
    const text = summarizeCancelDescendants(
      [
        {
          sessionID: "ses_x",
          interrupt: "timeout" as never,
          readBack: "ok",
          status: "running",
        },
        {
          sessionID: "ses_y",
          interrupt: "accepted",
          readBack: "timeout" as never,
          status: "running",
        },
      ],
      0,
    )
    expect(text).toContain("1 interrupt timeout")
    expect(text).toContain("1 read-back timeout")
    expect(text).toContain("ses_x (still running)")
    expect(text).toContain("ses_y (still running)")
  })
})
