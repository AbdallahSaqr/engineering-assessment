import { randomUUID } from "node:crypto";
import { prisma } from "../src/index.js";

async function seed() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "cus_amina_001",
      name: "Amina Hassan",
      email: "amina.hassan@example.test",
      phone: "+201000000001",
      applications: {
        create: {
          id: "app_home_001",
          status: "SUBMITTED",
          requestedAmountCents: 250_000_00,
          currency: "EGP",
          lastEventOccurredAt: new Date("2026-08-20T08:00:00.000Z"),
          history: {
            create: {
              id: randomUUID(),
              status: "SUBMITTED",
              reason: "Application received",
              sourceEventId: "seed-event-001",
              occurredAt: new Date("2026-08-20T08:00:00.000Z"),
            },
          },
        },
      },
    },
  });

  await prisma.customer.create({
    data: {
      id: "cus_omar_002",
      name: "Omar Salem",
      email: "omar@retry.invalid",
      phone: "+201000000002",
      applications: {
        create: {
          id: "app_auto_002",
          status: "IN_REVIEW",
          requestedAmountCents: 90_000_00,
          currency: "EGP",
          lastEventOccurredAt: new Date("2026-08-19T13:00:00.000Z"),
          history: {
            create: [
              {
                id: randomUUID(),
                status: "SUBMITTED",
                reason: "Application received",
                sourceEventId: "seed-event-002",
                occurredAt: new Date("2026-08-19T12:00:00.000Z"),
              },
              {
                id: randomUUID(),
                status: "IN_REVIEW",
                reason: "Income verification started",
                sourceEventId: "seed-event-003",
                occurredAt: new Date("2026-08-19T13:00:00.000Z"),
              },
            ],
          },
          notificationJobs: {
            create: {
              id: randomUUID(),
              sourceEventId: "seed-event-003",
              type: "APPLICATION_STATUS_CHANGED",
              payload: JSON.stringify({ status: "IN_REVIEW" }),
            },
          },
        },
      },
    },
  });
}

seed()
  .then(() => {
    console.log("Loaded 2 synthetic customers and applications.");
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
