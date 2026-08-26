import { z } from "zod";

export const APPLICATION_STATUSES = [
  "SUBMITTED",
  "IN_REVIEW",
  "OFFERED",
  "APPROVED",
  "DECLINED",
  "DISBURSED",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const statusEventSchema = z.object({
  eventId: z.string().trim().min(1).max(100),
  status: z.enum(APPLICATION_STATUSES),
  occurredAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500).optional(),
});

export type StatusEventInput = z.infer<typeof statusEventSchema>;

export interface ApplicationView {
  id: string;
  status: ApplicationStatus;
  requestedAmountCents: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  customer: {
    id: string;
    name: string;
    email: string;
    phone: string;
  };
  history: Array<{
    id: string;
    status: ApplicationStatus;
    reason: string | null;
    occurredAt: string;
    recordedAt: string;
  }>;
}

/**
 * Outcomes the partner integration adapter can report for a status event.
 *
 * Modelled as a discriminated union rather than inferred from the HTTP status
 * code, so the partner switches on one exhaustive field. DOMAIN.md requires a
 * duplicate delivery, a stale or invalid change, and an accepted change to be
 * distinguishable (DECISIONS.md D6).
 */
export const STATUS_EVENT_OUTCOMES = [
  "ACCEPTED",
  "DUPLICATE",
  "STALE",
  "INVALID_TRANSITION",
] as const;

export type StatusEventOutcome = (typeof STATUS_EVENT_OUTCOMES)[number];

/**
 * The partner-facing projection of an application.
 *
 * Deliberately excludes customer contact details: the partner reports a status
 * and needs an acknowledgement, not the customer's name, email or phone number.
 */
export interface ApplicationSummary {
  id: string;
  status: ApplicationStatus;
  requestedAmountCents: number;
  currency: string;
  lastEventOccurredAt: string | null;
  updatedAt: string;
}

export interface StatusEventResult {
  outcome: StatusEventOutcome;
  application: ApplicationSummary;
}

/**
 * Permitted status transitions.
 *
 * DOMAIN.md draws the lifecycle as:
 *
 *   SUBMITTED -> IN_REVIEW -> OFFERED -> APPROVED -> DISBURSED
 *                           \-> DECLINED
 *                 \---------------------> DECLINED
 *
 * The two DECLINED branches do not line up unambiguously with a single source
 * state, so whether a decline is permitted from OFFERED or APPROVED is not
 * settled by the document. The reading encoded here is that DECLINED is
 * reachable from any non-terminal state, which matches how lending works: an
 * application can fail its checks at any point before the money moves.
 *
 * This is an assumption, not a fact -- see DECISIONS.md D8 and PLAN.md. It errs
 * towards accepting a late decline (real, and otherwise silently dropped) over
 * rejecting one, while still blocking the two dangerous cases: any change after
 * a terminal state, and reaching DISBURSED without passing through the checks.
 *
 * There are no self-transitions: the graph has no self-loops.
 */
export const ALLOWED_TRANSITIONS: Record<
  ApplicationStatus,
  readonly ApplicationStatus[]
> = {
  SUBMITTED: ["IN_REVIEW", "DECLINED"],
  IN_REVIEW: ["OFFERED", "DECLINED"],
  OFFERED: ["APPROVED", "DECLINED"],
  APPROVED: ["DISBURSED", "DECLINED"],
  DECLINED: [],
  DISBURSED: [],
} as const;

/** Statuses from which no further transition is permitted. */
export const TERMINAL_STATUSES = ["DECLINED", "DISBURSED"] as const;

export function isTerminalStatus(status: ApplicationStatus): boolean {
  return (TERMINAL_STATUSES as readonly ApplicationStatus[]).includes(status);
}

export function canTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
