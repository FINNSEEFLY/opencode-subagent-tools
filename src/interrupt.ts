export const INTERRUPT_OUTCOME = {
  accepted: "accepted",
  rejected: "rejected",
  failed: "failed",
  unknown: "unknown",
} as const

export type InterruptOutcome = (typeof INTERRUPT_OUTCOME)[keyof typeof INTERRUPT_OUTCOME]

export type InterruptResponse = { interrupted?: boolean } | undefined

/** Map the server's optional boolean to an outcome. `failed` is a thrown call. */
export const interruptOutcome = (
  result: InterruptResponse,
): Exclude<InterruptOutcome, "failed"> =>
  result?.interrupted === true
    ? INTERRUPT_OUTCOME.accepted
    : result?.interrupted === false
      ? INTERRUPT_OUTCOME.rejected
      : INTERRUPT_OUTCOME.unknown
