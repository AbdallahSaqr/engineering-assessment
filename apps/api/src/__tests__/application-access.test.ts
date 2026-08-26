import { randomUUID } from "node:crypto";
import { prisma } from "@assessment/database";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

/**
 * Ownership and disclosure tests for the customer read path.
 *
 * See ISSUES.md #1 and DECISIONS.md D1/D2. Two customers exist: one owns an
 * application, the other owns nothing and stands in for any caller who supplies
 * an identity that is not entitled to the record.
 */
async function seedTwoCustomers() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "customer-owner",
      name: "Owning Customer",
      email: "owner@example.test",
      phone: "+201111111111",
      applications: {
        create: {
          id: "application-owned",
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

  await prisma.customer.create({
    data: {
      id: "customer-other",
      name: "Other Customer",
      email: "other@example.test",
      phone: "+201222222222",
    },
  });
}

function get(app: ReturnType<typeof buildApp>, url: string, customerId?: string) {
  return app.inject({
    method: "GET",
    url,
    headers: customerId === undefined ? {} : { "x-customer-id": customerId },
  });
}

describe("customer application access", () => {
  beforeEach(seedTwoCustomers);

  it("returns the application to the customer who owns it", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await get(app, "/v1/applications/application-owned", "customer-owner");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "application-owned",
      customer: { id: "customer-owner" },
    });
    await app.close();
  });

  it("does not return another customer's application", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await get(app, "/v1/applications/application-owned", "customer-other");

    expect(response.statusCode).toBe(404);
    // The specific regression: the owner's contact details must not appear.
    expect(response.body).not.toContain("owner@example.test");
    expect(response.body).not.toContain("+201111111111");
    await app.close();
  });

  it("does not accept an unrecognised identity as a substitute for ownership", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await get(app, "/v1/applications/application-owned", "literally-anything");

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("answers identically for a foreign application and one that does not exist", async () => {
    const app = buildApp({ database: prisma, logger: false });

    const foreign = await get(app, "/v1/applications/application-owned", "customer-other");
    const missing = await get(app, "/v1/applications/application-does-not-exist", "customer-other");

    // Asserting on the body, not just the status code: an identical 404 that
    // carries a distinguishable message is still an existence oracle.
    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(foreign.body).toBe(missing.body);
    await app.close();
  });

  it("rejects a request with no identity before considering the application", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await get(app, "/v1/applications/application-owned");

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("treats a whitespace-only identity as absent", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await get(app, "/v1/applications/application-owned", "   ");

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
