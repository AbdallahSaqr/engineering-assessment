# Domain and local contract

This document describes the intended product behavior.

## Application lifecycle

An application starts at `SUBMITTED` and may move through these states:

```text
SUBMITTED -> IN_REVIEW -> OFFERED -> APPROVED -> DISBURSED
                        \-> DECLINED
              \---------------------> DECLINED
```

Terminal states are `DECLINED` and `DISBURSED`. A partner event contains the partner's stable event identifier, the new status, the time the change occurred in the partner system, and an optional human-readable reason.

The partner can retry delivery, and network delays can change delivery order. An accepted logical event should have exactly one effect on the application history and should request at most one customer notification. Current state must describe the newest accepted business event, not merely the last HTTP request received.

For an accepted status change, the current application state, immutable history, and notification request form one logical change. History is customer-visible and may later be used as operational evidence.

## Access

The local customer API uses `x-customer-id` as a deliberately simple stand-in for an authenticated session. Treat the value as caller-controlled. A customer may read only applications they own.

The partner event endpoint represents an internal integration adapter. Authentication of that adapter is not implemented in the exercise, but the production design should explain its trust boundary.

## HTTP API

### `GET /health`

Returns `{ "status": "ok" }`.

### `GET /v1/applications/:applicationId`

Requires the `x-customer-id` request header. Returns the application, customer contact details, and status history ordered newest first.

Expected failures include a missing identity and an application that does not exist or is not visible to that identity. The API should not disclose whether an inaccessible application exists.

### `POST /v1/applications/:applicationId/status-events`

Accepts JSON of this shape:

```json
{
  "eventId": "partner-event-100",
  "status": "IN_REVIEW",
  "occurredAt": "2026-08-20T10:30:00.000Z",
  "reason": "Documents received"
}
```

The adapter should distinguish malformed input, an unknown application, a duplicate delivery, a stale or invalid state change, and an accepted state change in a way its caller can operate safely.

## Notifications

The worker polls pending notification jobs and calls a mock email provider. Addresses ending in `@retry.invalid` simulate a temporarily unavailable provider. A failed attempt should remain eligible for a bounded retry policy. An operator should be able to inspect and replay exhausted work.

Multiple worker processes may eventually run at the same time. Provider calls should carry an idempotency key because a process can stop after the provider accepts a request but before local state is recorded.

## Money and time

Money is stored as integer minor units (`requestedAmountCents`) with an ISO currency code. Partner timestamps are UTC ISO-8601 values. Customer-facing formatting currently targets Egypt.
