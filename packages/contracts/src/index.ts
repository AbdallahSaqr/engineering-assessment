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
