import type { Plugin } from "@opencode/plugin";
import type { Access } from "./access";
import {
  isSessionActive,
  type BackgroundJobInfo,
  type BackgroundJobStore,
} from "./background";
import { errorMessage } from "./errors";
import type { LiveStore } from "./live-state";
import type { Guard } from "./permissions";
import { guardTarget } from "./permissions";
import { RUN_STATUS, runStatusIsIdle, type RunStatus } from "./status";
import type { ToolCtx } from "./tools/input";

export const DELIVERY = {
  steer: "steer",
  queue: "queue",
} as const;

export type Delivery = (typeof DELIVERY)[keyof typeof DELIVERY];

export const DELIVERIES: readonly Delivery[] = Object.values(DELIVERY);
const DELIVERY_SET: ReadonlySet<string> = new Set(DELIVERIES);

export const isDelivery = (value: unknown): value is Delivery =>
  typeof value === "string" && DELIVERY_SET.has(value);

export const SEND_KIND = {
  prompt: "prompt",
  synthetic: "synthetic",
} as const;

export type SendKind = (typeof SEND_KIND)[keyof typeof SEND_KIND];

export const SEND_KINDS: readonly SendKind[] = Object.values(SEND_KIND);
const SEND_KIND_SET: ReadonlySet<string> = new Set(SEND_KINDS);

export const isSendKind = (value: unknown): value is SendKind =>
  typeof value === "string" && SEND_KIND_SET.has(value);

export const CONTEXT_DELIVERY = "next-step" as const;

/** Metadata source for context notes injected by this plugin. Never `subagent`. */
export const CONTEXT_METADATA_SOURCE = "subagent-tools" as const;

export type MessageMetadata = Record<string, string | number | boolean | null>;

export interface SendResultFields {
  messageID?: string;
  status?: RunStatus;
  active?: boolean;
  backgroundJob?: BackgroundJobInfo;
  queued?: boolean;
  pending?: boolean;
}

export interface SendRequestBase {
  sessionID: string;
  text: string;
  resume: boolean;
}

export type SendRequest =
  | (SendRequestBase & { kind: typeof SEND_KIND.prompt; delivery: Delivery })
  | (SendRequestBase & {
      kind: typeof SEND_KIND.synthetic;
      delivery?: never;
      description?: string;
      metadata?: MessageMetadata;
    });

export class SendAdmissionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SendAdmissionError";
  }
}

export interface AdmittedMessage {
  id?: string;
  delivery?: Delivery;
  text?: string;
}

export interface SendResult {
  admitted?: AdmittedMessage;
  status?: RunStatus;
  active?: boolean;
  backgroundJob?: BackgroundJobInfo;
  queued?: boolean;
  pending: boolean;
}

const admittedFrom = (value: unknown): AdmittedMessage | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const item = value as {
    id?: unknown;
    delivery?: unknown;
    payload?: { text?: unknown };
  };
  const admitted: AdmittedMessage = {};
  if (typeof item.id === "string" && item.id.length > 0) admitted.id = item.id;
  if (isDelivery(item.delivery)) admitted.delivery = item.delivery;
  if (typeof item.payload?.text === "string") admitted.text = item.payload.text;
  return Object.keys(admitted).length > 0 ? admitted : undefined;
};

export const applySendResult = <T extends SendResultFields>(
  output: T,
  result: SendResult,
): T => {
  if (result.admitted?.id) output.messageID = result.admitted.id;
  if (result.status) output.status = result.status;
  if (result.active !== undefined) output.active = result.active;
  if (result.backgroundJob) output.backgroundJob = result.backgroundJob;
  if (result.queued !== undefined) output.queued = result.queued;
  if (result.pending) output.pending = true;
  return output;
};

export interface SendDeps {
  session: Plugin.Context["session"];
  access: Access;
  guard: Guard;
  live: LiveStore;
  background: BackgroundJobStore;
}

type SendHandler = (
  request: SendRequest,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

const createSendHandlers = (
  session: Plugin.Context["session"],
): ReadonlyMap<SendKind, SendHandler> => {
  const handlers: Record<SendKind, SendHandler> = {
    [SEND_KIND.prompt]: (request, signal) =>
      session.prompt(
        {
          sessionID: request.sessionID,
          text: request.text,
          delivery: request.kind === SEND_KIND.prompt ? request.delivery : undefined,
          resume: request.resume,
        },
        { signal },
      ),
    [SEND_KIND.synthetic]: (request, signal) =>
      session.synthetic(
        {
          sessionID: request.sessionID,
          text: request.text,
          description:
            request.kind === SEND_KIND.synthetic ? request.description : undefined,
          metadata: request.kind === SEND_KIND.synthetic ? request.metadata : undefined,
          resume: request.resume,
        },
        { signal },
      ),
  };
  return new Map(Object.entries(handlers) as Array<[SendKind, SendHandler]>);
};

/**
 * Shared admission path for `steer`, `queue`, and `context`.
 * `prompt` admits a user message; `synthetic` admits a context-only note.
 */
export const createSendMessage = ({
  session,
  access,
  guard,
  live,
  background,
}: SendDeps) => {
  const sendHandlers = createSendHandlers(session);

  return async (
    request: SendRequest,
    context: ToolCtx,
    failureLabel: string,
  ): Promise<SendResult> => {
    const info = await access.authorize(request.sessionID, context);
    if (context?.signal?.aborted) {
      throw new SendAdmissionError("Aborted before the message was accepted.");
    }
    await guard([guardTarget(info, request.sessionID)], context);
    if (context?.signal?.aborted) {
      throw new SendAdmissionError("Aborted before the message was accepted.");
    }

    const handler = sendHandlers.get(request.kind);
    if (!handler) {
      throw new SendAdmissionError(`Unsupported send kind: ${String(request.kind)}`);
    }

    // Snapshot the observed target before admission: waking a child can change
    // its status immediately, while the output describes the state that led to
    // the queued/pending decision.
    const status = info
      ? live.statusFor(info, request.sessionID)
      : live.liveStatusFor(request.sessionID);
    const backgroundJob = background.backgroundJobFor(request.sessionID);
    const active = isSessionActive(status, backgroundJob);
    // `unknown` is not idle: the session may still be running, so a message
    // without resume cannot be reported as pending.
    const pending = runStatusIsIdle(status) && !request.resume;
    // Queue waits for the current execution, not background jobs. It is queued
    // when the target is not idle, or when an idle target was not woken.
    const queued =
      request.kind === SEND_KIND.prompt && request.delivery === DELIVERY.queue
        ? status === undefined ||
          status === RUN_STATUS.running ||
          status === RUN_STATUS.unknown ||
          !request.resume
        : undefined;

    let admitted: unknown;
    try {
      admitted = await handler(request, context?.signal);
    } catch (error) {
      if (context?.signal?.aborted) {
        throw new SendAdmissionError(
          "Aborted while accepting the message; it may or may not have been accepted.",
          {
            cause: error,
          },
        );
      }
      throw new SendAdmissionError(
        `${failureLabel} failed for ${request.sessionID}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    return {
      admitted: admittedFrom(admitted),
      status,
      active,
      ...(backgroundJob ? { backgroundJob } : {}),
      ...(queued !== undefined ? { queued } : {}),
      pending,
    };
  };
};

export type SendMessage = ReturnType<typeof createSendMessage>;
