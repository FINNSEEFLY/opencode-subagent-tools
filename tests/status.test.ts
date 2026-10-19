import { describe, expect, test } from "bun:test"
import {
  OUTCOME,
  OUTCOME_STATUS,
  STATUS,
  isOutcome,
  statusFromSession,
} from "../src/status"
import {
  makeHarness,
  ALL_STATUSES,
  createChild,
  startChild,
  sessionInfo,
  listOf,
  cleanups,
} from "./harness"
describe("status and freshness", () => {
  test("live started and idle events update status", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    startChild(h, "ses_child")
    await h.tick()

    let result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(result.content).toContain("running")

    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        time: { created: 1, updated: 3, idle: 3 },
      }),
    )
    h.emit({ type: "session.idle", data: { sessionID: "ses_child" } })
    await h.tick()
    result = await h.tools
      .get("list")
      .execute({ statuses: ["running"] }, { sessionID: "ses_parent" })
    expect(result.content).toContain("none match statuses")
  })

  test("a live idle event without time.idle stops reporting running", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    startChild(h, "ses_child")
    await h.tick()
    h.emit({ type: "session.idle", data: { sessionID: "ses_child" } })
    await h.tick()

    const result = await h.tools
      .get("list")
      .execute({ statuses: ["running"] }, { sessionID: "ses_parent" })
    expect(result.content).toContain("none match statuses")
  })

  test("discovery clears stale active after a lost terminal event", async () => {
    const h = makeHarness()
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
      created: 5,
    })
    await h.tick()

    const all = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(all, "ses_child")).toContain("finished")
  })

  test("a resumed child with a stale outcome stays running", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 10, idle: 10 },
      }),
    )
    cleanups.push(await h.setup())
    h.emit({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_child" },
      created: 4,
    })
    h.emit({
      type: "session.execution.started",
      data: { sessionID: "ses_child" },
      created: 20,
    })
    await h.tick()

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_child")).toContain("running")
  })

  test("title/view updates do not keep a finished child running", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 15, idle: 10 },
      }),
    )
    cleanups.push(await h.setup())
    h.emit({
      type: "session.execution.started",
      data: { sessionID: "ses_child" },
      created: 5,
    })
    await h.tick()

    const all = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(all, "ses_child")).toContain("finished")
    expect(listOf(all, "ses_child")).not.toContain("running")
  })

  test("ignores a late started event after a terminal event", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 20, idle: 20 },
      }),
    )
    cleanups.push(await h.setup())
    h.emit({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_child" },
      created: 20,
    })
    h.emit({
      type: "session.execution.started",
      data: { sessionID: "ses_child" },
      created: 10,
    })
    await h.tick()

    const all = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(all, "ses_child")).toContain("finished")
    expect(listOf(all, "ses_child")).not.toContain("running")
  })

  test("ignores a late terminal event after a newer start", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.emit({
      type: "session.execution.started",
      data: { sessionID: "ses_child" },
      created: 20,
    })
    h.emit({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_child" },
      created: 10,
    })
    await h.tick()

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_child")).toContain("running")
  })

  test("ignores a late idle event after a newer start", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.emit({
      type: "session.execution.started",
      data: { sessionID: "ses_child" },
      created: 20,
    })
    h.emit({ type: "session.idle", data: { sessionID: "ses_child" }, created: 10 })
    await h.tick()

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_child")).toContain("running")
  })

  test("a terminal event wins at the same timestamp", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())
    h.emit({
      type: "session.execution.started",
      data: { sessionID: "ses_child" },
      created: 20,
    })
    h.emit({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_child" },
      created: 20,
    })
    await h.tick()

    const all = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(all, "ses_child")).toContain("finished")
  })

  test("live failed, interrupted and deleted events update the row", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    h.emit({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
    await h.tick()
    let result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_child")).toContain("failed")

    h.emit({ type: "session.execution.interrupted", data: { sessionID: "ses_child" } })
    await h.tick()
    result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_child")).toContain("stopped")

    h.emit({ type: "session.deleted", data: { sessionID: "ses_child" } })
    h.sessions.delete("ses_child")
    await h.tick()
    result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(result.content).toContain("No subagents discovered")
  })

  test("session lookup clears stale active without discovery events", async () => {
    const h = makeHarness()
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
      created: 5,
    })
    await h.tick()

    const all = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(all, "ses_child")).toContain("finished")
  })

  test("a never-run session is unknown, not running", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        time: { created: 1, updated: 1, busy: undefined },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.rows[0].status).toBe("unknown")
  })

  test("a resumed child with busy after idle is running without a live event", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 20, busy: 20, idle: 10 },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.rows[0].status).toBe("running")
  })

  test("a terminal outcome without time.idle stays terminal", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, busy: 1 },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.rows[0].status).toBe("finished")
  })

  test("a stale live start does not override a terminal outcome without idle", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 20, busy: 1 },
      }),
    )
    cleanups.push(await h.setup())
    h.emit({
      type: "session.execution.started",
      data: { sessionID: "ses_child" },
      created: 10,
    })
    await h.tick()

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.rows[0].status).toBe("finished")
  })

  test("live state evicts the least recently used session", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_old",
      sessionInfo("ses_old", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 10, idle: 10 },
      }),
    )
    cleanups.push(await h.setup())
    h.emit({
      type: "session.execution.failed",
      data: { sessionID: "ses_old" },
      created: 20,
    })
    for (let i = 0; i < 500; i++) {
      h.emit({
        type: "session.execution.started",
        data: { sessionID: `ses_${i}` },
        created: 20,
      })
    }
    await h.tick()

    const result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_old")).toContain("finished")
  })

  test("a stale live terminal status does not override newer session info", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "failed",
        time: { created: 1, updated: 10, idle: 10 },
      }),
    )
    cleanups.push(await h.setup())
    h.emit({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_child" },
      created: 5,
    })
    await h.tick()

    const all = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(all, "ses_child")).toContain("failed")
  })

  test("maps every known outcome and rejects unknown ones", () => {
    for (const outcome of Object.values(OUTCOME)) {
      expect(isOutcome(outcome)).toBe(true)
      expect(OUTCOME_STATUS[outcome]).toBeDefined()
    }
    expect(isOutcome("cancelled")).toBe(false)
  })

  test("an unknown outcome is reported as unknown, not guessed", () => {
    const status = statusFromSession({
      outcome: "cancelled",
      time: { created: 1, updated: 2 },
    })
    expect(status).toBe(STATUS.unknown)
  })

  test("a resumed run still wins over an unknown outcome", () => {
    const status = statusFromSession({
      outcome: "cancelled",
      time: { created: 1, updated: 20, busy: 20, idle: 10 },
    })
    expect(status).toBe(STATUS.running)
  })
})
