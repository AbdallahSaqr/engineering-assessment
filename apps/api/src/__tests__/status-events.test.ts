import { randomUUID } from "node:crypto";
import type { StatusEventInput } from "@assessment/contracts";
import { prisma, type PrismaClient } from "@assessment/database";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { recordStatusEvent } from "../application-service.js";

/**
 * Idempotency and atomicity of the partner status-event path.
 *
 * See ISSUES.md #2 and #4, and DECISIONS.md D4/D5/D6.
 */
async function seedApplication() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "customer-partner",
      name: "Partner Test",
      email: "partner@example.test",
      phone: "+201333333333",
      applications: {
        create: [
          {
            id: "application-p",
            status: "SUBMITTED",
            requestedAmountCents: 100_000_00,
            lastEventOccurredAt: new Date("2026-08-20T08:00:00.000Z"),
          },
          {
            id: "application-q",
            status: "SUBMITTED",
            requestedAmountCents: 200_000_00,
            lastEventOccurredAt: new Date("2026-08-20T08:00:00.000Z"),
          },
        ],
      },
    },
  });
}

const EVENT: StatusEventInput = {
  eventId: "partner-event-42",
  status: "IN_REVIEW",
  occurredAt: "2026-08-20T09:00:00.000Z",
  reason: "Documents received",
};

function post(
  app: ReturnType<typeof buildApp>,
  body: object,
  applicationId = "application-p",
) {
  return app.inject({
    method: "POST",
    url: `/v1/applications/${applicationId}/status-events`,
    payload: body,
  });
}

const countsFor = async (eventId: string) => ({
  history: await prisma.applicationStatusHistory.count({
    where: { sourceEventId: eventId },
  }),
  jobs: await prisma.notificationJob.count({ where: { sourceEventId: eventId } }),
});

describe("partner status events", () => {
  beforeEach(seedApplication);

  it("accepts a new event and records exactly one of each effect", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await post(app, EVENT);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "ACCEPTED",
      application: { id: "application-p", status: "IN_REVIEW" },
    });
    await expect(countsFor(EVENT.eventId)).resolves.toEqual({ history: 1, jobs: 1 });
    await app.close();
  });

  it("treats a redelivery of the same event as a duplicate", async () => {
    const app = buildApp({ database: prisma, logger: false });

    const first = await post(app, EVENT);
    const second = await post(app, EVENT);

    expect(first.json().outcome).toBe("ACCEPTED");
    expect(second.json().outcome).toBe("DUPLICATE");
    // The retry succeeds rather than erroring: it is the partner behaving well.
    expect(second.statusCode).toBe(200);

    // The point of the whole exercise: one logical event, one of each effect.
    await expect(countsFor(EVENT.eventId)).resolves.toEqual({ history: 1, jobs: 1 });
    await app.close();
  });

  it("collapses several redeliveries onto a single effect", async () => {
    // Note on what this does and does not prove: SQLite serialises writes, so
    // issuing these together does not produce true database-level concurrency.
    // Instrumenting the service confirmed all three duplicates resolve via the
    // pre-check, never the constraint. This test covers repeated delivery; the
    // test below covers the constraint branch the pre-check cannot reach.
    const app = buildApp({ database: prisma, logger: false });

    const results = await Promise.all([
      post(app, EVENT),
      post(app, EVENT),
      post(app, EVENT),
    ]);

    const outcomes = results.map((r) => r.json().outcome).sort();
    expect(outcomes).toEqual(["ACCEPTED", "DUPLICATE", "DUPLICATE"]);
    await expect(countsFor(EVENT.eventId)).resolves.toEqual({ history: 1, jobs: 1 });
    await app.close();
  });

  it("falls back to the unique constraint when a duplicate races past the pre-check", async () => {
    // The branch that actually guarantees idempotency under concurrency.
    //
    // A real race cannot be produced against SQLite, which serialises writes, so
    // the race *window* is reconstructed instead. The window is the instant when
    // a competing request has inserted its history row but has not yet updated
    // the application: the row exists, so the constraint will fire, but the
    // application still carries its pre-event status, so the ordering and
    // transition checks pass exactly as they would for the losing request.
    //
    // `application-q` is left at SUBMITTED and given that half-written state
    // directly. Blinding the pre-check then makes this call behave like the
    // request that lost the race.
    await prisma.applicationStatusHistory.create({
      data: {
        id: "history-race",
        applicationId: "application-q",
        status: "IN_REVIEW",
        sourceEventId: EVENT.eventId,
        occurredAt: new Date(EVENT.occurredAt),
      },
    });

    const blindToExistingRow = {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        prisma.$transaction((tx) =>
          fn({
            loanApplication: tx.loanApplication,
            notificationJob: tx.notificationJob,
            applicationStatusHistory: {
              ...tx.applicationStatusHistory,
              // As if the competing insert had not become visible yet.
              findFirst: async (args: { orderBy?: unknown }) =>
                args?.orderBy
                  ? tx.applicationStatusHistory.findFirst(args as never)
                  : null,
              create: tx.applicationStatusHistory.create.bind(
                tx.applicationStatusHistory,
              ),
            },
          }),
        ),
    } as unknown as PrismaClient;

    const result = await recordStatusEvent(
      blindToExistingRow,
      "application-q",
      EVENT,
    );

    expect(result.outcome).toBe("DUPLICATE");
    // The losing request left nothing behind: still one history row, no job.
    await expect(
      prisma.applicationStatusHistory.count({
        where: { applicationId: "application-q" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationJob.count({ where: { applicationId: "application-q" } }),
    ).resolves.toBe(0);
  });

  it("does not treat the same event id on a different application as a duplicate", async () => {
    // Deduplication is scoped per application (DECISIONS.md D5), so a partner
    // reusing an identifier elsewhere must not suppress a legitimate event.
    const app = buildApp({ database: prisma, logger: false });

    const onP = await post(app, EVENT, "application-p");
    const onQ = await post(app, EVENT, "application-q");

    expect(onP.json().outcome).toBe("ACCEPTED");
    expect(onQ.json().outcome).toBe("ACCEPTED");
    await expect(countsFor(EVENT.eventId)).resolves.toEqual({ history: 2, jobs: 2 });
    await app.close();
  });

  it("does not expose customer contact details to the partner", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await post(app, EVENT);

    expect(response.body).not.toContain("partner@example.test");
    expect(response.body).not.toContain("+201333333333");
    expect(response.body).not.toContain("Partner Test");
    await app.close();
  });

  it("rolls back every effect when one write in the change fails", async () => {
    // Atomicity (ISSUES.md #4). The three writes and the duplicate check are one
    // logical change; a failure part-way must leave no trace of any of them.
    // A tampered client fails the final write while the real transaction runs.
    const tamperedDatabase = {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        prisma.$transaction((tx) =>
          fn({
            loanApplication: tx.loanApplication,
            applicationStatusHistory: tx.applicationStatusHistory,
            notificationJob: {
              create: async () => {
                throw new Error("simulated notification-job write failure");
              },
            },
          }),
        ),
    } as unknown as PrismaClient;

    await expect(
      recordStatusEvent(tamperedDatabase, "application-p", EVENT),
    ).rejects.toThrow("simulated notification-job write failure");

    const application = await prisma.loanApplication.findUniqueOrThrow({
      where: { id: "application-p" },
    });

    expect(application.status).toBe("SUBMITTED");
    expect(application.lastEventOccurredAt?.toISOString()).toBe(
      "2026-08-20T08:00:00.000Z",
    );
    await expect(countsFor(EVENT.eventId)).resolves.toEqual({ history: 0, jobs: 0 });
  });

  it("still rejects malformed events before any write", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await post(app, {
      eventId: "",
      status: "UNKNOWN",
      occurredAt: "yesterday",
    });

    expect(response.statusCode).toBe(400);
    await expect(prisma.applicationStatusHistory.count()).resolves.toBe(0);
    await app.close();
  });

  it("reports an unknown application without disclosing anything else", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await post(app, EVENT, `no-such-application-${randomUUID()}`);

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
