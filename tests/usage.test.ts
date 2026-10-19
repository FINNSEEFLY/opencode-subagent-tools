import { describe, expect, test } from "bun:test"
import { makeHarness, createChild, sessionInfo, cleanups } from "./harness"
describe("usage", () => {
  const tokens = {
    input: 217046,
    output: 56335,
    reasoning: 116053,
    cache: { read: 34351872, write: 0 },
  }
  const lastTokens = {
    input: 27979,
    output: 1838,
    reasoning: 7547,
    cache: { read: 327680, write: 0 },
  }
  const model = {
    id: "deepseek/deepseek-v4.1-flash-1017",
    providerID: "openrouter",
  }
  const contextMessages = [
    {
      id: "msg_old",
      type: "assistant",
      tokens: {
        input: 900000,
        output: 900000,
        reasoning: 900000,
        cache: { read: 0, write: 0 },
      },
    },
    { id: "cmp_1", type: "compaction", status: "completed" },
    { id: "msg_last", type: "assistant", tokens: lastTokens, model },
  ]

  test("reports cumulative usage and the UI context formula", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", { cost: 0.172947, tokens, model }),
    )
    h.ctx.session.context = async () => contextMessages
    h.ctx.model.list = async () => ({
      data: [{ ...model, limit: { context: 1000000 } }],
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output.costUSD).toBe(0.172947)
    expect(result.output.tokensUsed).toBe(389434)
    expect(result.output.contextTokens).toBe(365044)
    expect(result.output.contextLimit).toBe(1000000)
    expect(result.output.contextPercent).toBe(37)
    expect(result.output.lastRequest.total).toBe(365044)
    expect(result.output.lastRequest.cacheRead).toBe(327680)
    expect(result.output.model.providerID).toBe("openrouter")
  })

  test("reports status and usageMayLag for a running session", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", { cost: 0.01, tokens }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output.status).toBe("running")
    expect(result.output.usageMayLag).toBe(true)
    expect(result.content).toContain("status=running (usage may lag)")
  })

  test("marks self usage as running and possibly lagging while the caller executes", async () => {
    const h = makeHarness()
    h.sessions.set("ses_parent", {
      id: "ses_parent",
      agent: "general",
      title: "Root",
      outcome: "succeeded",
      time: { created: 1, updated: 2, idle: 2 },
      cost: 0.1,
      tokens,
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_parent" }, { sessionID: "ses_parent" })
    expect(result.output.status).toBe("running")
    expect(result.output.usageMayLag).toBe(true)
  })

  test("reports finished status without usageMayLag", async () => {
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
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output.status).toBe("finished")
    expect(result.output.usageMayLag).toBeUndefined()
    expect(result.content).toContain("status=finished")
    expect(result.content).not.toContain("usage may lag")
  })

  test("format text returns a string output", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", { cost: 0.172947, tokens, model }),
    )
    h.ctx.session.context = async () => contextMessages
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child", format: "text" }, { sessionID: "ses_parent" })
    expect(typeof result.output).toBe("string")
    expect(result.output).toContain("context=365k")
    expect(result.output).toContain("cost=$0.17")
  })

  test("includes descendants in the tree totals", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    createChild(h, "ses_grand", "ses_child")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", { cost: 0.172947, tokens, model }),
    )
    h.sessions.set(
      "ses_grand",
      sessionInfo("ses_grand", "ses_child", {
        cost: 0.01,
        tokens: {
          input: 1000,
          output: 1000,
          reasoning: 1000,
          cache: { read: 0, write: 0 },
        },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute(
        { sessionID: "ses_child", includeDescendants: true },
        { sessionID: "ses_parent" },
      )
    expect(result.output.tree.sessions).toBe(2)
    expect(result.output.tree.descendants).toBe(1)
    expect(result.output.tree.costUSD).toBeCloseTo(0.182947)
    expect(result.output.tree.tokensUsed).toBe(392434)
    expect(result.output.tree.discoveryComplete).toBe(true)
    expect(result.output.tree.descendantsMayLag).toBe(true)
  })

  test("surfaces incomplete tree discovery in the text output and top-level warning", async () => {
    const h = makeHarness({ options: { limits: { maxDiscoveryNodes: 1 } } })
    h.sessions.set("ses_parent", sessionInfo("ses_parent", "ses_root"))
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute(
        { sessionID: "ses_parent", includeDescendants: true, format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.tree.discoveryComplete).toBe(false)
    expect(result.output.tree.warning).toContain("discovery was incomplete")
    expect(result.output.warning).toContain("discovery was incomplete")
    expect(result.content).toContain("discovery was incomplete")
  })

  test("does not mark a finished tree as possibly lagging", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
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
      .get("usage")
      .execute(
        { sessionID: "ses_child", includeDescendants: true },
        { sessionID: "ses_parent" },
      )
    expect(result.output.tree.descendantsMayLag).toBeUndefined()
  })

  test("allows the calling session to read its own usage", async () => {
    const h = makeHarness()
    h.sessions.set("ses_parent", {
      id: "ses_parent",
      agent: "general",
      title: "Root",
      time: { created: 1, updated: 2 },
      cost: 0.1,
      tokens,
      model,
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_parent" }, { sessionID: "ses_parent" })
    expect(result.output.costUSD).toBe(0.1)
    expect(result.output.tokensUsed).toBe(389434)
    expect(result.output.tree).toBeUndefined()
    expect(h.calls.permission).toHaveLength(0)
  })

  test("self usage reports an aborted read", async () => {
    const h = makeHarness()
    h.sessions.set("ses_parent", {
      id: "ses_parent",
      agent: "general",
      title: "Root",
      time: { created: 1, updated: 2 },
    })
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("usage")
        .execute(
          { sessionID: "ses_parent" },
          { sessionID: "ses_parent", signal: AbortSignal.abort() },
        ),
    ).rejects.toThrow("Aborted before usage was read")
  })

  test("self usage works without any session policy option", async () => {
    const h = makeHarness()
    h.sessions.set("ses_parent", {
      id: "ses_parent",
      agent: "general",
      title: "Root",
      time: { created: 1, updated: 2 },
      cost: 0.1,
      tokens,
      model,
    })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_parent" }, { sessionID: "ses_parent" })
    expect(result.output.costUSD).toBe(0.1)
    expect(result.output.tokensUsed).toBe(389434)
  })

  test("root usage with includeDescendants reports own cost and family tree", async () => {
    const h = makeHarness()
    h.sessions.set("ses_parent", {
      id: "ses_parent",
      agent: "general",
      title: "Root",
      time: { created: 1, updated: 2 },
      cost: 0.1,
      tokens,
      model,
    })
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        cost: 0.01,
        tokens: {
          input: 1000,
          output: 1000,
          reasoning: 1000,
          cache: { read: 0, write: 0 },
        },
      }),
    )
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute(
        { sessionID: "ses_parent", includeDescendants: true },
        { sessionID: "ses_parent" },
      )
    expect(result.output.costUSD).toBe(0.1)
    expect(result.output.tree.sessions).toBe(2)
    expect(result.output.tree.descendants).toBe(1)
    expect(result.output.tree.costUSD).toBeCloseTo(0.11)
    expect(result.output.tree.tokensUsed).toBe(392434)
  })

  test("usage reads a foreign session because reads are unrestricted", async () => {
    const h = makeHarness()
    h.sessions.set("ses_parent", {
      id: "ses_parent",
      agent: "general",
      title: "Root",
      time: { created: 1, updated: 2 },
    })
    h.sessions.set("ses_other_parent", {
      id: "ses_other_parent",
      agent: "general",
      title: "Other root",
      time: { created: 1, updated: 2 },
    })
    createChild(h, "ses_foreign", "ses_other_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_foreign" }, { sessionID: "ses_parent" })
    expect(result.output.sessionID).toBe("ses_foreign")
  })

  test("keeps cost when context cannot be read", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", { cost: 0.172947, tokens, model }),
    )
    h.ctx.session.context = async () => {
      throw new Error("no context")
    }
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output.costUSD).toBe(0.172947)
    expect(result.output.contextTokens).toBeUndefined()
    expect(result.output.warning).toContain("context unavailable")
  })

  test("does not crash on malformed context messages", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", { cost: 0.01, tokens }),
    )
    h.ctx.session.context = async () => [null]
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output.costUSD).toBe(0.01)
    expect(result.output.contextTokens).toBeUndefined()
    expect(result.output.warning).toContain("malformed messages")
  })

  test("does not turn an undefined context response into zero", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.ctx.session.context = async () => undefined
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output.contextTokens).toBeUndefined()
    expect(result.output.warning).toContain("server returned no message list")
  })

  test("does not turn a non-array context response into zero", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.ctx.session.context = async () => ({ not: "an array" })
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output.contextTokens).toBeUndefined()
    expect(result.output.warning).toContain("server returned no message list")
  })

  test("reports a missing staged revert boundary instead of zero", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        revert: { messageID: "msg_missing" },
      }),
    )
    h.ctx.session.context = async () => contextMessages
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output.contextTokens).toBeUndefined()
    expect(result.output.warning).toContain("staged revert boundary")
  })

  test("aborts a context read instead of returning a successful result", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    const controller = new AbortController()
    h.ctx.session.context = async () => {
      controller.abort()
      throw new Error("aborted")
    }
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("usage")
        .execute(
          { sessionID: "ses_child" },
          { sessionID: "ses_parent", signal: controller.signal },
        ),
    ).rejects.toThrow("Aborted while reading context")
  })

  test("aborts tree discovery instead of returning a partial tree", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    const controller = new AbortController()
    h.ctx.session.list = async () => {
      controller.abort()
      return { data: [] }
    }
    cleanups.push(await h.setup())

    await expect(
      h.tools
        .get("usage")
        .execute(
          { sessionID: "ses_child", includeDescendants: true },
          { sessionID: "ses_parent", signal: controller.signal },
        ),
    ).rejects.toThrow("Aborted while reading tree usage")
  })

  test("allowedOutputFormats text returns text only", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["text"] } })
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", { cost: 0.172947, tokens, model }),
    )
    h.ctx.session.context = async () => contextMessages
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output).toBeUndefined()
    expect(result.content).toContain("Session ses_child")
    expect(h.tools.get("usage").output).toBeUndefined()
  })

  test("returns context 0 when no assistant step exists after compaction", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", { cost: 0.172947, tokens, model }),
    )
    h.ctx.session.context = async () => [
      { id: "cmp_1", type: "compaction", status: "completed" },
    ]
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output.contextTokens).toBe(0)
    expect(result.content).toContain("context=0")
  })

  test("omits context when the last assistant step has no token data", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", { cost: 0.172947, tokens, model }),
    )
    h.ctx.session.context = async () => [{ id: "msg_1", type: "assistant", tokens: {} }]
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output.contextTokens).toBeUndefined()
    expect(result.output.lastRequest).toBeUndefined()
    expect(result.output.warning).toContain("token data is missing")
  })

  test("keeps a real zero token field as context zero", async () => {
    const h = makeHarness()
    createChild(h, "ses_child", "ses_parent")
    h.ctx.session.context = async () => [
      { id: "msg_1", type: "assistant", tokens: { input: 0 } },
    ]
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(result.output.contextTokens).toBe(0)
    expect(result.output.lastRequest.total).toBe(0)
  })

  test("omits tree token totals when no session reports token data", async () => {
    const h = makeHarness()
    h.sessions.set(
      "ses_parent",
      sessionInfo("ses_parent", "ses_root", {
        time: { created: 1, updated: 2, idle: 2 },
      }),
    )
    createChild(h, "ses_child", "ses_parent")
    cleanups.push(await h.setup())

    const result = await h.tools
      .get("usage")
      .execute(
        { sessionID: "ses_parent", includeDescendants: true, format: "json" },
        { sessionID: "ses_parent" },
      )
    expect(result.output.tree.tokens).toBeUndefined()
    expect(result.output.tree.tokensUsed).toBeUndefined()
    expect(result.content).toContain("used=unknown")
  })
})
