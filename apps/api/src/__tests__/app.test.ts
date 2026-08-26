import { randomUUID } from "node:crypto";
import { prisma } from "@assessment/database";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

async function resetApplication() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "customer-a",
      name: "Test Customer",
      email: "customer@example.test",
      phone: "+201111111111",
      applications: {
        create: {
          id: "application-a",
          status: "SUBMITTED",
          requestedAmountCents: 100_000_00,
          lastEventOccurredAt: new Date("2026-08-20T08:00:00.000Z"),
          history: {
            create: {
              id: randomUUID(),
              status: "SUBMITTED",
              sourceEventId: "initial-event",
              occurredAt: new Date("2026-08-20T08:00:00.000Z"),
            },
          },
        },
      },
    },
  });
}

describe("application API", () => {
  beforeEach(resetApplication);

  it("returns an application with its history", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
      headers: { "x-customer-id": "customer-a" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "application-a",
      status: "SUBMITTED",
      customer: { id: "customer-a" },
      history: [{ status: "SUBMITTED" }],
    });
    await app.close();
  });

  it("records a valid partner event and queues a notification", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "partner-event-1",
        status: "IN_REVIEW",
        occurredAt: "2026-08-20T09:00:00.000Z",
      },
    });

    // 200, not the original 202: the work is committed before the response is
    // written, so 202 ("still pending") misdescribed it. The `outcome` field is
    // now the discriminator between an acceptance and a duplicate.
    // See DECISIONS.md D6 -- this is a breaking change to the partner contract.
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("ACCEPTED");
    expect(response.json().application.status).toBe("IN_REVIEW");
    await expect(
      prisma.applicationStatusHistory.count({
        where: { sourceEventId: "partner-event-1" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationJob.count({
        where: { sourceEventId: "partner-event-1" },
      }),
    ).resolves.toBe(1);
    await app.close();
  });

  it("rejects malformed partner events", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: { eventId: "", status: "UNKNOWN", occurredAt: "yesterday" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
