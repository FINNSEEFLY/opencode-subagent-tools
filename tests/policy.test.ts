import { describe, expect, test } from "bun:test"
import { createAccess } from "../src/access"
import { makeHarness, createChild, cleanups } from "./harness"

const addRoot = (h: ReturnType<typeof makeHarness>, id: string) => {
  h.sessions.set(id, {
    id,
    agent: "general",
    title: id,
    time: { created: 1, updated: 2, busy: 1 },
  })
}

const setupTree = (h: ReturnType<typeof makeHarness>) => {
  addRoot(h, "ses_root")
  h.addSession("ses_parent", "ses_root")
  createChild(h, "ses_child", "ses_parent")
  h.addSession("ses_other_parent", "ses_root")
  createChild(h, "ses_foreign", "ses_other_parent")
}

describe("sessionControlPolicy", () => {
  test("descendants is the default and refuses ancestors and foreign sessions", async () => {
    const h = makeHarness()
    setupTree(h)
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_parent" }, { sessionID: "ses_child" }),
    ).rejects.toThrow("not a descendant")
    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_foreign" }, { sessionID: "ses_child" }),
    ).rejects.toThrow("not a descendant")
    expect(h.calls.interrupt).toHaveLength(0)
  })

  test("all-except-ancestors allows foreign sessions but refuses ancestors", async () => {
    const h = makeHarness({ options: { sessionControlPolicy: "all-except-ancestors" } })
    setupTree(h)
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_parent" }, { sessionID: "ses_child" }),
    ).rejects.toThrow("is an ancestor")
    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_child" }, { sessionID: "ses_child" }),
    ).rejects.toThrow("cannot control itself")

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_foreign" }, { sessionID: "ses_child" })
    expect(h.calls.interrupt).toEqual([{ sessionID: "ses_foreign", resume: false }])
    expect(result.content).toContain("Interrupt requested")
  })

  test("all allows ancestors but still refuses self", async () => {
    const h = makeHarness({ options: { sessionControlPolicy: "all" } })
    setupTree(h)
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_parent" }, { sessionID: "ses_child" })
    expect(h.calls.interrupt).toEqual([{ sessionID: "ses_parent", resume: false }])
    expect(result.content).toContain("Interrupt requested")

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_child" }, { sessionID: "ses_child" }),
    ).rejects.toThrow("cannot control itself")
  })

  test("all-except-ancestors fails closed when the chain is too deep", async () => {
    const h = makeHarness({
      options: {
        sessionControlPolicy: "all-except-ancestors",
        limits: { maxDiscoveryDepth: 1 },
      },
    })
    setupTree(h)
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_root" }, { sessionID: "ses_child" }),
    ).rejects.toThrow("could not be verified")
    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_parent" }, { sessionID: "ses_child" }),
    ).rejects.toThrow("is an ancestor")
    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_foreign" }, { sessionID: "ses_child" }),
    ).rejects.toThrow("could not be verified")
  })

  test("read-only tools are unrestricted in every policy", async () => {
    const h = makeHarness()
    setupTree(h)
    cleanups.push(await h.setup())

    const listed = await h.tools
      .get("list")
      .execute({ parentID: "ses_root" }, { sessionID: "ses_child" })
    expect(listed.content).toContain("ses_parent")
    expect(listed.content).toContain("ses_other_parent")

    const usage = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_parent" }, { sessionID: "ses_child" })
    expect(usage.output.sessionID).toBe("ses_parent")
  })

  test("cancel_descendants always stays inside the caller's subtree", async () => {
    const h = makeHarness({ options: { sessionControlPolicy: "all" } })
    setupTree(h)
    createChild(h, "ses_grandchild", "ses_child")
    cleanups.push(await h.setup())

    await h.tools.get("cancel_descendants").execute({}, { sessionID: "ses_child" })
    expect(h.calls.interrupt.map((call) => call.sessionID)).toEqual(["ses_grandchild"])
  })

  test("an invalid policy falls back to descendants", async () => {
    const h = makeHarness({ options: { sessionControlPolicy: "bogus" } })
    setupTree(h)
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_foreign" }, { sessionID: "ses_child" }),
    ).rejects.toThrow("not a descendant")
  })

  test("an unknown policy is denied instead of allowed", async () => {
    const reads: string[] = []
    const access = createAccess({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          reads.push(sessionID)
          return { id: sessionID }
        },
      } as never,
      limits: { maxDiscoveryDepth: 8 },
      policy: "future-policy" as never,
      namespace: "subagent",
    })

    await expect(
      access.authorize("ses_foreign", { sessionID: "ses_parent" }),
    ).rejects.toThrow("unknown sessionControlPolicy")
    expect(reads).toEqual([])
  })
})
