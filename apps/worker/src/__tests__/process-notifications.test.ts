import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@assessment/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listDeadLetters, replayDeadLetter } from "../dead-letters.js";
import type { NotificationSender } from "../notification-provider.js";
import { processNotificationBatch } from "../process-notifications.js";
import { MAX_ATTEMPTS, nextAttemptDelayMs } from "../retry-policy.js";

/**
 * Delivery, retry, dead-lettering and replay.
 *
 * See ISSUES.md #5 and #8, and DECISIONS.md D10-D14.
 *
 * The previous version of this file asserted only that `processedAt` was set
 * after a batch — which was true whether the send succeeded or failed, because
 * the old code stamped it in a `finally` block. That assertion certified the bug
 * as correct behaviour, so it has been removed rather than adapted.
 */
const JOB_ID = "job-under-test";

async function seedJob() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "customer-worker",
      name: "Worker Test",
      email: "worker@example.test",
      phone: "+201222222222",
      applications: {
        create: {
          id: "application-worker",
          status: "IN_REVIEW",
          requestedAmountCents: 50_000_00,
          notificationJobs: {
            create: {
              id: JOB_ID,
              sourceEventId: "worker-event-1",
              type: "APPLICATION_STATUS_CHANGED",
              payload: JSON.stringify({ status: "IN_REVIEW" }),
            },
          },
        },
      },
    },
  });
}

const silentLogger = () => ({ info: vi.fn(), error: vi.fn() });

const succeeds = (): NotificationSender => ({
  sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
});

const fails = (message = "provider unavailable"): NotificationSender => ({
  sendStatusUpdate: vi.fn().mockRejectedValue(new Error(message)),
});

const job = () => prisma.notificationJob.findUniqueOrThrow({ where: { id: JOB_ID } });

/** Make a pending job eligible now, bypassing whatever backoff was scheduled. */
const makeEligible = () =>
  prisma.notificationJob.update({
    where: { id: JOB_ID },
    data: { nextAttemptAt: null },
  });

describe("notification delivery", () => {
  beforeEach(seedJob);

  it("delivers a pending notification and marks it delivered", async () => {
    const sender = succeeds();
    const result = await processNotificationBatch(prisma, sender, silentLogger());

    expect(result).toEqual({
      found: 1,
      delivered: 1,
      retryScheduled: 0,
      deadLettered: 0,
    });

    const stored = await job();
    expect(stored.status).toBe("DELIVERED");
    expect(stored.attemptCount).toBe(1);
    expect(stored.lastError).toBeNull();
    expect(stored.processedAt).toBeInstanceOf(Date);
  });

  it("sends an idempotency key that distinguishes notification types", async () => {
    // Previously the key was `sourceEventId` alone, so two different messages
    // about one event would collide (DECISIONS.md D14).
    const sender = succeeds();
    await processNotificationBatch(prisma, sender, silentLogger());

    expect(sender.sendStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey:
          "application-worker:worker-event-1:APPLICATION_STATUS_CHANGED",
        recipient: "worker@example.test",
      }),
    );
  });
});

describe("notification retry", () => {
  beforeEach(seedJob);

  it("does not mark a failed delivery as delivered", async () => {
    // The core regression. The old code set processedAt in a `finally` block, so
    // this job would have been recorded as complete and never seen again.
    const result = await processNotificationBatch(prisma, fails(), silentLogger());

    expect(result).toEqual({
      found: 1,
      delivered: 0,
      retryScheduled: 1,
      deadLettered: 0,
    });

    const stored = await job();
    expect(stored.status).toBe("PENDING");
    expect(stored.processedAt).toBeNull();
    expect(stored.attemptCount).toBe(1);
    expect(stored.lastError).toBe("provider unavailable");
  });

  it("schedules a failed delivery for a later attempt", async () => {
    await processNotificationBatch(prisma, fails(), silentLogger());

    const stored = await job();
    expect(stored.nextAttemptAt).toBeInstanceOf(Date);
    expect(stored.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(Date.now() - 50);
  });

  it("leaves a job alone until its backoff has elapsed", async () => {
    await prisma.notificationJob.update({
      where: { id: JOB_ID },
      data: { nextAttemptAt: new Date(Date.now() + 60_000) },
    });

    const sender = succeeds();
    const result = await processNotificationBatch(prisma, sender, silentLogger());

    expect(result.found).toBe(0);
    expect(sender.sendStatusUpdate).not.toHaveBeenCalled();
  });

  it("recovers when a later attempt succeeds", async () => {
    await processNotificationBatch(prisma, fails(), silentLogger());
    await makeEligible();

    const result = await processNotificationBatch(prisma, succeeds(), silentLogger());

    expect(result.delivered).toBe(1);
    const stored = await job();
    expect(stored.status).toBe("DELIVERED");
    expect(stored.attemptCount).toBe(2);
    // The failure that preceded the success is cleared once it is resolved.
    expect(stored.lastError).toBeNull();
  });

  it("stops retrying after the bounded number of attempts", async () => {
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const result = await processNotificationBatch(prisma, fails(), silentLogger());
      expect(result.retryScheduled).toBe(1);
      await makeEligible();
    }

    const final = await processNotificationBatch(prisma, fails(), silentLogger());
    expect(final.deadLettered).toBe(1);

    const stored = await job();
    expect(stored.status).toBe("DEAD_LETTERED");
    expect(stored.attemptCount).toBe(MAX_ATTEMPTS);
    expect(stored.nextAttemptAt).toBeNull();

    // And it is not picked up again.
    const afterwards = await processNotificationBatch(prisma, succeeds(), silentLogger());
    expect(afterwards.found).toBe(0);
  });

  it("dead-letters an unreadable payload immediately rather than retrying it", async () => {
    // A stored payload that will not parse will not parse on the fifth attempt
    // either, so spending the retry budget on it only delays the operator
    // seeing the problem. `payload` is a String column, so this is reachable.
    await prisma.notificationJob.update({
      where: { id: JOB_ID },
      data: { payload: "not json" },
    });

    const sender = succeeds();
    const result = await processNotificationBatch(prisma, sender, silentLogger());

    expect(result).toEqual({
      found: 1,
      delivered: 0,
      retryScheduled: 0,
      deadLettered: 1,
    });
    expect(sender.sendStatusUpdate).not.toHaveBeenCalled();

    const stored = await job();
    expect(stored.status).toBe("DEAD_LETTERED");
    // Dead on the first attempt, not after exhausting the budget.
    expect(stored.attemptCount).toBe(1);
    expect(stored.lastError).toContain("unreadable payload");
  });

  it("dead-letters a job whose application has vanished", async () => {
    // Note on reachability: under the current schema this cannot happen. A
    // foreign key stops a job pointing at a missing application, and the
    // relation cascades on delete, so removing an application removes its jobs
    // with it. Attempting to set up this state through Prisma fails with
    // "FOREIGN KEY constraint failed", which is how that was discovered.
    //
    // The guard is kept as defence in depth -- against foreign keys being
    // disabled, a restore from an inconsistent backup, or a future schema
    // without the cascade -- so it is exercised through a stubbed read rather
    // than by corrupting the database.
    const applicationVanished = {
      notificationJob: prisma.notificationJob,
      loanApplication: { findUnique: async () => null },
    } as unknown as PrismaClient;

    const sender = succeeds();
    const result = await processNotificationBatch(
      applicationVanished,
      sender,
      silentLogger(),
    );

    expect(result.deadLettered).toBe(1);
    expect(sender.sendStatusUpdate).not.toHaveBeenCalled();

    const stored = await job();
    expect(stored.status).toBe("DEAD_LETTERED");
    expect(stored.attemptCount).toBe(1);
    expect(stored.lastError).toContain("no longer exists");
  });
});

describe("retry schedule", () => {
  it("grows the delay ceiling exponentially with the attempt count", () => {
    const atCeiling = () => 1;

    expect(nextAttemptDelayMs(1, atCeiling)).toBe(1_000);
    expect(nextAttemptDelayMs(2, atCeiling)).toBe(2_000);
    expect(nextAttemptDelayMs(3, atCeiling)).toBe(4_000);
    expect(nextAttemptDelayMs(4, atCeiling)).toBe(8_000);
  });

  it("caps the delay so late attempts do not drift arbitrarily far out", () => {
    expect(nextAttemptDelayMs(50, () => 1)).toBe(5 * 60 * 1_000);
  });

  it("jitters within the ceiling so a failed batch does not retry in lockstep", () => {
    // Without this, every job failing in the same provider outage would compute
    // an identical delay and retry in the same instant (DECISIONS.md D11).
    const delays = [0, 0.25, 0.5, 0.75].map((r) => nextAttemptDelayMs(3, () => r));

    expect(delays).toEqual([0, 1_000, 2_000, 3_000]);
    expect(new Set(delays).size).toBe(4);
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(4_000);
    }
  });
});

describe("dead letters", () => {
  beforeEach(seedJob);

  async function exhaust() {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await processNotificationBatch(prisma, fails(), silentLogger());
      await makeEligible();
    }
  }

  it("lists exhausted work for an operator", async () => {
    await exhaust();

    const deadLetters = await listDeadLetters(prisma);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      id: JOB_ID,
      applicationId: "application-worker",
      attemptCount: MAX_ATTEMPTS,
      lastError: "provider unavailable",
    });
  });

  it("returns a replayed job to the queue, keeping its history", async () => {
    await exhaust();
    await replayDeadLetter(prisma, JOB_ID);

    const stored = await job();
    expect(stored.status).toBe("PENDING");
    expect(stored.processedAt).toBeNull();
    // Preserved deliberately: the job is visibly on its second life.
    expect(stored.attemptCount).toBe(MAX_ATTEMPTS);
    expect(stored.lastError).toBe("provider unavailable");

    const result = await processNotificationBatch(prisma, succeeds(), silentLogger());
    expect(result.delivered).toBe(1);
  });

  it("returns a replayed job that fails again straight to the dead letters", async () => {
    await exhaust();
    await replayDeadLetter(prisma, JOB_ID);

    const result = await processNotificationBatch(prisma, fails(), silentLogger());
    expect(result.deadLettered).toBe(1);
    expect((await job()).status).toBe("DEAD_LETTERED");
  });

  it("refuses to replay a job that is not dead-lettered", async () => {
    // Replaying a delivered job would send the customer a duplicate.
    await processNotificationBatch(prisma, succeeds(), silentLogger());

    await expect(replayDeadLetter(prisma, JOB_ID)).rejects.toThrow(
      /No dead-lettered notification job/,
    );
    expect((await job()).status).toBe("DELIVERED");
  });

  it("reports an unknown job id rather than failing silently", async () => {
    await expect(replayDeadLetter(prisma, randomUUID())).rejects.toThrow(
      /No dead-lettered notification job/,
    );
  });
});
