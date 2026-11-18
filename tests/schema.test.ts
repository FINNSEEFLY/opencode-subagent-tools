import { describe, expect, test } from "bun:test";
import { cleanups, createChild, makeHarness, sessionInfo } from "./harness";
import { validateSchema } from "./schema";

const calls: Array<[string, Record<string, unknown>]> = [
  ["list", {}],
  ["usage", { sessionID: "ses_child", includeDescendants: true }],
  ["steer", { sessionID: "ses_child", text: "go" }],
  ["queue", { sessionID: "ses_child", text: "next" }],
  ["context", { sessionID: "ses_child", text: "note" }],
  ["cancel_descendants", {}],
  ["cancel", { sessionID: "ses_child" }],
];

describe("tool output schemas", () => {
  test("representative outputs match the registered schemas", async () => {
    const h = makeHarness();
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    createChild(h, "ses_grand", "ses_child");
    cleanups.push(await h.setup());
    await h.fireIdle("ses_child", [
      {
        kind: "shell",
        sessionID: "ses_child",
        shellID: "sh_1",
        command: "run",
      },
      {
        kind: "codemode",
        sessionID: "ses_child",
        jobID: "cm_1",
      },
    ]);

    const context = { sessionID: "ses_parent" };
    for (const [name, input] of calls) {
      const tool = h.tools.get(name);
      const result = await tool.execute({ ...input, format: "json" }, context);
      expect(result.output).toBeDefined();
      expect(validateSchema(result.output, tool.output)).toEqual([]);
    }
  });

  test("validates an unknown background state", async () => {
    const h = makeHarness();
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    cleanups.push(await h.setup());
    await h.fireIdle("ses_child", [{ kind: "future-kind", sessionID: "ses_child" }]);

    const tool = h.tools.get("list");
    const result = await tool.execute({ format: "json" }, { sessionID: "ses_parent" });
    expect(result.output.rows[0].backgroundJob).toEqual({
      kinds: [],
      stateUnknown: true,
    });
    expect(validateSchema(result.output, tool.output)).toEqual([]);
  });

  test("validates the direct schema in json-only mode", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["json"] } });
    h.sessions.set(
      "ses_child",
      sessionInfo("ses_child", "ses_parent", {
        outcome: "succeeded",
        time: { created: 1, updated: 2, idle: 2 },
      }),
    );
    createChild(h, "ses_grand", "ses_child");
    cleanups.push(await h.setup());
    await h.fireIdle("ses_child", [
      {
        kind: "shell",
        sessionID: "ses_child",
        shellID: "sh_1",
        command: "run",
      },
      {
        kind: "codemode",
        sessionID: "ses_child",
        jobID: "cm_1",
      },
    ]);

    const context = { sessionID: "ses_parent" };
    for (const [name, input] of calls) {
      const tool = h.tools.get(name);
      expect(tool.output.anyOf).toBeUndefined();
      const result = await tool.execute(input, context);
      expect(validateSchema(result.output, tool.output)).toEqual([]);
    }
  });

  test("the validator catches missing, wrong, and extra fields", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    };
    expect(validateSchema({ id: "x" }, schema)).toEqual([]);
    expect(validateSchema({}, schema)).not.toEqual([]);
    expect(validateSchema({ id: 1 }, schema)).not.toEqual([]);
    expect(validateSchema({ id: "x", extra: true }, schema)).not.toEqual([]);
  });
});
