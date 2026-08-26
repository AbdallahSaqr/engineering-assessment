/**
 * Retry policy for notification delivery.
 *
 * See DECISIONS.md D11 and D12. DOMAIN.md requires a *bounded* retry policy,
 * which needs two bounds: a ceiling on the delay and a limit on attempts.
 */

export const NOTIFICATION_JOB_STATUSES = [
  "PENDING",
  "DELIVERED",
  "DEAD_LETTERED",
] as const;

export type NotificationJobStatus = (typeof NOTIFICATION_JOB_STATUSES)[number];

/** Attempts after which a job is dead-lettered rather than retried again. */
export const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS ?? 5);

/** Delay ceiling for the first retry; doubles per attempt from here. */
export const BASE_DELAY_MS = Number(process.env.WORKER_RETRY_BASE_MS ?? 1_000);

/** Upper bound on the computed ceiling, so late attempts do not drift away. */
export const MAX_DELAY_MS = Number(
  process.env.WORKER_RETRY_MAX_DELAY_MS ?? 5 * 60 * 1_000,
);

/**
 * Delay before the next attempt, using full jitter.
 *
 * The ceiling grows exponentially with the attempt count; the actual delay is a
 * random value below it. The randomness is the point rather than a detail: a
 * provider outage fails a whole batch within the same second, and without jitter
 * every job in that batch would compute an identical delay and retry in the same
 * instant — recreating the load spike the backoff exists to spread out.
 *
 * `random` is injectable so the schedule can be asserted deterministically.
 */
export function nextAttemptDelayMs(
  attemptCount: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attemptCount - 1);
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
  return Math.round(random() * ceiling);
}

/**
 * A failure that will never succeed on a later attempt.
 *
 * Deliberately narrow. Misclassifying a permanent failure as transient only
 * wastes attempts; misclassifying a transient one as permanent loses a customer
 * notification, so only failures that are definitionally permanent throw this.
 */
export class PermanentNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentNotificationError";
  }
}
