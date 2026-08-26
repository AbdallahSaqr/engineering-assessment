import type { PrismaClient } from "@assessment/database";

/**
 * Operator access to exhausted notification work.
 *
 * DOMAIN.md: "An operator should be able to inspect and replay exhausted work."
 * See DECISIONS.md D13 — these are exported functions rather than an HTTP
 * endpoint because the service has no operator authentication, and adding a
 * privileged unauthenticated endpoint would be a worse exposure than the access
 * bug already fixed. Moving this behind an authenticated route later is a
 * transport change, not a change to these semantics.
 */

export interface DeadLetterSummary {
  id: string;
  applicationId: string;
  sourceEventId: string;
  type: string;
  attemptCount: number;
  lastError: string | null;
  processedAt: Date | null;
}

export async function listDeadLetters(
  database: PrismaClient,
  limit = 50,
): Promise<DeadLetterSummary[]> {
  const jobs = await database.notificationJob.findMany({
    where: { status: "DEAD_LETTERED" },
    orderBy: { processedAt: "desc" },
    take: limit,
    select: {
      id: true,
      applicationId: true,
      sourceEventId: true,
      type: true,
      attemptCount: true,
      lastError: true,
      processedAt: true,
    },
  });

  return jobs;
}

export class DeadLetterNotFoundError extends Error {
  constructor(jobId: string) {
    super(`No dead-lettered notification job with id ${jobId}`);
    this.name = "DeadLetterNotFoundError";
  }
}

/**
 * Returns a dead-lettered job to the pending queue, eligible immediately.
 *
 * `attemptCount` and `lastError` are deliberately preserved rather than reset.
 * That a job previously exhausted its retries is evidence, and keeping the count
 * means a replayed job gets one further attempt before returning to the
 * dead-letter queue — so replaying does not silently re-trigger a full round of
 * provider calls, and a job that is still broken comes back quickly.
 *
 * Only a dead-lettered job can be replayed: replaying a delivered job would
 * send a customer a duplicate notification, and replaying a pending one would
 * clear a scheduled backoff for no reason.
 */
export async function replayDeadLetter(
  database: PrismaClient,
  jobId: string,
): Promise<void> {
  const updated = await database.notificationJob.updateMany({
    where: { id: jobId, status: "DEAD_LETTERED" },
    data: { status: "PENDING", nextAttemptAt: null, processedAt: null },
  });

  if (updated.count === 0) {
    throw new DeadLetterNotFoundError(jobId);
  }
}
