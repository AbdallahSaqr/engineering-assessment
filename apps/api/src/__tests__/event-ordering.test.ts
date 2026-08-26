import type { StatusEventInput } from "@assessment/contracts";
import { prisma } from "@assessment/database";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

/**
 * Ordering and transition validity for partner status events.
 *
 * See ISSUES.md #3 and #6, and DECISIONS.md D7/D8/D9.
 */
async function seedApplication() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "customer-order",
      name: "Ordering Test",
      email: "order@example.test",
      phone: "+201444444444",
      applications: {
        create: {
          id: "application-o",
          status: "SUBMITTED",
          requestedAmountCents: 100_000_00,
          lastEventOccurredAt: new Date("2026-08-20T08:00:00.000Z"),
          history: {
            create: {
              id: "history-seed",
              status: "SUBMITTED",
              sourceEventId: "seed-event",
              occurredAt: new Date("2026-08-20T08:00:00.000Z"),
            },
          },
        },
      },
    },
  });
}

function event(overrides: Partial<StatusEventInput>): StatusEventInput {
  return {
    eventId: `event-${Math.random().toString(36).slice(2)}`,
    status: "IN_REVIEW",
    occurredAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  } as StatusEventInput;
}

function post(app: ReturnType<typeof buildApp>, body: object) {
  return app.inject({
    method: "POST",
    url: "/v1/applications/application-o/status-events",
    payload: body,
  });
}

const currentStatus = async () =>
  (
    await prisma.loanApplication.findUniqueOrThrow({
      where: { id: "application-o" },
    })
  ).status;

describe("event ordering", () => {
  beforeEach(seedApplication);

  it("accepts an event newer than everything recorded", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await post(app, event({ occurredAt: "2026-08-20T09:00:00.000Z" }));

    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("ACCEPTED");
    await expect(currentStatus()).resolves.toBe("IN_REVIEW");
    await app.close();
  });

  it("does not let a late older event rewind the current status", async () => {
    const app = buildApp({ database: prisma, logger: false });

    // Forward to APPROVED via the legal path.
    await post(app, event({ status: "IN_REVIEW", occurredAt: "2026-08-20T12:00:00.000Z" }));
    await post(app, event({ status: "OFFERED", occurredAt: "2026-08-20T13:00:00.000Z" }));
    await post(app, event({ status: "APPROVED", occurredAt: "2026-08-20T14:00:00.000Z" }));
    await expect(currentStatus()).resolves.toBe("APPROVED");

    // A message sent that morning, delayed in the network, arrives now.
    const late = await post(
      app,
      event({ status: "IN_REVIEW", occurredAt: "2026-08-20T09:00:00.000Z" }),
    );

    expect(late.json().outcome).toBe("STALE");
    // Late delivery is the network behaving normally, not a partner fault.
    expect(late.statusCode).toBe(200);
    await expect(currentStatus()).resolves.toBe("APPROVED");
    await app.close();
  });

  it("gives a stale event no effect on customer-visible history", async () => {
    const app = buildApp({ database: prisma, logger: false });
    await post(app, event({ status: "IN_REVIEW", occurredAt: "2026-08-20T12:00:00.000Z" }));

    const before = await prisma.applicationStatusHistory.count();
    const stale = await post(
      app,
      event({ status: "OFFERED", occurredAt: "2026-08-20T09:00:00.000Z" }),
    );

    expect(stale.json().outcome).toBe("STALE");
    await expect(prisma.applicationStatusHistory.count()).resolves.toBe(before);
    await expect(prisma.notificationJob.count()).resolves.toBe(1);
    await app.close();
  });

  it("accepts an event whose timestamp ties with the newest recorded one", async () => {
    // A tie is not older. True redeliveries are caught by event id, so an equal
    // timestamp under a different id is a distinct event (DECISIONS.md D7).
    const app = buildApp({ database: prisma, logger: false });
    const response = await post(
      app,
      event({ status: "IN_REVIEW", occurredAt: "2026-08-20T08:00:00.000Z" }),
    );

    expect(response.json().outcome).toBe("ACCEPTED");
    await expect(currentStatus()).resolves.toBe("IN_REVIEW");
    await app.close();
  });
});

describe("transition validity", () => {
  beforeEach(seedApplication);

  it("permits the documented forward path end to end", async () => {
    const app = buildApp({ database: prisma, logger: false });

    for (const [index, status] of [
      "IN_REVIEW",
      "OFFERED",
      "APPROVED",
      "DISBURSED",
    ].entries()) {
      const response = await post(
        app,
        event({ status, occurredAt: `2026-08-2${index + 1}T10:00:00.000Z` } as never),
      );
      expect(response.json().outcome).toBe("ACCEPTED");
    }

    await expect(currentStatus()).resolves.toBe("DISBURSED");
    await app.close();
  });

  it("rejects a status change after a terminal state", async () => {
    // The regression that motivated this rule: a declined loan being disbursed.
    const app = buildApp({ database: prisma, logger: false });

    await post(app, event({ status: "DECLINED", occurredAt: "2026-08-20T11:00:00.000Z" }));
    await expect(currentStatus()).resolves.toBe("DECLINED");

    const response = await post(
      app,
      event({ status: "DISBURSED", occurredAt: "2026-08-20T12:00:00.000Z" }),
    );

    expect(response.json().outcome).toBe("INVALID_TRANSITION");
    // Unlike a duplicate or a stale event, this is genuinely wrong.
    expect(response.statusCode).toBe(409);
    await expect(currentStatus()).resolves.toBe("DECLINED");
    await app.close();
  });

  it("rejects reaching DISBURSED without passing through the checks", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await post(
      app,
      event({ status: "DISBURSED", occurredAt: "2026-08-20T11:00:00.000Z" }),
    );

    expect(response.json().outcome).toBe("INVALID_TRANSITION");
    expect(response.statusCode).toBe(409);
    await expect(currentStatus()).resolves.toBe("SUBMITTED");
    await app.close();
  });

  it("permits a decline late in the lifecycle", async () => {
    // The assumption recorded in DECISIONS.md D8: a failed final check must be
    // recordable, or the application freezes at OFFERED forever.
    const app = buildApp({ database: prisma, logger: false });

    await post(app, event({ status: "IN_REVIEW", occurredAt: "2026-08-20T11:00:00.000Z" }));
    await post(app, event({ status: "OFFERED", occurredAt: "2026-08-20T12:00:00.000Z" }));

    const response = await post(
      app,
      event({ status: "DECLINED", occurredAt: "2026-08-20T13:00:00.000Z" }),
    );

    expect(response.json().outcome).toBe("ACCEPTED");
    await expect(currentStatus()).resolves.toBe("DECLINED");
    await app.close();
  });

  it("rejects a repeat of the current status under a new event id", async () => {
    // Judgement call, recorded as an open question in PLAN.md: the documented
    // graph has no self-loops, so this is rejected -- but a partner may send
    // repeated same-status updates carrying a new reason.
    const app = buildApp({ database: prisma, logger: false });

    const response = await post(
      app,
      event({ status: "SUBMITTED", occurredAt: "2026-08-20T11:00:00.000Z" }),
    );

    expect(response.json().outcome).toBe("INVALID_TRANSITION");
    await app.close();
  });

  it("leaves no trace of a rejected transition", async () => {
    const app = buildApp({ database: prisma, logger: false });
    await post(app, event({ status: "DISBURSED", occurredAt: "2026-08-20T11:00:00.000Z" }));

    await expect(prisma.applicationStatusHistory.count()).resolves.toBe(1);
    await expect(prisma.notificationJob.count()).resolves.toBe(0);
    await app.close();
  });
});
