import type { PrismaClient } from "@assessment/database";
import type { NotificationSender } from "./notification-provider.js";
import {
  MAX_ATTEMPTS,
  PermanentNotificationError,
  nextAttemptDelayMs,
} from "./retry-policy.js";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface BatchResult {
  found: number;
  delivered: number;
  retryScheduled: number;
  deadLettered: number;
}

const BATCH_SIZE = 20;

/**
 * Idempotency key sent to the provider.
 *
 * The natural key of the notification, matching the uniqueness scope chosen in
 * DECISIONS.md D5. It was previously `sourceEventId` alone, which collides
 * across notification types: two different messages about one event would share
 * a key, and a provider honouring it would suppress the second.
 *
 * Preferred over the job's own id because it stays stable if a job row is ever
 * recreated for the same logical notification — the key has to survive that to
 * be worth carrying at all.
 */
function idempotencyKeyFor(job: {
  applicationId: string;
  sourceEventId: string;
  type: string;
}): string {
  return `${job.applicationId}:${job.sourceEventId}:${job.type}`;
}

export async function processNotificationBatch(
  database: PrismaClient,
  sender: NotificationSender,
  logger: WorkerLogger = console,
): Promise<BatchResult> {
  const now = new Date();
  const jobs = await database.notificationJob.findMany({
    where: {
      status: "PENDING",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });

  let delivered = 0;
  let retryScheduled = 0;
  let deadLettered = 0;

  for (const job of jobs) {
    const attemptCount = job.attemptCount + 1;

    try {
      const application = await database.loanApplication.findUnique({
        where: { id: job.applicationId },
        include: { customer: true },
      });

      if (!application) {
        // No number of retries makes a deleted row reappear.
        throw new PermanentNotificationError(
          `application ${job.applicationId} no longer exists`,
        );
      }

      let payload: { status: string };
      try {
        payload = JSON.parse(job.payload) as { status: string };
      } catch {
        // Malformed stored payload will not become well-formed later.
        throw new PermanentNotificationError(
          `notification job ${job.id} has an unreadable payload`,
        );
      }

      await sender.sendStatusUpdate({
        idempotencyKey: idempotencyKeyFor(job),
        recipient: application.customer.email,
        customerName: application.customer.name,
        applicationId: application.id,
        status: payload.status,
      });

      // Only a successful send marks the job terminal. The previous version did
      // this in a `finally` block, so a failure was recorded as a delivery and
      // the job was never seen again (ISSUES.md #5).
      await database.notificationJob.update({
        where: { id: job.id },
        data: {
          status: "DELIVERED",
          attemptCount,
          nextAttemptAt: null,
          processedAt: new Date(),
          lastError: null,
        },
      });

      delivered += 1;
      logger.info(`notification job ${job.id} delivered on attempt ${attemptCount}`);
    } catch (error) {
      const lastError =
        error instanceof Error ? error.message : "unknown error";
      const isPermanent = error instanceof PermanentNotificationError;
      const isExhausted = attemptCount >= MAX_ATTEMPTS;

      if (isPermanent || isExhausted) {
        await database.notificationJob.update({
          where: { id: job.id },
          data: {
            status: "DEAD_LETTERED",
            attemptCount,
            nextAttemptAt: null,
            processedAt: new Date(),
            lastError,
          },
        });

        deadLettered += 1;
        logger.error(
          `notification job ${job.id} dead-lettered after ${attemptCount} attempt(s)` +
            `${isPermanent ? " (permanent failure)" : ""}: ${lastError}`,
        );
        continue;
      }

      const delayMs = nextAttemptDelayMs(attemptCount);
      await database.notificationJob.update({
        where: { id: job.id },
        data: {
          status: "PENDING",
          attemptCount,
          nextAttemptAt: new Date(Date.now() + delayMs),
          lastError,
        },
      });

      retryScheduled += 1;
      logger.error(
        `notification job ${job.id} failed on attempt ${attemptCount}, ` +
          `retrying in ${delayMs}ms: ${lastError}`,
      );
    }
  }

  return { found: jobs.length, delivered, retryScheduled, deadLettered };
}
