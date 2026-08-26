import { statusEventSchema } from "@assessment/contracts";
import { prisma, type PrismaClient } from "@assessment/database";
import Fastify from "fastify";
import {
  ApplicationNotFoundError,
  getApplicationForCustomer,
  recordStatusEvent,
} from "./application-service.js";

interface BuildAppOptions {
  database?: PrismaClient;
  logger?: boolean;
}

/**
 * CORS is deliberately not registered.
 *
 * Nothing in this repository calls the API from a browser: the web app fetches
 * it from a React Server Component, which runs server-side, and CORS is a
 * browser-only mechanism. The previous `origin: true` reflected every requesting
 * origin, which combined with header-based identity made any website able to
 * read customer data cross-origin. A browser-side caller added in future should
 * re-introduce CORS with an explicit allow-list (see DECISIONS.md D3).
 */
export function buildApp(options: BuildAppOptions = {}) {
  const database = options.database ?? prisma;
  const app = Fastify({ logger: options.logger ?? true });

  app.get("/health", async () => ({ status: "ok" }));

  app.get<{ Params: { applicationId: string } }>(
    "/v1/applications/:applicationId",
    async (request, reply) => {
      const header = request.headers["x-customer-id"];
      const customerId = typeof header === "string" ? header.trim() : "";
      if (customerId.length === 0) {
        return reply.code(401).send({ error: "customer identity is required" });
      }

      const application = await getApplicationForCustomer(
        database,
        request.params.applicationId,
        customerId,
      );

      if (!application) {
        // Deliberately indistinguishable from "does not exist" in the response.
        // The distinction is preserved here, where the caller cannot read it.
        request.log.warn(
          { applicationId: request.params.applicationId, customerId },
          "application not found or not visible to caller",
        );
        return reply.code(404).send({ error: "application not found" });
      }

      return application;
    },
  );

  app.post<{ Params: { applicationId: string } }>(
    "/v1/applications/:applicationId/status-events",
    async (request, reply) => {
      const parsed = statusEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid status event",
          details: parsed.error.flatten(),
        });
      }

      request.log.info(
        { applicationId: request.params.applicationId, event: parsed.data },
        "received partner status event",
      );

      try {
        const result = await recordStatusEvent(
          database,
          request.params.applicationId,
          parsed.data,
        );

        if (result.outcome !== "ACCEPTED") {
          request.log.warn(
            {
              applicationId: request.params.applicationId,
              eventId: parsed.data.eventId,
              outcome: result.outcome,
              currentStatus: result.application.status,
              attemptedStatus: parsed.data.status,
            },
            "partner status event was not applied",
          );
        }

        // The status code answers "did anything go wrong?"; the `outcome` field
        // answers "what happened?". A duplicate is a correct retry and a stale
        // event is the network reordering delivery -- neither is the partner
        // misbehaving, so both stay on 200. An invalid transition is either a
        // partner defect or a real business conflict, and someone should look
        // at it (DECISIONS.md D6, D9).
        const status = result.outcome === "INVALID_TRANSITION" ? 409 : 200;
        return reply.code(status).send(result);
      } catch (error) {
        if (error instanceof ApplicationNotFoundError) {
          return reply.code(404).send({ error: "application not found" });
        }
        throw error;
      }
    },
  );

  return app;
}
