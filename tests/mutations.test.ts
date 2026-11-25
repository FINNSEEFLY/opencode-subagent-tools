import { describe, expect, test } from "bun:test";
import { makeHarness, createChild, startChild, sessionInfo, cleanups } from "./harness";
describe("ownership and mutations", () => {
  test("cancel interrupts a descendant and reports the reason", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "interrupted",
        time: { created: 1, updated: 3, idle: 3 },
      }),
    );
    cleanups.push(await h.setup());

    const result = await h.tools
      .get("cancel")
      .execute(
        { sessionID: "ses_child", reason: "wrong direction" },
        { sessionID: "ses_parent" },
      );
    expect(h.calls.interrupt).toEqual([{ sessionID: "ses_child", resume: false }]);
    expect(result.content).toContain("Interrupt requested");
    expect(result.content).toContain("wrong direction");
  });

  test("cancel refuses an unknown target", async () => {
    const h = makeHarness();
    cleanups.push(await h.setup());

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_foreign" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("could not be verified");
    expect(h.calls.interrupt).toHaveLength(0);
  });

  test("a sibling cannot control another session's child", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_other_parent");
    createChild(h, "ses_other_parent", "ses_root");
    h.sessions.set("ses_root", {
      id: "ses_root",
      agent: "general",
      title: "Root",
      time: { created: 1, updated: 2 },
    });
    cleanups.push(await h.setup());

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_child" }, { sessionID: "ses_sibling" }),
    ).rejects.toThrow("not a descendant");
    expect(h.calls.interrupt).toHaveLength(0);
  });

  test("cancel verifies an unobserved descendant through the parent chain", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    createChild(h, "ses_grandchild", "ses_child");
    cleanups.push(await h.setup());

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_grandchild" }, { sessionID: "ses_parent" });
    expect(h.calls.interrupt).toEqual([{ sessionID: "ses_grandchild", resume: false }]);
    expect(result.content).toContain("Interrupt requested");
  });

  test("a descendant beyond maxDiscoveryDepth is unverified, not foreign", async () => {
    const h = makeHarness({ options: { limits: { maxDiscoveryDepth: 2 } } });
    createChild(h, "ses_child", "ses_parent");
    createChild(h, "ses_grandchild", "ses_child");
    createChild(h, "ses_great", "ses_grandchild");
    cleanups.push(await h.setup());

    try {
      await h.tools
        .get("cancel")
        .execute({ sessionID: "ses_great" }, { sessionID: "ses_parent" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(String(error)).toContain("could not be verified");
      expect(String(error)).not.toContain("not a descendant");
    }
    expect(h.calls.interrupt).toHaveLength(0);
  });

  test("a session cannot control itself", async () => {
    const h = makeHarness();
    cleanups.push(await h.setup());

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_parent" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("cannot control itself");
    expect(h.calls.interrupt).toHaveLength(0);
  });

  test("cancel reports an unknown outcome when aborted mid-interrupt", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());
    const controller = new AbortController();
    h.ctx.session.interrupt = async () => {
      controller.abort();
      throw new Error("aborted");
    };

    await expect(
      h.tools
        .get("cancel")
        .execute(
          { sessionID: "ses_child" },
          { sessionID: "ses_parent", signal: controller.signal },
        ),
    ).rejects.toThrow("may or may not have been accepted");
  });

  test("cancel returns a normal result when the abort arrives after the interrupt", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());
    const controller = new AbortController();
    h.ctx.session.interrupt = async ({ sessionID }: { sessionID: string }) => {
      h.calls.interrupt.push({ sessionID, resume: false });
      controller.abort();
      return { interrupted: true };
    };

    const result = await h.tools
      .get("cancel")
      .execute(
        { sessionID: "ses_child", format: "json" },
        { sessionID: "ses_parent", signal: controller.signal },
      );
    expect(result.output.interrupt).toBe("accepted");
    expect(result.output.accepted).toBe(true);
    expect(result.output.status).toBeDefined();
  });

  test("cancel reports an interrupt failure", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());
    h.ctx.session.interrupt = async () => {
      throw new Error("cannot interrupt");
    };

    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Interrupt failed for ses_child");
  });

  test("cancel does not claim success for a malformed interrupt response", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());
    h.ctx.session.interrupt = async () => undefined;

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" });
    expect(result.output.accepted).toBe(false);
    expect(result.output.interrupt).toBe("unknown");
    expect(result.content).toContain("Interrupt outcome unknown");
  });

  test("cancel reports read-back lag when the target still looks running", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());
    startChild(h, "ses_child");
    await h.tick();

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" });
    expect(result.output.status).toBe("running");
    expect(result.output.readBackMayLag).toBe(true);
  });

  test("cancel reports when the target was not running", async () => {
    const h = makeHarness();
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    cleanups.push(await h.setup());
    h.ctx.session.interrupt = async () => ({ interrupted: false });

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" });
    expect(result.content).toContain("was not running");
    expect(result.content).toContain("finished");
  });

  test("mutations refuse an unknown calling session", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());

    await expect(
      h.tools.get("cancel").execute({ sessionID: "ses_child" }, {}),
    ).rejects.toThrow("calling session is unknown");
    expect(h.calls.interrupt).toHaveLength(0);
  });

  test("sessionControlPolicy all permits a foreign target but still requires a caller", async () => {
    const h = makeHarness({ options: { sessionControlPolicy: "all" } });
    createChild(h, "ses_foreign", "ses_other_parent");
    cleanups.push(await h.setup());

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_foreign" }, { sessionID: "ses_parent" });
    expect(h.calls.interrupt).toEqual([{ sessionID: "ses_foreign", resume: false }]);
    expect(result.content).toContain("Interrupt requested");

    await expect(
      h.tools.get("cancel").execute({ sessionID: "ses_foreign" }, {}),
    ).rejects.toThrow("calling session is unknown");
    expect(h.calls.interrupt).toHaveLength(1);
  });

  test("steer admits an instruction and warns for a finished child", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    cleanups.push(await h.setup());

    const result = await h.tools
      .get("steer")
      .execute(
        { sessionID: "ses_child", text: "use the smaller fix", format: "json" },
        { sessionID: "ses_parent" },
      );
    expect(h.calls.prompt).toEqual([
      {
        sessionID: "ses_child",
        text: "use the smaller fix",
        delivery: "steer",
        resume: true,
      },
    ]);
    expect(result.content).toContain("Steering message sent to");
    expect(result.output.status).toBe("finished");
    expect(result.output.resume).toBe(true);
  });

  test("reports the delivery and text admitted by the server", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    h.ctx.session.prompt = async () => ({
      id: "inbox_user",
      delivery: "queue",
      payload: { text: "rewritten" },
    });
    cleanups.push(await h.setup());

    const result = await h.tools
      .get("steer")
      .execute(
        { sessionID: "ses_child", text: "original", format: "json" },
        { sessionID: "ses_parent" },
      );
    expect(result.output.delivery).toBe("queue");
    expect(result.output.chars).toBe(9);
    expect(result.content).toContain("Message queued for");
    expect(result.content).toContain("delivery=queue");
    expect(result.content).toContain("9 chars");
  });

  test("reports the text admitted for context", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    h.ctx.session.synthetic = async () => ({
      id: "inbox_synthetic",
      payload: { text: "rewritten" },
    });
    cleanups.push(await h.setup());

    const result = await h.tools
      .get("context")
      .execute(
        { sessionID: "ses_child", text: "original", format: "json" },
        { sessionID: "ses_parent" },
      );
    expect(result.output.delivery).toBe("next-step");
    expect(result.output.chars).toBe(9);
    expect(result.content).toContain("9 chars");
  });

  test("steer can admit without waking an idle child", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    cleanups.push(await h.setup());

    const result = await h.tools.get("steer").execute(
      {
        sessionID: "ses_child",
        text: "use the smaller fix",
        resume: false,
        format: "json",
      },
      { sessionID: "ses_parent" },
    );
    expect(h.calls.prompt).toEqual([
      {
        sessionID: "ses_child",
        text: "use the smaller fix",
        delivery: "steer",
        resume: false,
      },
    ]);
    expect(result.output.resume).toBe(false);
    expect(result.output.pending).toBe(true);
  });

  test("queue admits a follow-up turn with delivery queue", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());

    const result = await h.tools
      .get("queue")
      .execute(
        { sessionID: "ses_child", text: "run the benchmark next", format: "json" },
        { sessionID: "ses_parent" },
      );
    expect(h.calls.prompt).toEqual([
      {
        sessionID: "ses_child",
        text: "run the benchmark next",
        delivery: "queue",
        resume: true,
      },
    ]);
    expect(result.content).toContain("Message queued for");
    expect(result.output.delivery).toBe("queue");
    expect(result.output.resume).toBe(true);
  });

  test("queue can admit without waking an idle child", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    cleanups.push(await h.setup());

    const result = await h.tools.get("queue").execute(
      {
        sessionID: "ses_child",
        text: "run the benchmark next",
        resume: false,
        format: "json",
      },
      { sessionID: "ses_parent" },
    );
    expect(h.calls.prompt).toEqual([
      {
        sessionID: "ses_child",
        text: "run the benchmark next",
        delivery: "queue",
        resume: false,
      },
    ]);
    expect(result.output.pending).toBe(true);
  });

  test("queue reports the observed status for a finished child", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    cleanups.push(await h.setup());

    const result = await h.tools
      .get("queue")
      .execute(
        { sessionID: "ses_child", text: "run the benchmark next", format: "json" },
        { sessionID: "ses_parent" },
      );
    expect(result.output.delivery).toBe("queue");
    expect(result.output.status).toBe("finished");
    expect(result.output.resume).toBe(true);
    expect(result.output.queued).toBe(false);
    expect(result.output.active).toBe(false);
  });

  test("queue reports queued from observed status and resume", async () => {
    const h = makeHarness();
    createChild(h, "ses_run", "ses_parent");
    h.sessions.set(
      "ses_done",
      sessionInfo("ses_done", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    cleanups.push(await h.setup());

    let result = await h.tools
      .get("queue")
      .execute(
        { sessionID: "ses_run", text: "next", format: "json" },
        { sessionID: "ses_parent" },
      );
    expect(result.output.queued).toBe(true);
    expect(result.output.active).toBe(true);

    result = await h.tools
      .get("queue")
      .execute(
        { sessionID: "ses_done", text: "next", resume: false, format: "json" },
        { sessionID: "ses_parent" },
      );
    expect(result.output.queued).toBe(true);
    expect(result.output.pending).toBe(true);
  });

  test("send output reflects the target before admission", async () => {
    const h = makeHarness();
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    cleanups.push(await h.setup());
    h.ctx.session.prompt = async () => {
      h.emit({
        type: "session.execution.started",
        data: { sessionID: "ses_child" },
      });
      await h.flush();
      return { id: "inbox_user" };
    };

    const result = await h.tools
      .get("queue")
      .execute(
        { sessionID: "ses_child", text: "next", format: "json" },
        { sessionID: "ses_parent" },
      );
    expect(result.output.status).toBe("finished");
    expect(result.output.active).toBe(false);
    expect(result.output.queued).toBe(false);
  });

  test("queue and context report observed background work", async () => {
    const h = makeHarness();
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    cleanups.push(await h.setup());
    await h.fireIdle("ses_child", [
      {
        kind: "shell",
        sessionID: "ses_child",
        shellID: "sh_1",
        command: "run",
      },
    ]);

    let result = await h.tools
      .get("queue")
      .execute(
        { sessionID: "ses_child", text: "next", format: "json" },
        { sessionID: "ses_parent" },
      );
    expect(result.output.active).toBe(true);
    expect(result.output.backgroundJob).toEqual({ kinds: ["shell"] });
    expect(result.output.queued).toBe(false);

    result = await h.tools
      .get("context")
      .execute(
        { sessionID: "ses_child", text: "note", format: "json" },
        { sessionID: "ses_parent" },
      );
    expect(result.output.active).toBe(true);
    expect(result.output.backgroundJob).toEqual({ kinds: ["shell"] });
    expect(result.output.queued).toBeUndefined();
  });

  test("non-boolean resume values do not wake an idle child", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    cleanups.push(await h.setup());

    const result = await h.tools.get("steer").execute(
      {
        sessionID: "ses_child",
        text: "stay idle",
        resume: "false",
        format: "json",
      },
      { sessionID: "ses_parent" },
    );
    expect(h.calls.prompt[0].resume).toBe(false);
    expect(result.output.resume).toBe(false);
  });

  test("send tools count chars by Unicode code point", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());

    const result = await h.tools
      .get("steer")
      .execute(
        { sessionID: "ses_child", text: "🙂🙂", format: "json" },
        { sessionID: "ses_parent" },
      );
    expect(result.output.chars).toBe(2);
    expect(result.content).toContain("2 chars");
  });

  test("context injects a synthetic message", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());

    const result = await h.tools
      .get("context")
      .execute(
        { sessionID: "ses_child", text: "migration applied", description: "state" },
        { sessionID: "ses_parent" },
      );
    expect(h.calls.synthetic).toEqual([
      {
        sessionID: "ses_child",
        text: "migration applied",
        description: "state",
        metadata: { source: "subagent-tools" },
        resume: false,
      },
    ]);
    expect(result.content).toContain("Context injected");
  });

  test("reports steer and context failures", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());
    h.ctx.session.prompt = async () => {
      throw new Error("child is gone");
    };
    h.ctx.session.synthetic = async () => {
      throw new Error("inbox closed");
    };

    await expect(
      h.tools
        .get("steer")
        .execute({ sessionID: "ses_child", text: "hello" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Steer failed for ses_child");

    await expect(
      h.tools
        .get("context")
        .execute({ sessionID: "ses_child", text: "note" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("Context injection failed");
  });

  test("tools validate required input and reject over-long text with a short error", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());

    await expect(
      h.tools.get("cancel").execute({}, { sessionID: "ses_parent" }),
    ).rejects.toThrow("sessionID is required");
    await expect(
      h.tools
        .get("steer")
        .execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("text is required");

    const longText = "x".repeat(16001);
    await expect(
      h.tools
        .get("steer")
        .execute({ sessionID: "ses_child", text: longText }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("text is 16001 characters; maximum is 16000");
    expect(h.calls.prompt).toHaveLength(0);

    const reason = "r".repeat(600);
    await expect(
      h.tools
        .get("cancel")
        .execute({ sessionID: "ses_child", reason }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("reason is 600 characters; maximum is 500");
    expect(h.calls.interrupt).toHaveLength(0);
  });

  test("context rejects over-long text without echoing the payload", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());

    const longText = "secret-marker-" + "x".repeat(16000);
    await expect(
      h.tools
        .get("context")
        .execute({ sessionID: "ses_child", text: longText }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("text is 16014 characters; maximum is 16000");
    expect(h.calls.synthetic).toHaveLength(0);

    await expect(
      h.tools
        .get("context")
        .execute(
          { sessionID: "ses_child", text: "note", description: "d".repeat(201) },
          { sessionID: "ses_parent" },
        ),
    ).rejects.toThrow("description is 201 characters; maximum is 200");
    expect(h.calls.synthetic).toHaveLength(0);
  });

  test("trims model-provided text and rejects blank text", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());

    await expect(
      h.tools
        .get("steer")
        .execute({ sessionID: "ses_child", text: "   " }, { sessionID: "ses_parent" }),
    ).rejects.toThrow("text is required");

    await h.tools
      .get("steer")
      .execute({ sessionID: "ses_child", text: "  go  " }, { sessionID: "ses_parent" });
    expect(h.calls.prompt[0].text).toBe("go");
  });

  test("applies a custom maxTextLength to rejection", async () => {
    const h = makeHarness({ options: { limits: { maxTextLength: 5 } } });
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());

    await expect(
      h.tools
        .get("steer")
        .execute(
          { sessionID: "ses_child", text: "abcdefgh" },
          { sessionID: "ses_parent" },
        ),
    ).rejects.toThrow("text is 8 characters; maximum is 5");
    expect(h.calls.prompt).toHaveLength(0);
  });
});

describe("cancel with background work", () => {
  const finished = (id: string, parentID: string) =>
    sessionInfo(id, parentID, {
      outcome: "succeeded",
      time: { created: 1, updated: 2, idle: 2 },
    });

  test("an idle target with a background shell is reported honestly", async () => {
    const h = makeHarness();
    h.sessions.set("ses_child", finished("ses_child", "ses_parent"));
    cleanups.push(await h.setup());
    await h.fireIdle("ses_child", [
      {
        kind: "shell",
        sessionID: "ses_child",
        shellID: "sh_1",
        command: "run",
      },
    ]);
    h.ctx.session.interrupt = async () => ({ interrupted: false });

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" });
    expect(result.output.interrupt).toBe("rejected");
    expect(result.output.active).toBe(true);
    expect(result.output.backgroundJob).toEqual({
      kinds: ["shell"],
      mayRemain: true,
    });
    expect(result.content).toContain("cannot stop the background job (shell)");
    expect(result.content).not.toContain("no interrupt was needed.");
  });

  test("an idle target with a background image is reported honestly", async () => {
    const h = makeHarness();
    h.sessions.set("ses_child", finished("ses_child", "ses_parent"));
    cleanups.push(await h.setup());
    await h.fireIdle("ses_child", [
      {
        kind: "image",
        sessionID: "ses_child",
        path: "out.png",
        model: "model",
      },
    ]);
    h.ctx.session.interrupt = async () => ({ interrupted: false });

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" });
    expect(result.output.backgroundJob).toEqual({
      kinds: ["image"],
      mayRemain: true,
    });
    expect(result.content).toContain("cannot stop the background job (image)");
  });

  test("an idle target with a background video is reported honestly", async () => {
    const h = makeHarness();
    h.sessions.set("ses_child", finished("ses_child", "ses_parent"));
    cleanups.push(await h.setup());
    await h.fireIdle("ses_child", [
      {
        kind: "video",
        sessionID: "ses_child",
        path: "out.mp4",
      },
    ]);
    h.ctx.session.interrupt = async () => ({ interrupted: false });

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" });
    expect(result.output.backgroundJob).toEqual({
      kinds: ["video"],
      mayRemain: true,
    });
    expect(result.content).toContain("cannot stop the background job (video)");
  });

  test("a failed probe sets stateUnknown instead of claiming no job", async () => {
    const h = makeHarness();
    h.sessions.set("ses_child", finished("ses_child", "ses_parent"));
    cleanups.push(await h.setup());
    h.ctx.session.context = async () => {
      throw new Error("no context");
    };
    h.ctx.session.interrupt = async () => ({ interrupted: false });

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" });
    expect(result.output.active).toBe(true);
    expect(result.output.backgroundJob).toEqual({
      kinds: [],
      stateUnknown: true,
      mayRemain: true,
    });
    expect(result.content).toContain("background job state could not be verified");
  });

  test("an accepted interrupt says a background job may continue", async () => {
    const h = makeHarness();
    createChild(h, "ses_child", "ses_parent");
    cleanups.push(await h.setup());
    h.shellStarted("ses_child", "sh_1");
    await h.flush();

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" });
    expect(result.output.interrupt).toBe("accepted");
    expect(result.output.active).toBe(true);
    expect(result.output.backgroundJob).toEqual({
      kinds: ["shell"],
      mayRemain: true,
    });
    expect(result.content).toContain("background job (shell) may continue");
  });

  test("an idle target with known descendant jobs notes the subtree", async () => {
    const h = makeHarness();
    h.sessions.set("ses_mid", finished("ses_mid", "ses_parent"));
    h.sessions.set("ses_leaf", finished("ses_leaf", "ses_mid"));
    cleanups.push(await h.setup());
    await h.fireIdle("ses_mid", [
      {
        kind: "shell",
        sessionID: "ses_leaf",
        shellID: "sh_1",
        command: "run",
      },
    ]);
    h.ctx.session.interrupt = async () => ({ interrupted: false });

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_mid", format: "json" }, { sessionID: "ses_parent" });
    expect(result.output.active).toBe(false);
    expect(result.output.backgroundJob).toBeUndefined();
    expect(result.content).toContain("subtree may still be active");
  });

  test("cancel reports a structured subagent job", async () => {
    const h = makeHarness();
    h.sessions.set("ses_parent", finished("ses_parent", "ses_root"));
    h.sessions.set("ses_child", finished("ses_child", "ses_parent"));
    cleanups.push(await h.setup());
    await h.fireIdle("ses_parent", [
      {
        kind: "subagent",
        sessionID: "ses_parent",
        childSessionID: "ses_child",
        agent: "general",
        description: "task",
      },
    ]);
    h.ctx.session.interrupt = async () => ({ interrupted: false });

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_parent", format: "json" }, { sessionID: "ses_root" });
    expect(result.output.backgroundJob).toEqual({
      kinds: ["subagent"],
      mayRemain: true,
    });
    expect(result.content).toContain("cannot stop the background job (subagent)");
  });

  test("cancel probes a running subagent tool part", async () => {
    const h = makeHarness();
    h.sessions.set("ses_child", finished("ses_child", "ses_parent"));
    cleanups.push(await h.setup());
    await h.fireIdle("ses_child", []);
    h.ctx.session.context = async ({ sessionID }: { sessionID: string }) =>
      sessionID === "ses_child"
        ? [
            {
              type: "assistant",
              content: [{ type: "tool", name: "subagent", state: { status: "running" } }],
            },
          ]
        : [];
    h.ctx.session.interrupt = async () => ({ interrupted: false });

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" });
    expect(result.output.backgroundJob).toEqual({
      kinds: ["subagent"],
      mayRemain: true,
    });
    expect(result.content).toContain("cannot stop the background job (subagent)");
  });

  test("cancel fails closed without an authoritative snapshot", async () => {
    const h = makeHarness();
    h.sessions.set("ses_child", finished("ses_child", "ses_parent"));
    cleanups.push(await h.setup());
    h.ctx.session.interrupt = async () => ({ interrupted: false });

    const result = await h.tools
      .get("cancel")
      .execute({ sessionID: "ses_child", format: "json" }, { sessionID: "ses_parent" });
    expect(result.output.backgroundJob).toEqual({
      kinds: [],
      stateUnknown: true,
      mayRemain: true,
    });
    expect(result.content).toContain("background job state could not be verified");
  });
});
