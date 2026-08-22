import { randomUUID } from "node:crypto";
import type { ApplicationStatus, ApplicationView, StatusEventInput } from "@assessment/contracts";
import type { PrismaClient } from "@assessment/database";

export class ApplicationNotFoundError extends Error {
  constructor(applicationId: string) {
    super(`Application ${applicationId} was not found`);
    this.name = "ApplicationNotFoundError";
  }
}

export async function getApplication(
  database: PrismaClient,
  applicationId: string,
): Promise<ApplicationView | null> {
  const application = await database.loanApplication.findUnique({
    where: { id: applicationId },
    include: {
      customer: true,
      history: { orderBy: { occurredAt: "desc" } },
    },
  });

  if (!application) return null;

  return {
    id: application.id,
    status: application.status as ApplicationStatus,
    requestedAmountCents: application.requestedAmountCents,
    currency: application.currency,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
    customer: {
      id: application.customer.id,
      name: application.customer.name,
      email: application.customer.email,
      phone: application.customer.phone,
    },
    history: application.history.map((entry) => ({
      id: entry.id,
      status: entry.status as ApplicationStatus,
      reason: entry.reason,
      occurredAt: entry.occurredAt.toISOString(),
      recordedAt: entry.recordedAt.toISOString(),
    })),
  };
}

export async function recordStatusEvent(
  database: PrismaClient,
  applicationId: string,
  event: StatusEventInput,
): Promise<ApplicationView> {
  const application = await database.loanApplication.findUnique({
    where: { id: applicationId },
  });

  if (!application) throw new ApplicationNotFoundError(applicationId);

  await database.loanApplication.update({
    where: { id: applicationId },
    data: {
      status: event.status,
      lastEventOccurredAt: new Date(event.occurredAt),
    },
  });

  await database.applicationStatusHistory.create({
    data: {
      id: randomUUID(),
      applicationId,
      status: event.status,
      reason: event.reason,
      sourceEventId: event.eventId,
      occurredAt: new Date(event.occurredAt),
    },
  });

  await database.notificationJob.create({
    data: {
      id: randomUUID(),
      applicationId,
      sourceEventId: event.eventId,
      type: "APPLICATION_STATUS_CHANGED",
      payload: JSON.stringify({
        status: event.status,
        reason: event.reason ?? null,
      }),
    },
  });

  const updated = await getApplication(database, applicationId);
  if (!updated) throw new ApplicationNotFoundError(applicationId);
  return updated;
}
