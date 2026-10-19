import { describe, expect, test } from "bun:test"
import { encodeCursor } from "../src/cursor"
import { TOOL } from "../src/tools/names"
import {
  makeHarness,
  ALL_STATUSES,
  createChild,
  hasUndefined,
  sessionInfo,
  listOf,
  cursorOf,
  cleanups,
} from "./harness"
describe("list", () => {
  test("discovers a child through session.list and reports it as running", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent", "explore", "Review parser")
    cleanups.push(await h.setup())

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(result.content).toContain("ses_child")
    expect(result.content).toContain("running")
    expect(result.content).toContain("agent=explore")
    expect(result.content).toContain('title="Review parser"')
  })

  test("omits the pagination summary when everything fits on one page", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(result.content).toContain("ses_child")
    expect(result.content).not.toContain("remaining")
    expect(result.content).not.toContain("Use cursor")
  })

  test("includes all statuses by default and filters when requested", async () => {
    const h = makeHarness()
    createChild(h, "ses_running", "ses_parent")
    createChild(h, "ses_finished", "ses_parent")
    createChild(h, "ses_failed", "ses_parent")
    h.sessions.set(
      "ses_finished",
      sessionInfo("ses_finished", "ses_parent", { outcome: "succeeded" }),
    )
    h.sessions.set(
      "ses_failed",
      sessionInfo("ses_failed", "ses_parent", { outcome: "failed" }),
    )
    cleanups.push(await h.setup())

    let result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(result.content).toContain("ses_running")
    expect(result.content).toContain("ses_finished")
    expect(result.content).toContain("ses_failed")
    expect(result.output.statuses).toEqual([
      "running",
      "stopped",
      "failed",
      "finished",
      "unknown",
    ])

    result = await h.tools
      .get("list")
      .execute({ statuses: ["finished", "failed"] }, { sessionID: "ses_parent" })
    expect(result.content).toContain("ses_finished")
    expect(result.content).toContain("ses_failed")
    expect(result.content).not.toContain("ses_running")
  })

  test("pages with limit and cursor", async () => {
    const h = makeHarness()
    for (let i = 0; i < 5; i++) createChild(h, `ses_${i}`, "ses_parent")
    cleanups.push(await h.setup())

    let result = await h.tools
      .get("list")
      .execute({ limit: 2 }, { sessionID: "ses_parent" })
    let rows = result.content
      .split("\n")
      .filter((line: string) => line.startsWith("ses_"))
    expect(rows).toHaveLength(2)
    expect(result.content).toContain(
      "Showing 2 of 5 matches (limit 2); 2 pages remaining",
    )
    expect(result.output.known).toBe(5)
    expect(result.output.matching).toBe(5)
    expect(result.output.window).toBe(5)
    expect(result.output.remaining).toBe(3)
    expect(result.output.remainingPages).toBe(2)
    expect(result.output.counts.running).toBe(5)
    let cursor = cursorOf(result)
    expect(cursor).toBeDefined()

    result = await h.tools
      .get("list")
      .execute({ limit: 2, cursor }, { sessionID: "ses_parent" })
    rows = result.content.split("\n").filter((line: string) => line.startsWith("ses_"))
    expect(rows).toHaveLength(2)
    expect(listOf(result, "ses_2")).toBeDefined()
    expect(listOf(result, "ses_1")).toBeDefined()
    expect(result.content).toContain(
      "Showing 2 of 3 in this cursor window (5 matching total); 1 page remaining",
    )
    expect(result.output.known).toBe(5)
    expect(result.output.matching).toBe(5)
    expect(result.output.window).toBe(3)
    expect(result.output.remaining).toBe(1)
    expect(result.output.remainingPages).toBe(1)
    expect(result.output.counts.running).toBe(5)
    cursor = cursorOf(result)
    expect(cursor).toBeDefined()

    result = await h.tools
      .get("list")
      .execute({ limit: 2, cursor }, { sessionID: "ses_parent" })
    rows = result.content.split("\n").filter((line: string) => line.startsWith("ses_"))
    expect(rows).toHaveLength(1)
    expect(listOf(result, "ses_0")).toBeDefined()
    expect(result.content).not.toContain("Use cursor")
    expect(result.content).toContain("last page")
    expect(result.output.known).toBe(5)
    expect(result.output.matching).toBe(5)
    expect(result.output.window).toBe(1)
    expect(result.output.remaining).toBe(0)
    expect(result.output.remainingPages).toBe(0)
  })

  test("pages with a stable cursor when new rows appear", async () => {
    const h = makeHarness()
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
      .get("list")
      .execute({ limit: 2 }, { sessionID: "ses_parent" })
    expect(listOf(first, "ses_a")).toBeDefined()
    expect(listOf(first, "ses_b")).toBeDefined()
    expect(first.output.known).toBe(4)
    expect(first.output.matching).toBe(4)
    expect(first.output.window).toBe(4)
    expect(first.output.remaining).toBe(2)
    expect(first.output.remainingPages).toBe(1)
    const cursor = cursorOf(first)
    expect(cursor).toBeDefined()

    h.addSession("ses_e", "ses_parent", { time: { created: 99, updated: 99 } })
    const second = await h.tools
      .get("list")
      .execute({ limit: 2, cursor }, { sessionID: "ses_parent" })
    expect(listOf(second, "ses_c")).toBeDefined()
    expect(listOf(second, "ses_d")).toBeDefined()
    expect(listOf(second, "ses_a")).toBeUndefined()
    expect(listOf(second, "ses_e")).toBeUndefined()
    // Current discovery sees the new child; the cursor window does not.
    expect(second.output.known).toBe(5)
    expect(second.output.matching).toBe(5)
    expect(second.output.window).toBe(2)
    expect(second.output.remaining).toBe(0)
    expect(second.output.remainingPages).toBe(0)
    expect(second.content).toContain(
      "Showing 2 of 2 in this cursor window (5 matching total); last page",
    )
    expect(second.content).toContain("3 matching row(s) are before this cursor window")
  })

  test("rejects an invalid cursor", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("list")
        .execute({ cursor: "not-a-cursor" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Invalid cursor")
  })

  test("rejects unknown statuses", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("list")
        .execute({ statuses: ["running", "bogus"] }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Unknown status")
  })

  test("binds a cursor to its tool, root, and status filter", async () => {
    const h = makeHarness()
    for (let i = 0; i < 3; i++) createChild(h, `ses_${i}`, "ses_parent")
    h.addSession("ses_other_parent", "ses_root")
    cleanups.push(await h.setup())

    const first = await h.tools
      .get("list")
      .execute({ limit: 1 }, { sessionID: "ses_parent" })
    const cursor = cursorOf(first)
    expect(cursor).toBeDefined()

    await expect(
      h.tools
        .get("list")
        .execute(
          { limit: 1, cursor, statuses: ["running"] },
          { sessionID: "ses_parent" },
        ),
    ).rejects.toThrow("Invalid cursor")

    await expect(
      h.tools
        .get("list")
        .execute(
          { limit: 1, cursor, parentID: "ses_other_parent" },
          { sessionID: "ses_parent" },
        ),
    ).rejects.toThrow("Invalid cursor")

    await expect(
      h.tools.get("cancel_descendants").execute({ cursor }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Invalid cursor")
  })

  // This regression builds a cursor directly; the rest of the suite exercises
  // the plugin through setup/tool calls.
  test("reports a cursor past the end", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const cursor = encodeCursor(
      { launchedAt: 0, id: "ses_zzz" },
      {
        tool: TOOL.list,
        root: "ses_parent",
        filter: [...ALL_STATUSES].toSorted().join(","),
      },
    )
    const result = await h.tools
      .get("list")
      .execute({ cursor }, { sessionID: "ses_parent" })
    expect(result.content).toContain("Cursor is past the end")
    expect(result.output.known).toBe(1)
    expect(result.output.matching).toBe(1)
    expect(result.output.window).toBe(0)
    expect(result.output.remaining).toBe(0)
    expect(result.output.remainingPages).toBe(0)
  })

  test("caps the list and notes truncation", async () => {
    const h = makeHarness()
    for (let i = 0; i < 45; i++) createChild(h, `ses_${i}`, "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    const rows = result.content
      .split("\n")
      .filter((line: string) => line.startsWith("ses_"))
    expect(rows).toHaveLength(20)
    expect(result.content).toContain(
      "Showing 20 of 45 matches (limit 20); 2 pages remaining",
    )
    expect(result.content).toContain("Use cursor")
  })

  test("uses maxListRows as the default page size", async () => {
    const h = makeHarness({ options: { limits: { maxListRows: 2 } } })
    for (let i = 0; i < 5; i++) createChild(h, `ses_${i}`, "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    const rows = result.content
      .split("\n")
      .filter((line: string) => line.startsWith("ses_"))
    expect(rows).toHaveLength(2)
    expect(result.content).toContain(
      "Showing 2 of 5 matches (limit 2); 2 pages remaining",
    )
  })

  test("declares the limit bounds in the input schema", async () => {
    const h = makeHarness({ options: { limits: { maxListRows: 2 } } })
    cleanups.push(await h.setup())

    const limit = h.tools.get("list").input.properties.limit
    expect(limit.minimum).toBe(1)
    expect(limit.maximum).toBe(2)
  })

  test("scopes a named parent to its subtree", async () => {
    const h = makeHarness()
    createChild(h, "ses_mid", "ses_parent", "mid")
    createChild(h, "ses_leaf", "ses_mid", "leaf")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ parentID: "ses_mid" }, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_leaf")).toBeDefined()
    expect(listOf(result, "ses_mid")).toBeUndefined()
    expect(result.content).toContain("agent=leaf")
    expect(result.content).not.toContain("agent=mid")
  })

  test("allows a foreign parent for read-only list", async () => {
    const h = makeHarness()
    createChild(h, "ses_other", "ses_other_parent")
    createChild(h, "ses_foreign_child", "ses_other")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ parentID: "ses_other" }, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_foreign_child")).toBeDefined()
  })

  test("accepts any parent for read-only list and keeps no-parent list scoped", async () => {
    const h = makeHarness()
    h.addSession("ses_other_parent", "ses_root")
    createChild(h, "ses_other", "ses_other_parent")
    cleanups.push(await h.setup())

    const foreign = await h.tools
      .get("list")
      .execute({ parentID: "ses_other_parent" }, { sessionID: "ses_parent" })
    expect(listOf(foreign, "ses_other")).toBeDefined()

    const scoped = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(scoped.content).toContain("No subagents discovered for ses_parent")
  })

  test("reports when no children are discovered", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(result.content).toContain("No subagents discovered for ses_parent")
  })

  test("refuses list without a caller and parent", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(h.tools.get("list").execute({}, {})).rejects.toThrow(
      "calling session is unknown",
    )
  })

  test("orders rows by launch time", async () => {
    const h = makeHarness()
    h.addSession("ses_old", "ses_parent", { time: { created: 1, updated: 1 } })
    h.addSession("ses_new", "ses_parent", { time: { created: 2, updated: 2 } })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(result.content.indexOf("ses_new")).toBeLessThan(
      result.content.indexOf("ses_old"),
    )
  })

  test("shows stopped, failed and unknown states when requested", async () => {
    const h = makeHarness()
    createChild(h, "ses_stopped", "ses_parent")
    createChild(h, "ses_failed", "ses_parent")
    createChild(h, "ses_unknown", "ses_parent")
    h.sessions.set(
      "ses_stopped",
      sessionInfo("ses_stopped", "ses_parent", {
        outcome: "interrupted",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    )
    h.sessions.set(
      "ses_failed",
      sessionInfo("ses_failed", "ses_parent", {
        outcome: "failed",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    )
    h.sessions.set(
      "ses_unknown",
      sessionInfo("ses_unknown", "ses_parent", {
        time: { created: 1, updated: 2, idle: 2 },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_stopped")).toContain("stopped")
    expect(listOf(result, "ses_failed")).toContain("failed")
    expect(listOf(result, "ses_unknown")).toContain("unknown")
  })

  test("age does not round up into the next unit", async () => {
    const h = makeHarness()
    const now = Date.now()
    h.addSession("ses_sec", "ses_parent", {
      time: { created: now - 59_600, updated: now - 59_600 },
    })
    h.addSession("ses_min", "ses_parent", {
      time: { created: now - 3_599_000, updated: now - 3_599_000 },
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_sec")).toContain("age=59s")
    expect(listOf(result, "ses_min")).toContain("age=59m")
  })

  test("shows age as unknown when the session has no timestamps", async () => {
    const h = makeHarness()
    h.sessions.set("ses_no_time", {
      id: "ses_no_time",
      parentID: "ses_parent",
      agent: "general",
      title: "No time",
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_no_time")).toContain("age=?")
  })

  test("warns when discovery is truncated by maxDiscoveryNodes", async () => {
    const h = makeHarness({ options: { limits: { maxDiscoveryNodes: 2 } } })
    for (let i = 0; i < 5; i++) createChild(h, `ses_${i}`, "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    const rows = result.content
      .split("\n")
      .filter((line: string) => line.startsWith("ses_"))
    expect(rows).toHaveLength(2)
    expect(result.content).toContain("discovery was incomplete")
  })

  test("warns when discovery hits the page limit", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      sessionInfo(`ses_${String(index).padStart(3, "0")}`, "ses_parent"),
    )
    const h = makeHarness({
      options: { limits: { maxDiscoveryPages: 1 } },
      sessionList: async () => ({ data: firstPage, cursor: { next: "page_2" } }),
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(result.output.known).toBe(100)
    expect(result.output.discoveryComplete).toBe(false)
    expect(result.content).toContain("discovery was incomplete")
  })

  test("warns when discovery hits the depth limit", async () => {
    const mid = sessionInfo("ses_mid", "ses_parent")
    const leaf = sessionInfo("ses_leaf", "ses_mid")
    const h = makeHarness({
      options: { limits: { maxDiscoveryDepth: 1 } },
      sessionList: async ({ parentID }: any) =>
        parentID === "ses_parent" ? [mid] : parentID === "ses_mid" ? [leaf] : [],
    })
    h.sessions.set("ses_mid", mid)
    h.sessions.set("ses_leaf", leaf)
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(listOf(result, "ses_mid")).toBeDefined()
    expect(listOf(result, "ses_leaf")).toBeUndefined()
    expect(result.content).toContain("discovery was incomplete")
  })

  test("reports a failed discovery as incomplete", async () => {
    const h = makeHarness({
      sessionList: async () => {
        throw new Error("list broke")
      },
    })
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(result.content).toContain("No subagents discovered")
    expect(result.content).toContain("discovery was incomplete")
  })
})

describe("structured output", () => {
  test("list returns structured output by default", async () => {
    const h = makeHarness()
    createChild(h, "ses_running", "ses_parent")
    h.addSession("ses_done", "ses_parent", {
      outcome: "succeeded",
      time: { created: 2, updated: 2, idle: 2 },
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(result.output).toBeDefined()
    expect(result.output.root).toBe("ses_parent")
    expect(result.output.discoveryComplete).toBe(true)
    expect(result.output.known).toBe(2)
    expect(result.output.matching).toBe(2)
    expect(result.output.window).toBe(2)
    expect(result.output.remaining).toBe(0)
    expect(result.output.remainingPages).toBe(0)
    expect(result.output.counts.running).toBe(1)
    expect(result.output.counts.finished).toBe(1)
    expect(result.output.rows).toHaveLength(2)
    expect(h.tools.get("list").output).toBeDefined()
  })

  test("allowedOutputFormats text omits structured output", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["text"] } })
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(result.output).toBeUndefined()
    expect(h.tools.get("list").output).toBeUndefined()
    expect(h.tools.get("list").input.properties.format).toBeUndefined()
  })

  test("format text returns a string output", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "text" }, { sessionID: "ses_parent" })
    expect(typeof result.output).toBe("string")
    expect(result.output).toContain("ses_child")
  })

  test("structured output carries pagination cursor and window", async () => {
    const h = makeHarness()
    for (let i = 0; i < 3; i++) createChild(h, `ses_${i}`, "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ limit: 1 }, { sessionID: "ses_parent" })
    expect(result.output.matching).toBe(3)
    expect(result.output.window).toBe(3)
    expect(result.output.remaining).toBe(2)
    expect(result.output.remainingPages).toBe(2)
    expect(result.output.rows).toHaveLength(1)
    expect(result.output.cursor).toBeDefined()
  })

  test("omits ageSeconds when the session has no timestamps", async () => {
    const h = makeHarness()
    h.sessions.set("ses_no_time", {
      id: "ses_no_time",
      parentID: "ses_parent",
      agent: "general",
      title: "No time",
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ statuses: ALL_STATUSES }, { sessionID: "ses_parent" })
    expect(result.output.rows[0].ageSeconds).toBeUndefined()
  })

  test("structured output contains no undefined values", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(hasUndefined(result.output)).toBe(false)
    expect(() => JSON.stringify(result.output)).not.toThrow()
  })
})

describe("tool errors", () => {
  test("list invalid cursor throws a tool error", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("list")
        .execute({ cursor: "not-a-cursor" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Invalid cursor")
  })

  test("list invalid statuses throws a tool error", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools.get("list").execute({ statuses: ["bogus"] }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Unknown status")
  })

  test("list rejects a non-array statuses value", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools.get("list").execute({ statuses: "running" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("statuses must be an array of statuses; omit it to include all.")
  })

  test("list rejects an empty statuses array", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools.get("list").execute({ statuses: [] }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("at least one status")
  })

  test("list rejects a statuses array with no valid values", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools.get("list").execute({ statuses: [""] }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("at least one status")
  })

  test("list unknown parent throws a tool error", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools.get("list").execute({ parentID: "ses_other" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("could not be read")
  })

  test("usage unknown session throws a tool error", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("usage")
        .execute({ sessionID: "ses_unknown" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("could not be read")
  })

  test("escapes quotes and control characters in text rows", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent", "general", 'Line one\nLine two "quoted"')
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "text" }, { sessionID: "ses_parent" })
    expect(result.content).toContain('title="Line one Line two \\"quoted\\""')
    expect(
      result.content.split("\n").filter((line: string) => line.startsWith("ses_")),
    ).toHaveLength(1)
  })

  test("escapes C1 controls and Unicode line separators", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent", "general", "A\u0085B\u2028C\u2029D\u007fE")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "text" }, { sessionID: "ses_parent" })
    expect(result.content).toContain('title="A?B?C?D?E"')
    expect(result.content).not.toContain("\u0085")
    expect(result.content).not.toContain("\u2028")
    expect(result.content).not.toContain("\u2029")
    expect(result.content).not.toContain("\u007f")
  })

  test("ignores non-finite session timestamps", async () => {
    const h = makeHarness()
    h.addSession("ses_nan_time", "ses_parent", {
      time: { created: Number.NaN, updated: 5 },
    })
    h.addSession("ses_inf_time", "ses_parent", {
      time: { created: Number.POSITIVE_INFINITY, updated: 7 },
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    const nanRow = result.output.rows.find((row: any) => row.id === "ses_nan_time")
    const infRow = result.output.rows.find((row: any) => row.id === "ses_inf_time")
    expect(nanRow?.launchedAt).toBe(5)
    expect(infRow?.launchedAt).toBe(7)
  })

  test("marks long titles as truncated in structured output", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent", "general", "x".repeat(250))
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.rows[0].title).toHaveLength(200)
    expect(result.output.rows[0].titleTruncated).toBe(true)
  })

  test("rejects malformed and overlong session IDs instead of truncating them", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_bad id" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("sessionID is invalid")
    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: `ses_${"a".repeat(80)}` }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("sessionID is invalid")
    await expect(
      h.tools
        .get("list")
        .execute({ parentID: `ses_${"a".repeat(80)}` }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("parentID is invalid")
  })

  test("cancel self throws a tool error in both formats", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    for (const format of ["json", "text"] as const) {
      await expect(
        h.tools
          .get("cancel")
          .execute({ sessionID: "ses_parent", format }, { sessionID: "ses_parent" }),
      ).rejects.toThrow("cannot control itself")
    }
  })

  test("steer and context unknown targets throw tool errors", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("steer")
        .execute({ sessionID: "ses_unknown", text: "go" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("could not be verified")

    await expect(
      h.tools
        .get("context")
        .execute({ sessionID: "ses_unknown", text: "note" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("could not be verified")
  })

  test("cancel_descendants invalid cursor throws a tool error", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("cancel_descendants")
        .execute({ cursor: "not-a-cursor" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Invalid cursor")
  })

  test("errors throw when structured output is disabled", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["text"] } })
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("list")
        .execute({ cursor: "not-a-cursor" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Invalid cursor")
  })

  test("refusals carry the Tool.Error tag", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    try {
      await h.tools
        .get("list")
        .execute({ cursor: "not-a-cursor" }, { sessionID: "ses_parent" })
      throw new Error("expected a refusal")
    } catch (error) {
      expect((error as { _tag?: string })._tag).toBe("Tool.Error")
      expect(String(error)).toContain("Invalid cursor")
    }
  })

  test("ownership refusals carry the Tool.Error tag", async () => {
    const h = makeHarness()
    cleanups.push(await h.setup())

    try {
      await h.tools
        .get("cancel")
        .execute({ sessionID: "ses_parent" }, { sessionID: "ses_parent" })
      throw new Error("expected a refusal")
    } catch (error) {
      expect((error as { _tag?: string })._tag).toBe("Tool.Error")
      expect(String(error)).toContain("cannot control itself")
    }
  })
})

describe("list usage fields", () => {
  const tokens = {
    input: 217046,
    output: 56335,
    reasoning: 116053,
    cache: { read: 34351872, write: 0 },
  }

  test("list shows cost and cumulative non-cache tokens", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        cost: 0.172947,
        tokens,
        model: { id: "deepseek/deepseek-v4.1-flash-1017", providerID: "openrouter" },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(result.content).toContain("cost=$0.17")
    expect(result.content).toContain("used=389k")
    expect(result.output.rows[0].usage.costUSD).toBe(0.172947)
    expect(result.output.rows[0].usage.tokensUsed).toBe(389434)
    expect(result.output.rows[0].usage.tokens.cache.read).toBe(34351872)
  })

  test("marks running usage as possibly lagging", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", { cost: 0.01, tokens }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(result.output.rows[0].status).toBe("running")
    expect(result.output.rows[0].usageMayLag).toBe(true)
    expect(result.content).toContain("usage=lagging")
  })

  test("does not mark finished usage as possibly lagging", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
        cost: 0.01,
        tokens,
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ statuses: ["finished"] }, { sessionID: "ses_parent" })
    expect(result.output.rows[0].status).toBe("finished")
    expect(result.output.rows[0].usageMayLag).toBeUndefined()
    expect(result.content).not.toContain("usage=lagging")
  })

  test("marks a running row without inventing usage numbers", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools.get("list").execute({}, { sessionID: "ses_parent" })
    expect(result.output.rows[0].usageMayLag).toBe(true)
    expect(result.output.rows[0].usage).toBeUndefined()
    expect(result.content).toContain("usage=lagging")
  })
})
