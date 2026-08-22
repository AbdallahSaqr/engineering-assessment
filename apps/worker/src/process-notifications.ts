import type { PrismaClient } from "@assessment/database";
import type { NotificationSender } from "./notification-provider.js";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface BatchResult {
  found: number;
  delivered: number;
  failed: number;
}

export async function processNotificationBatch(
  database: PrismaClient,
  sender: NotificationSender,
  logger: WorkerLogger = console,
): Promise<BatchResult> {
  const now = new Date();
  const jobs = await database.notificationJob.findMany({
    where: {
      processedAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });

  let delivered = 0;
  let failed = 0;

  for (const job of jobs) {
    let lastError: string | null = null;

    try {
      const application = await database.loanApplication.findUnique({
        where: { id: job.applicationId },
        include: { customer: true },
      });

      if (!application) {
        throw new Error(`application ${job.applicationId} no longer exists`);
      }

      const payload = JSON.parse(job.payload) as { status: string };
      await sender.sendStatusUpdate({
        idempotencyKey: job.sourceEventId,
        recipient: application.customer.email,
        customerName: application.customer.name,
        applicationId: application.id,
        status: payload.status,
      });

      delivered += 1;
      logger.info(`notification job ${job.id} delivered`);
    } catch (error) {
      failed += 1;
      lastError = error instanceof Error ? error.message : "unknown error";
      logger.error(`notification job ${job.id} failed: ${lastError}`);
    } finally {
      await database.notificationJob.update({
        where: { id: job.id },
        data: {
          attemptCount: { increment: 1 },
          lastError,
          processedAt: new Date(),
        },
      });
    }
  }

  return { found: jobs.length, delivered, failed };
}
