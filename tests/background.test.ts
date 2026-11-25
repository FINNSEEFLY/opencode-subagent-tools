import { describe, expect, test } from "bun:test";
import { BACKGROUND_JOB_KIND, createBackgroundJobStore } from "../src/background";
import { handleEvent } from "../src/events";
import { createLiveState } from "../src/live-state";
import { RUN_STATUS } from "../src/status";
import { cleanups, makeHarness } from "./harness";

describe("background job store", () => {
  test("shell events add and remove a shell job", () => {
    const background = createBackgroundJobStore();
    background.recordShellStarted("ses_a", "sh_1", 10);
    expect(background.backgroundJobFor("ses_a")).toEqual({
      kinds: [BACKGROUND_JOB_KIND.shell],
    });
    background.recordShellEnded("ses_a", "sh_1", 11);
    expect(background.backgroundJobFor("ses_a")).toBeUndefined();
  });

  test("a stale shell end does not remove a newer shell", () => {
    const background = createBackgroundJobStore();
    background.recordShellStarted("ses_a", "sh_1", 20);
    background.recordShellEnded("ses_a", "sh_1", 15);
    expect(background.backgroundJobFor("ses_a")).toEqual({
      kinds: [BACKGROUND_JOB_KIND.shell],
    });
  });

  test("the idle hook records shell, image, video, subagent and codemode jobs", () => {
    const background = createBackgroundJobStore();
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [
          {
            kind: "shell",
            sessionID: "ses_parent",
            shellID: "sh_1",
            command: "run",
          },
          {
            kind: "image",
            sessionID: "ses_parent",
            path: "out.png",
            model: "model",
          },
          {
            kind: "video",
            sessionID: "ses_parent",
            path: "out.mp4",
          },
          {
            kind: "subagent",
            sessionID: "ses_parent",
            childSessionID: "ses_child",
            agent: "general",
            description: "task",
          },
          {
            kind: "codemode",
            sessionID: "ses_parent",
            jobID: "cm_1",
          },
        ],
      },
      10,
    );
    expect(background.backgroundJobFor("ses_parent")).toEqual({
      kinds: ["shell", "image", "video", "subagent", "codemode"],
    });
  });

  test("a video item without a path marks the owner unknown", () => {
    const background = createBackgroundJobStore();
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [{ kind: "video", sessionID: "ses_parent", path: "" }],
      },
      10,
    );
    expect(background.backgroundJobFor("ses_parent")).toEqual({
      kinds: [],
      stateUnknown: true,
    });
  });

  test("a codemode item without a job ID marks the owner unknown", () => {
    const background = createBackgroundJobStore();
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [{ kind: "codemode", sessionID: "ses_parent" }],
      },
      10,
    );
    expect(background.backgroundJobFor("ses_parent")).toEqual({
      kinds: [],
      stateUnknown: true,
    });
  });

  test("an empty idle snapshot clears the idle session's own jobs", () => {
    const background = createBackgroundJobStore();
    background.recordShellStarted("ses_parent", "sh_1", 10);
    background.recordIdle({ sessionID: "ses_parent", background: [] }, 20);
    expect(background.backgroundJobFor("ses_parent")).toBeUndefined();
  });

  test("a descendant item is stored under its owner, not the idle parent", () => {
    const background = createBackgroundJobStore();
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [
          {
            kind: "shell",
            sessionID: "ses_child",
            shellID: "sh_1",
            command: "run",
          },
        ],
      },
      10,
    );
    expect(background.backgroundJobFor("ses_parent")).toBeUndefined();
    expect(background.backgroundJobFor("ses_child")).toEqual({
      kinds: [BACKGROUND_JOB_KIND.shell],
    });
  });

  test("a descendant video item is stored under its owner", () => {
    const background = createBackgroundJobStore();
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [
          {
            kind: "video",
            sessionID: "ses_child",
            path: "out.mp4",
          },
        ],
      },
      10,
    );
    expect(background.backgroundJobFor("ses_parent")).toBeUndefined();
    expect(background.backgroundJobFor("ses_child")).toEqual({
      kinds: [BACKGROUND_JOB_KIND.video],
    });
  });

  test("an unknown kind preserves known jobs and marks the owner unknown", () => {
    const background = createBackgroundJobStore();
    background.recordShellStarted("ses_parent", "sh_1", 10);
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [{ kind: "future-kind", sessionID: "ses_parent" }],
      },
      20,
    );
    expect(background.backgroundJobFor("ses_parent")).toEqual({
      kinds: [BACKGROUND_JOB_KIND.shell],
      stateUnknown: true,
    });
  });

  test("an invalid key preserves known jobs for a known owner", () => {
    const background = createBackgroundJobStore();
    background.recordShellStarted("ses_child", "sh_1", 10);
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [{ kind: "shell", sessionID: "ses_child", shellID: "" }],
      },
      20,
    );
    expect(background.backgroundJobFor("ses_parent")).toBeUndefined();
    expect(background.backgroundJobFor("ses_child")).toEqual({
      kinds: [BACKGROUND_JOB_KIND.shell],
      stateUnknown: true,
    });
  });

  test("an unattributable item preserves every known job", () => {
    const background = createBackgroundJobStore();
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [
          {
            kind: "shell",
            sessionID: "ses_child",
            shellID: "sh_1",
            command: "run",
          },
        ],
      },
      10,
    );
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [{ kind: "shell", sessionID: "bad id", shellID: "sh_2" }],
      },
      20,
    );
    expect(background.backgroundJobFor("ses_parent")).toEqual({
      kinds: [],
      stateUnknown: true,
    });
    expect(background.backgroundJobFor("ses_child")).toEqual({
      kinds: [BACKGROUND_JOB_KIND.shell],
      stateUnknown: true,
    });
  });

  test("an unattributable snapshot tracks invalid owners for later clearing", () => {
    const background = createBackgroundJobStore();
    background.recordShellStarted("ses_child", "sh_1", 10);
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [{ kind: "future-kind", sessionID: "ses_child" }, null],
      },
      20,
    );
    expect(background.backgroundJobFor("ses_child")).toEqual({
      kinds: [BACKGROUND_JOB_KIND.shell],
      stateUnknown: true,
    });
    background.recordIdle({ sessionID: "ses_parent", background: [] }, 30);
    expect(background.backgroundJobFor("ses_child")).toBeUndefined();
  });

  test("a valid snapshot clears a previous unknown marker", () => {
    const background = createBackgroundJobStore();
    background.recordShellStarted("ses_parent", "sh_1", 10);
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [{ kind: "future-kind", sessionID: "ses_parent" }],
      },
      20,
    );
    expect(background.backgroundJobFor("ses_parent")?.stateUnknown).toBe(true);
    background.recordIdle({ sessionID: "ses_parent", background: [] }, 30);
    expect(background.backgroundJobFor("ses_parent")).toBeUndefined();
  });

  test("hasSnapshot reports authoritative idle snapshots only", () => {
    const background = createBackgroundJobStore();
    expect(background.hasSnapshot("ses_a")).toBe(false);
    background.recordShellStarted("ses_a", "sh_1", 10);
    expect(background.hasSnapshot("ses_a")).toBe(false);
    background.recordIdle({ sessionID: "ses_a", background: [] }, 20);
    expect(background.hasSnapshot("ses_a")).toBe(true);
    background.recordIdle({ sessionID: "ses_b", background: [null] }, 10);
    expect(background.hasSnapshot("ses_b")).toBe(false);
  });

  test("malformed payloads are ignored and unknown kinds are fail-closed", () => {
    const background = createBackgroundJobStore();
    background.recordIdle(null, 10);
    background.recordIdle({ sessionID: "bad id", background: [] }, 10);
    background.recordIdle({ sessionID: "ses_a", background: "nope" }, 10);
    expect(background.backgroundJobFor("ses_a")).toBeUndefined();

    background.recordIdle({ sessionID: "ses_a", background: [{ kind: "bogus" }] }, 10);
    expect(background.backgroundJobFor("ses_a")).toEqual({
      kinds: [],
      stateUnknown: true,
    });
  });

  test("session deletion clears own state and parent subagent jobs", () => {
    const background = createBackgroundJobStore();
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [
          {
            kind: "subagent",
            sessionID: "ses_parent",
            childSessionID: "ses_child",
          },
        ],
      },
      10,
    );
    background.recordShellStarted("ses_child", "sh_1", 10);
    background.recordDeleted("ses_child");
    expect(background.backgroundJobFor("ses_parent")).toBeUndefined();
    expect(background.backgroundJobFor("ses_child")).toBeUndefined();
  });

  test("an absent descendant owner is cleared by the next snapshot", () => {
    const background = createBackgroundJobStore();
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [
          {
            kind: "shell",
            sessionID: "ses_child",
            shellID: "sh_1",
          },
        ],
      },
      10,
    );
    expect(background.backgroundJobFor("ses_child")).toEqual({
      kinds: [BACKGROUND_JOB_KIND.shell],
    });
    background.recordIdle({ sessionID: "ses_parent", background: [] }, 20);
    expect(background.backgroundJobFor("ses_child")).toBeUndefined();
  });

  test("a stale deletion cannot lower a newer tombstone", () => {
    const background = createBackgroundJobStore();
    background.recordDeleted("ses_child", 20);
    background.recordDeleted("ses_child", 10);
    background.recordShellStarted("ses_child", "sh_1", 15);
    expect(background.backgroundJobFor("ses_child")).toBeUndefined();
  });

  test("an idle snapshot does not resurrect a deleted subagent job", () => {
    const background = createBackgroundJobStore();
    background.recordDeleted("ses_child", 20);
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [
          {
            kind: "subagent",
            sessionID: "ses_parent",
            childSessionID: "ses_child",
          },
        ],
      },
      15,
    );
    expect(background.backgroundJobFor("ses_parent")).toBeUndefined();
  });

  test("a later idle snapshot does not resurrect a deleted owner", () => {
    const background = createBackgroundJobStore();
    background.recordDeleted("ses_child", 20);
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [
          {
            kind: "shell",
            sessionID: "ses_child",
            shellID: "sh_1",
          },
        ],
      },
      25,
    );
    expect(background.backgroundJobFor("ses_child")).toBeUndefined();
  });

  test("an idle snapshot from a deleted session is ignored", () => {
    const background = createBackgroundJobStore();
    background.recordDeleted("ses_parent", 20);
    background.recordIdle(
      {
        sessionID: "ses_parent",
        background: [
          {
            kind: "shell",
            sessionID: "ses_child",
            shellID: "sh_1",
          },
        ],
      },
      25,
    );
    expect(background.backgroundJobFor("ses_child")).toBeUndefined();
  });
});

const probeContext = (messages: unknown) => ({
  context: async ({ sessionID }: { sessionID: string }) =>
    sessionID === "ses_target" ? messages : [],
});

describe("background probe", () => {
  test("finds a running shell message and a running image tool part", async () => {
    const background = createBackgroundJobStore();
    background.recordIdle({ sessionID: "ses_target", background: [] }, 1);
    const probe = await background.probe({
      session: probeContext([
        { type: "shell", status: "running" },
        {
          type: "assistant",
          content: [
            { type: "tool", name: "generate_image", state: { status: "running" } },
          ],
        },
      ]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(false);
    expect(probe.backgroundJob).toEqual({ kinds: ["shell", "image"] });
  });

  test("recognizes both image tool names", async () => {
    for (const name of ["generate_image", "experimental_image_generate"]) {
      const background = createBackgroundJobStore();
      background.recordIdle({ sessionID: "ses_target", background: [] }, 1);
      const probe = await background.probe({
        session: probeContext([
          {
            type: "assistant",
            content: [{ type: "tool", name, state: { status: "running" } }],
          },
        ]),
        targetID: "ses_target",
      });
      expect(probe.failed).toBe(false);
      expect(probe.backgroundJob).toEqual({ kinds: ["image"] });
    }
  });

  test("finds a running generate_video tool part", async () => {
    const background = createBackgroundJobStore();
    background.recordIdle({ sessionID: "ses_target", background: [] }, 1);
    const probe = await background.probe({
      session: probeContext([
        {
          type: "assistant",
          content: [
            { type: "tool", name: "generate_video", state: { status: "running" } },
          ],
        },
      ]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(false);
    expect(probe.backgroundJob).toEqual({ kinds: ["video"] });
  });

  test("finds a running subagent tool part", async () => {
    const background = createBackgroundJobStore();
    background.recordIdle({ sessionID: "ses_target", background: [] }, 1);
    const probe = await background.probe({
      session: probeContext([
        {
          type: "assistant",
          content: [{ type: "tool", name: "subagent", state: { status: "running" } }],
        },
      ]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(false);
    expect(probe.backgroundJob).toEqual({ kinds: ["subagent"] });
  });

  test("does not parse synthetic report text", async () => {
    const background = createBackgroundJobStore();
    background.recordIdle({ sessionID: "ses_target", background: [] }, 1);
    const probe = await background.probe({
      session: probeContext([
        {
          type: "synthetic",
          text: '<subagent sessionID="ses_target" state="running">\nBackground work still running:\n- shell (sh_1): run\n</subagent>',
          metadata: { source: "subagent", childID: "ses_target" },
        },
      ]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(false);
    expect(probe.backgroundJob).toBeUndefined();
  });

  test("a failed probe sets stateUnknown instead of claiming no job", async () => {
    const background = createBackgroundJobStore();
    const probe = await background.probe({
      session: {
        context: async () => {
          throw new Error("no context");
        },
      },
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(true);
    expect(probe.backgroundJob).toEqual({ kinds: [], stateUnknown: true });
  });

  test("a malformed context sets stateUnknown", async () => {
    const background = createBackgroundJobStore();
    const probe = await background.probe({
      session: probeContext([null, "not a message"]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(true);
    expect(probe.backgroundJob).toEqual({ kinds: [], stateUnknown: true });
  });

  test("known descendant jobs set subtreeActive from the store", async () => {
    const background = createBackgroundJobStore();
    background.recordIdle(
      {
        sessionID: "ses_target",
        background: [
          {
            kind: "shell",
            sessionID: "ses_child",
            shellID: "sh_1",
            command: "run",
          },
        ],
      },
      10,
    );
    const probe = await background.probe({
      session: probeContext([]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(false);
    expect(probe.backgroundJob).toBeUndefined();
    expect(probe.subtreeActive).toBe(true);
  });

  test("stored jobs are included in the probe result", async () => {
    const background = createBackgroundJobStore();
    background.recordIdle(
      {
        sessionID: "ses_target",
        background: [
          {
            kind: "shell",
            sessionID: "ses_target",
            shellID: "sh_1",
            command: "run",
          },
        ],
      },
      10,
    );
    const probe = await background.probe({
      session: probeContext([]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(false);
    expect(probe.backgroundJob).toEqual({ kinds: ["shell"] });
  });

  test("no snapshot and a clean context is stateUnknown", async () => {
    const background = createBackgroundJobStore();
    const probe = await background.probe({
      session: probeContext([]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(true);
    expect(probe.backgroundJob).toEqual({ kinds: [], stateUnknown: true });
  });

  test("no snapshot and an observed shell is shell plus stateUnknown", async () => {
    const background = createBackgroundJobStore();
    const probe = await background.probe({
      session: probeContext([{ type: "shell", status: "running" }]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(true);
    expect(probe.backgroundJob).toEqual({
      kinds: ["shell"],
      stateUnknown: true,
    });
  });

  test("no snapshot keeps stored kinds with stateUnknown", async () => {
    const background = createBackgroundJobStore();
    background.recordShellStarted("ses_target", "sh_1", 10);
    const probe = await background.probe({
      session: probeContext([]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(true);
    expect(probe.backgroundJob).toEqual({
      kinds: ["shell"],
      stateUnknown: true,
    });
  });

  test("a snapshot and a clean context has no job", async () => {
    const background = createBackgroundJobStore();
    background.recordIdle({ sessionID: "ses_target", background: [] }, 10);
    const probe = await background.probe({
      session: probeContext([]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(false);
    expect(probe.backgroundJob).toBeUndefined();
  });

  test("a snapshot and an observed job has no stateUnknown", async () => {
    const background = createBackgroundJobStore();
    background.recordIdle({ sessionID: "ses_target", background: [] }, 10);
    const probe = await background.probe({
      session: probeContext([{ type: "shell", status: "running" }]),
      targetID: "ses_target",
    });
    expect(probe.failed).toBe(false);
    expect(probe.backgroundJob).toEqual({ kinds: ["shell"] });
  });
});

describe("live state and background events", () => {
  test("session.idle does not overwrite a known terminal status", async () => {
    const live = createLiveState();
    const background = createBackgroundJobStore();
    live.rememberTerminal("ses_child", RUN_STATUS.finished, 10);
    await handleEvent(
      { live, background },
      { type: "session.idle", data: { sessionID: "ses_child" }, created: 20 },
    );
    expect(live.liveStatusFor("ses_child")).toBe(RUN_STATUS.finished);
  });

  test("statusFor prefers a terminal session record over a live unknown", async () => {
    const live = createLiveState();
    const background = createBackgroundJobStore();
    live.rememberStarted("ses_child", 5);
    await handleEvent(
      { live, background },
      { type: "session.idle", data: { sessionID: "ses_child" }, created: 20 },
    );
    expect(live.liveStatusFor("ses_child")).toBe(RUN_STATUS.unknown);
    expect(
      live.statusFor(
        {
          id: "ses_child",
          outcome: "succeeded",
          time: { created: 1, updated: 20, idle: 20 },
        },
        "ses_child",
      ),
    ).toBe(RUN_STATUS.finished);
  });

  test("shell events update background state", async () => {
    const live = createLiveState();
    const background = createBackgroundJobStore();
    await handleEvent(
      { live, background },
      {
        type: "session.shell.started",
        data: { sessionID: "ses_child", shell: { id: "sh_1", status: "running" } },
        created: 10,
      },
    );
    expect(background.backgroundJobFor("ses_child")).toEqual({
      kinds: [BACKGROUND_JOB_KIND.shell],
    });
    await handleEvent(
      { live, background },
      {
        type: "session.shell.ended",
        data: { sessionID: "ses_child", shell: { id: "sh_1", status: "exited" } },
        created: 11,
      },
    );
    expect(background.backgroundJobFor("ses_child")).toBeUndefined();
  });

  test("session.deleted clears live and background state", async () => {
    const live = createLiveState();
    const background = createBackgroundJobStore();
    live.rememberTerminal("ses_child", RUN_STATUS.finished, 10);
    background.recordShellStarted("ses_child", "sh_1", 10);
    await handleEvent(
      { live, background },
      { type: "session.deleted", data: { sessionID: "ses_child" }, created: 20 },
    );
    expect(live.liveStatusFor("ses_child")).toBeUndefined();
    expect(background.backgroundJobFor("ses_child")).toBeUndefined();
  });

  test("synthetic events are ignored", async () => {
    const live = createLiveState();
    const background = createBackgroundJobStore();
    background.recordShellStarted("ses_victim", "sh_1", 10);
    live.rememberStarted("ses_victim", 10);
    await handleEvent({ live, background }, {
      type: "session.synthetic",
      data: {
        sessionID: "ses_attacker",
        text: '<subagent sessionID="ses_victim" state="completed">\nBackground work still running:\n- shell (sh_1): run\n</subagent>',
        metadata: { source: "subagent", childID: "ses_victim", state: "completed" },
      },
      created: 20,
    } as any);
    expect(background.backgroundJobFor("ses_victim")).toEqual({
      kinds: [BACKGROUND_JOB_KIND.shell],
    });
    expect(live.liveStatusFor("ses_victim")).toBe(RUN_STATUS.running);
  });
});

describe("idle hook registration", () => {
  test("registers and disposes the experimental idle hook", async () => {
    const h = makeHarness();
    const cleanup = await h.setup();
    expect(h.idleHooks).toHaveLength(1);
    expect(h.idleHooks[0].name).toBe("experimental.idle");
    await cleanup();
    expect(h.hookDisposeCalls).toEqual(["experimental.idle"]);
  });

  test("works when the build exposes no session hook", async () => {
    const h = makeHarness({ noSessionHook: true });
    cleanups.push(await h.setup());
    expect(h.idleHooks).toHaveLength(0);
  });

  test("survives a hook registration failure", async () => {
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const h = makeHarness({ hookError: new Error("no hook") });
      cleanups.push(await h.setup());
      expect(h.idleHooks).toHaveLength(0);
      expect(
        logged.some((args) => String(args[0]).includes("idle hook unavailable")),
      ).toBe(true);
    } finally {
      console.error = original;
    }
  });
});
