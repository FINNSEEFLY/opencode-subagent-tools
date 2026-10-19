import { describe, expect, test } from "bun:test"
import { createSendMessage, isDelivery, isSendKind } from "../src/messages"

const makeSend = (
  session: Record<string, unknown> = {},
): ReturnType<typeof createSendMessage> => {
  const sessionValue = {
    prompt: async () => ({ id: "inbox_prompt" }),
    synthetic: async () => ({ id: "inbox_synthetic" }),
    ...session,
  }
  return createSendMessage({
    session: sessionValue as never,
    access: { authorize: async () => ({}) } as never,
    guard: (async () => undefined) as never,
    live: {
      statusFor: () => "finished",
      liveStatusFor: () => undefined,
    } as never,
  })
}

const context = { sessionID: "ses_parent" }

describe("send message dispatch", () => {
  test("recognizes only known deliveries and kinds", () => {
    expect(isDelivery("steer")).toBe(true)
    expect(isDelivery("queue")).toBe(true)
    expect(isDelivery("toString")).toBe(false)
    expect(isSendKind("prompt")).toBe(true)
    expect(isSendKind("synthetic")).toBe(true)
    expect(isSendKind("__proto__")).toBe(false)
  })

  test("dispatches synthetic messages without calling prompt", async () => {
    const calls: string[] = []
    const send = makeSend({
      prompt: async () => {
        calls.push("prompt")
        return { id: "inbox_prompt" }
      },
      synthetic: async () => {
        calls.push("synthetic")
        return { id: "inbox_synthetic" }
      },
    })

    const result = await send(
      { kind: "synthetic", sessionID: "ses_child", text: "note", resume: false },
      context,
      "Context injection",
    )
    expect(calls).toEqual(["synthetic"])
    expect(result.admitted?.id).toBe("inbox_synthetic")
  })

  test("rejects an unknown send kind", async () => {
    const send = makeSend()
    await expect(
      send(
        {
          kind: "bogus" as never,
          sessionID: "ses_child",
          text: "x",
          resume: true,
        },
        context,
        "Send",
      ),
    ).rejects.toThrow("Unsupported send kind")
  })

  test("drops an unknown delivery reported by the server", async () => {
    const send = makeSend({
      prompt: async () => ({ id: "inbox_prompt", delivery: "bogus" }),
    })
    const result = await send(
      {
        kind: "prompt",
        delivery: "steer",
        sessionID: "ses_child",
        text: "x",
        resume: true,
      },
      context,
      "Send",
    )
    expect(result.admitted).toEqual({ id: "inbox_prompt" })
  })
})
