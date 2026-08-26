import { randomUUID } from "node:crypto";
import {
  canTransition,
  type ApplicationStatus,
  type ApplicationSummary,
  type ApplicationView,
  type StatusEventInput,
  type StatusEventResult,
} from "@assessment/contracts";
import { Prisma, type PrismaClient } from "@assessment/database";

/** Prisma client scoped to an open interactive transaction. */
type TransactionClient = Prisma.TransactionClient;

/**
 * A unique constraint was violated.
 *
 * This is the load-bearing duplicate signal: the pre-check in `recordStatusEvent`
 * is a fast path for the ordinary case, but only the database constraint holds
 * when two retries are processed concurrently (DECISIONS.md D4).
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

export class ApplicationNotFoundError extends Error {
  constructor(applicationId: string) {
    super(`Application ${applicationId} was not found`);
    this.name = "ApplicationNotFoundError";
  }
}

const applicationViewInclude = {
  customer: true,
  history: { orderBy: { occurredAt: "desc" } },
} as const;

type ApplicationWithRelations = NonNullable<
  Awaited<
    ReturnType<
      PrismaClient["loanApplication"]["findFirst"]
    >
  >
> & {
  customer: { id: string; name: string; email: string; phone: string };
  history: Array<{
    id: string;
    status: string;
    reason: string | null;
    occurredAt: Date;
    recordedAt: Date;
  }>;
};

function toApplicationView(
  application: ApplicationWithRelations,
): ApplicationView {
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

/**
 * Reads an application on behalf of a customer.
 *
 * Ownership is expressed as part of the lookup rather than as a check performed
 * afterwards: `customerId` is required, and a row belonging to somebody else is
 * never loaded. An application that does not exist and an application the caller
 * does not own both resolve to `null`, so callers cannot accidentally disclose
 * which of the two occurred (see DECISIONS.md D1, D2).
 */
export async function getApplicationForCustomer(
  database: PrismaClient,
  applicationId: string,
  customerId: string,
): Promise<ApplicationView | null> {
  const application = await database.loanApplication.findFirst({
    where: { id: applicationId, customerId },
    include: applicationViewInclude,
  });

  if (!application) return null;

  return toApplicationView(application as ApplicationWithRelations);
}

function toApplicationSummary(application: {
  id: string;
  status: string;
  requestedAmountCents: number;
  currency: string;
  lastEventOccurredAt: Date | null;
  updatedAt: Date;
}): ApplicationSummary {
  return {
    id: application.id,
    status: application.status as ApplicationStatus,
    requestedAmountCents: application.requestedAmountCents,
    currency: application.currency,
    lastEventOccurredAt: application.lastEventOccurredAt?.toISOString() ?? null,
    updatedAt: application.updatedAt.toISOString(),
  };
}

/**
 * Applies a partner status event.
 *
 * The partner delivers at least once, so the same logical event can arrive more
 * than once. Everything below runs inside a single transaction: the duplicate
 * check and the three writes it guards have to commit or roll back together, or
 * the check is not a check (DECISIONS.md D4, ISSUES.md #2 and #4).
 */
export async function recordStatusEvent(
  database: PrismaClient,
  applicationId: string,
  event: StatusEventInput,
): Promise<StatusEventResult> {
  return database.$transaction(async (tx: TransactionClient) => {
    const application = await tx.loanApplication.findUnique({
      where: { id: applicationId },
    });

    if (!application) throw new ApplicationNotFoundError(applicationId);

    // Fast path for an ordinary retry. Not the guarantee -- see the catch below.
    const alreadyApplied = await tx.applicationStatusHistory.findFirst({
      where: { applicationId, sourceEventId: event.eventId },
    });

    if (alreadyApplied) {
      return {
        outcome: "DUPLICATE" as const,
        application: toApplicationSummary(application),
      };
    }

    // Ordering. Compared against the newest accepted event in history rather
    // than the denormalised `lastEventOccurredAt`, so there is one source of
    // truth and no possibility of the two drifting (DECISIONS.md D7).
    //
    // Strictly-older, not older-or-equal: a true redelivery is already caught
    // above by event id, so an equal timestamp under a different id is a
    // genuinely distinct event and rejecting it would drop a real change.
    const newest = await tx.applicationStatusHistory.findFirst({
      where: { applicationId },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    });

    const occurredAt = new Date(event.occurredAt);

    if (newest && occurredAt < newest.occurredAt) {
      // Rejected, so it has no effect on customer-visible history. The arrival
      // is still operationally interesting, hence the log line; a durable audit
      // trail is described in DESIGN.md.
      return {
        outcome: "STALE" as const,
        application: toApplicationSummary(application),
      };
    }

    const currentStatus = application.status as ApplicationStatus;

    if (!canTransition(currentStatus, event.status)) {
      return {
        outcome: "INVALID_TRANSITION" as const,
        application: toApplicationSummary(application),
      };
    }

    try {
      await tx.applicationStatusHistory.create({
        data: {
          id: randomUUID(),
          applicationId,
          status: event.status,
          reason: event.reason,
          sourceEventId: event.eventId,
          occurredAt,
        },
      });
    } catch (error) {
      // Two retries raced past the pre-check; the constraint settled it.
      if (isUniqueViolation(error)) {
        return {
          outcome: "DUPLICATE" as const,
          application: toApplicationSummary(application),
        };
      }
      throw error;
    }

    const updated = await tx.loanApplication.update({
      where: { id: applicationId },
      data: {
        status: event.status,
        lastEventOccurredAt: occurredAt,
      },
    });

    await tx.notificationJob.create({
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

    return {
      outcome: "ACCEPTED" as const,
      application: toApplicationSummary(updated),
    };
  });
}
