import { describe, expect, test } from "bun:test"
import {
  makeHarness,
  ALL_STATUSES,
  createChild,
  sessionInfo,
  listOf,
  cleanups,
} from "./harness"
describe("discovery", () => {
  test("follows the cursor across a short page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      sessionInfo(`ses_${String(index).padStart(3, "0")}`, "ses_parent"),
    )
    const second = sessionInfo("ses_second", "ses_parent")
    const h = makeHarness({
      sessionList: async ({ parentID, cursor }: any) => {
        if (parentID !== "ses_parent") return { data: [] }
        if (cursor === "page_2") return { data: [second], cursor: { next: "page_3" } }
        if (cursor === "page_3") return { data: [], cursor: {} }
        return { data: firstPage, cursor: { next: "page_2" } }
      },
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.known).toBe(101)
    expect(result.output.discoveryComplete).toBe(true)
    expect(h.sessionListCalls.some((call) => call.cursor === "page_2")).toBe(true)
    expect(h.sessionListCalls.some((call) => call.cursor === "page_3")).toBe(true)
    expect(h.sessionListCalls.some((call) => call.cursor === "page_4")).toBe(false)
  })

  test("marks a cursor-limited walk incomplete", async () => {
    const first = sessionInfo("ses_first", "ses_parent")
    const h = makeHarness({
      options: { limits: { maxDiscoveryPages: 1 } },
      sessionList: async () => ({ data: [first], cursor: { next: "page_2" } }),
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.known).toBe(1)
    expect(result.output.discoveryComplete).toBe(false)
    expect(h.sessionListCalls.some((call) => call.cursor === "page_2")).toBe(false)
  })

  test("stops on a repeated cursor and marks discovery incomplete", async () => {
    const first = sessionInfo("ses_first", "ses_parent")
    const h = makeHarness({
      sessionList: async ({ parentID }: any) =>
        parentID === "ses_parent"
          ? { data: [first], cursor: { next: "same" } }
          : { data: [] },
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.known).toBe(1)
    expect(result.output.discoveryComplete).toBe(false)
    expect(h.sessionListCalls.filter((call) => call.cursor === "same")).toHaveLength(1)
  })

  test("accepts a bare array and honors the discovery depth", async () => {
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
  })

  test("honors the discovery page limit", async () => {
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
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.known).toBe(100)
    expect(result.output.discoveryComplete).toBe(false)
    expect(result.content).toContain("discovery was incomplete")
    expect(h.sessionListCalls.some((call) => call.cursor === "page_2")).toBe(false)
  })

  test("discovers grandchildren and cancel_descendants reaches them", async () => {
    const h = makeHarness()
    createChild(h, "ses_mid", "ses_parent")
    createChild(h, "ses_leaf", "ses_mid")
    cleanups.push(await h.setup())

    await h.tools.get("cancel_descendants").execute({}, { sessionID: "ses_parent" })
    expect(h.calls.interrupt.map((call) => call.sessionID).toSorted()).toEqual([
      "ses_leaf",
      "ses_mid",
    ])
  })

  test("treats undefined, null, and malformed session.list pages as incomplete", async () => {
    for (const response of [undefined, null, { data: null }, { data: {} }]) {
      const h = makeHarness({ sessionList: async () => response })
      cleanups.push(await h.setup())

      const result = await h.tools
        .get("list")
        .execute({ format: "json" }, { sessionID: "ses_parent" })
      expect(result.output.discoveryComplete).toBe(false)
      expect(result.content).toContain("discovery was incomplete")
    }
  })

  test("marks a page with malformed items as incomplete instead of throwing", async () => {
    const h = makeHarness({
      sessionList: async () => ({ data: [null, { id: "" }] }),
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.discoveryComplete).toBe(false)
    expect(result.content).toContain("discovery was incomplete")
  })

  test("marks a full bare array without a cursor as incomplete", async () => {
    const page = Array.from({ length: 100 }, (_, index) =>
      sessionInfo(`ses_${String(index).padStart(3, "0")}`, "ses_parent"),
    )
    const h = makeHarness({ sessionList: async () => page })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.known).toBe(100)
    expect(result.output.discoveryComplete).toBe(false)
    expect(result.content).toContain("discovery was incomplete")
  })

  test("marks a malformed cursor as incomplete instead of ending cleanly", async () => {
    const h = makeHarness({
      sessionList: async () => ({
        data: [sessionInfo("ses_child", "ses_parent")],
        cursor: { next: 123 },
      }),
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.discoveryComplete).toBe(false)
    expect(result.content).toContain("discovery was incomplete")
  })

  test("marks a parent mismatch as incomplete instead of silently dropping it", async () => {
    const h = makeHarness({
      sessionList: async () => ({
        data: [sessionInfo("ses_child", "ses_elsewhere")],
        cursor: {},
      }),
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("list")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.known).toBe(0)
    expect(result.output.discoveryComplete).toBe(false)
    expect(result.content).toContain("discovery was incomplete")
  })

  test("reports an abort that happens while session.list is in flight", async () => {
    const controller = new AbortController()
    const h = makeHarness({
      sessionList: async (_input: unknown, options?: { signal?: AbortSignal }) => {
        expect(options?.signal).toBe(controller.signal)
        controller.abort()
        return {
          data: [sessionInfo("ses_child", "ses_parent")],
          cursor: {},
        }
      },
    })
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("list")
        .execute({}, { sessionID: "ses_parent", signal: controller.signal }),
    ).rejects.toThrow("Aborted during discovery")
  })

  test("cancel_descendants reports an abort during discovery instead of a clean no-op", async () => {
    const controller = new AbortController()
    const h = makeHarness({
      sessionList: async () => {
        controller.abort()
        return {
          data: [sessionInfo("ses_child", "ses_parent")],
          cursor: {},
        }
      },
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent", signal: controller.signal })
    expect(result.output.aborted).toBe(true)
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("cancel_descendants warns when malformed discovery may hide running children", async () => {
    const h = makeHarness({ sessionList: async () => undefined })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel_descendants")
      .execute({ format: "json" }, { sessionID: "ses_parent" })
    expect(result.output.aborted).toBe(false)
    expect(result.output.warning).toContain(
      "some running subagents may not have been stopped",
    )
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("requires ctx.session.list", async () => {
    const h = makeHarness({ noSessionList: true })
    let error: unknown
    try {
      await h.setup()
    } catch (caught) {
      error = caught
    }
    expect(String(error)).toContain("ctx.session.list")
  })
})
