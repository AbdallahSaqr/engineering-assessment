# Prioritised issues

## How I assessed this

I did not rank these by reading the code. Every finding below was reproduced by executing it against the real stack, because a defect that has not been observed is a hypothesis, and I did not want to prioritise hypotheses.

Method: install, run the baseline suite, then write a throwaway probe suite that exercised each suspected failure through the actual Fastify app and the actual worker batch function against a real SQLite database. The probe file was deleted after the run; its findings are folded into the focused tests that ship with the slice. The raw output is quoted per issue below.

**Baseline before any change:** `lint` clean, `typecheck` clean across all five packages, `next build` succeeds, `4 tests pass`. The system runs. Nothing here is a build failure — every issue is behaviour that is wrong while the build is green, which is what makes them worth ranking.

Probe output, in full:

```text
PROBE 1  IDOR                 -> status 200 | email leaked: owner@example.test
PROBE 1b arbitrary identity   -> status 200
PROBE 2  duplicate eventId    -> 202,202 | history rows: 2 | jobs: 2
PROBE 3  out-of-order event   -> status rewound APPROVED -> IN_REVIEW
PROBE 4  illegal transition   -> DECLINED then DISBURSED: 202 | final: DISBURSED
PROBE 5  failed notification  -> processedAt set: true | nextAttemptAt: null | batch2 found: 0
PROBE 6  partial write        -> http 500 | status mutated | history: 1 | jobs: 0
PROBE 7  existence disclosure -> missing: 404 | foreign: 200
```

## Summary

| # | Issue | Severity | In scope |
|---|---|---|---|
| 1 | Customer read path ignores ownership (IDOR) | **P0 — data breach** | Yes |
| 2 | No idempotency: partner retries duplicate history and notifications | **P0** | Yes |
| 3 | No ordering guard: late events rewind current status | **P0** | Yes |
| 4 | Status, history and notification are not written atomically | **P0** | Yes |
| 5 | Failed notifications are marked delivered; retries are dead code | **P0** | Yes |
| 6 | No state machine: illegal and post-terminal transitions accepted | P1 | Yes |
| 7 | Worker cannot safely run as more than one process | P1 | No — design only |
| 8 | Error classification, HTTP semantics, PII in partner response | P2 | Partly |
| 9 | Web app has no error, empty or not-found handling | P2 | No |
| 10 | Existing tests encode the bugs rather than catch them | P1 | Yes |

---

## 1. P0 — Broken authorization (IDOR)

**Where:** `apps/api/src/app.ts:27-41`, `apps/api/src/application-service.ts:16-22`

`getApplication` resolves by primary key alone:

```ts
const application = await database.loanApplication.findUnique({
  where: { id: applicationId },
```

The route validates that `x-customer-id` is a non-empty string and then discards it. The customer identity never reaches the query. Any caller sending any value reads any application, including the customer's name, email address and phone number.

```text
PROBE 1  -> status 200 | email leaked: owner@example.test
PROBE 1b -> status 200      (header value: "literally-anything")
```

DOMAIN.md: *"A customer may read only applications they own."* The system has no such control. This is a personal-data breach on a lending product, the fix is roughly five lines, and it shares no code with anything else in this list — so it is addressed first and on its own rather than folded into the slice.

**Compounding factor.** `app.ts:20` registers CORS with `origin: true`, which reflects any requesting origin. Header-based identity plus reflected CORS makes this readable cross-origin from any website, not only from a crafted client.

**Related — existence disclosure.** DOMAIN.md: *"The API should not disclose whether an inaccessible application exists."* Today a foreign application returns 200 and a missing one returns 404, so the status code is an existence oracle. Fixing ownership without collapsing both cases to an identical 404 would leave that oracle intact.

```text
PROBE 7  -> missing: 404 | foreign: 200
```

## 2. P0 — No idempotency

**Where:** `apps/api/src/application-service.ts:49-90`, `packages/database/prisma/schema.prisma:49,66`

`sourceEventId` carries a plain `@@index` on both `ApplicationStatusHistory` and `NotificationJob`. There is **no unique constraint anywhere in the schema**, and `recordStatusEvent` never checks whether the event has already been applied. A partner retry is processed as a fresh event.

```text
PROBE 2  -> codes 202,202 | history rows: 2 | jobs: 2
```

DOMAIN.md is explicit: *"An accepted logical event should have exactly one effect on the application history and should request at most one customer notification."* Both halves are violated. The customer-visible consequence is duplicate emails and a history table showing the same transition twice — and history is specified as customer-visible and usable as operational evidence, so duplicates corrupt the evidence, not merely the display.

The unique constraint is the single highest-value change available in this repository: it converts idempotency from a check that races into an invariant the database enforces.

## 3. P0 — No ordering guard

**Where:** `apps/api/src/application-service.ts:60-66`

`lastEventOccurredAt` is written on every event and read by nothing. There is no comparison against the incoming `occurredAt`.

```text
PROBE 3  -> APPROVED, then a late event dated six hours earlier
            -> current status: IN_REVIEW
```

DOMAIN.md: *"Current state must describe the newest accepted business event, not merely the last HTTP request received."* Current state is presently defined as exactly the last HTTP request received. Because the partner explicitly may deliver late or out of order, this is a matter of when, not if.

## 4. P0 — Non-atomic write

**Where:** `apps/api/src/application-service.ts:60-90`

Three sequential awaits — application update, history insert, notification insert — with no transaction. DOMAIN.md: *"the current application state, immutable history, and notification request form one logical change."* They are three.

Forcing the third write to fail:

```text
PROBE 6  -> http 500 | app.status mutated | history rows: 1 | jobs: 0
```

The application advanced, the history recorded it, the customer was never told, and the caller received a 500 that invites a retry which — per issue 2 — will duplicate rather than repair. The API's own error path is what tears the logical change apart.

## 5. P0 — Retries are dead code

**Where:** `apps/worker/src/process-notifications.ts:57-70`

```ts
} finally {
  await database.notificationJob.update({
    where: { id: job.id },
    data: { attemptCount: { increment: 1 }, lastError, processedAt: new Date() },
  });
}
```

`processedAt` is set in a `finally` block, so a **failed** delivery is stamped as complete. `nextAttemptAt` is never written at all. The polling query at `:21-28` filters on `processedAt: null`, so a failure becomes permanently invisible after the first attempt.

```text
PROBE 5  -> batch1 {found:1, delivered:0, failed:1}
            processedAt set: true | nextAttemptAt: null | attempts: 1
            batch2 {found:0, ...}      <- never retried
```

The schema already has `attemptCount`, `nextAttemptAt` and `lastError` columns: the retry machinery was modelled and then not implemented. The seed data includes `omar@retry.invalid`, and `MockEmailProvider` throws for that address on purpose — so the fixture for a feature that does not exist is already in the repository.

DOMAIN.md names four requirements here: *"A failed attempt should remain eligible for a bounded retry policy. An operator should be able to inspect and replay exhausted work."* None of bounded retry, backoff, dead-lettering or replay exists.

A single transient provider blip currently means a customer is silently never notified of a decision on their loan, with no operator signal.

## 6. P1 — No state machine

**Where:** `packages/contracts/src/index.ts:3-10`, `apps/api/src/application-service.ts:28,40`

`APPLICATION_STATUSES` is a flat list. DOMAIN.md defines a transition graph with two terminal states, `DECLINED` and `DISBURSED`. Nothing enforces it.

```text
PROBE 4  -> DECLINED then DISBURSED: 202 | final: DISBURSED
```

An application that was declined can be disbursed. On a lending product that is a financial-control failure, not a data-validation one.

Underneath it, `status` is `String` in Prisma (`schema.prisma:26,42`) and is cast with `as ApplicationStatus` on the way out — an unchecked assertion over an unconstrained column, so the type system's claim about this field is unfounded at both ends.

## 7. P1 — Worker cannot run as more than one process

**Where:** `apps/worker/src/process-notifications.ts:21-28`

`findMany` selects up to 20 pending jobs and the loop processes them. There is no claim, no lease, no `lockedAt`. Two workers select the same rows and both send.

DOMAIN.md anticipates this: *"Multiple worker processes may eventually run at the same time. Provider calls should carry an idempotency key because a process can stop after the provider accepts a request but before local state is recorded."*

The idempotency key meant to be that backstop has two problems. It is `job.sourceEventId` rather than the job id (`:48`), so it collides across notification *types* for the same event — two different emails about one event would share a key and the second would be suppressed. And `MockEmailProvider` ignores the key entirely, so nothing in the local stack honours it.

Separately, `apps/worker/src/index.ts:16-19`: `shutdown()` sets `stopping = true` and immediately calls `$disconnect()` while a batch may be mid-flight, then never exits the process. SIGINT hangs, and can tear down the connection under an in-flight write.

## 8. P2 — Error classification, HTTP semantics, PII exposure

- `process-notifications.ts:42-44` treats *"application no longer exists"* as a retryable failure. It is permanent. Without a transient/permanent split, a permanently broken job consumes the whole retry budget once retries exist.
- The POST returns **202 Accepted**, but the work is committed synchronously before the response is written. 200 is the honest code; 202 tells the partner the outcome is still pending when it is not.
- That response body is the full `ApplicationView`, so the **partner** receives the customer's name, email address and phone number. The partner sends a status event; it has no need for customer contact details. This is a quieter instance of the same class of problem as issue 1.

## 9. P2 — Web app has no failure handling

- `apps/web/src/api.ts:14-18` throws a bare `Error` on any non-OK response. There is no `error.tsx` and no `not-found.tsx`, so a 404 renders as a crash page.
- `formatMoney` passes `maximumFractionDigits: 0` over minor units, silently truncating piastres on any non-round amount.
- `formatDate` runs server-side with no `timeZone`, so timestamps render in the server's zone despite DOMAIN.md specifying UTC.

## 10. P1 — The tests encode the bugs

Four tests exist. None cover ownership, duplicate delivery, ordering, transition validity, atomicity or retry — that is, none cover any of the five P0 issues.

Worse, `apps/worker/src/__tests__/process-notifications.test.ts:60` asserts:

```ts
expect(storedJob.processedAt).toBeInstanceOf(Date);
```

That passes identically whether delivery succeeded or failed, because the `finally` block sets `processedAt` on both paths. The test does not merely miss issue 5 — it certifies the broken behaviour as correct, so a future fix introducing real retries would make this test fail and look like a regression.

---

## What I chose to do within the timebox

**First, standalone: fix the IDOR.** It is a live data-breach path, the fix is small, and it shares no code with the rest of the work. Holding it back to make a tidier narrative would be the wrong call.

**Then one slice: trustworthy status ingestion** — issues 2, 3, 4, 5, 6 and 10.

These are not five independent fixes that happen to be urgent. They are one defect surface: everything that happens to a partner event between arriving at the HTTP boundary and reaching the customer as a notification. They also interlock, which is the real argument for taking them together:

- the unique constraint on `sourceEventId` is what makes the deduplication check safe against a concurrent retry, rather than a read-then-write race;
- the transaction is what makes "one logical change" true, and it is also what the dedupe check needs in order to be atomic with the write it guards;
- the ordering and transition rules are the accept/reject decision the transaction wraps — without them, the transaction just commits wrong data reliably;
- the worker's retry policy is the far end of the same path, and the only reason a notification the API promised actually arrives.

Fixing four of the five would leave the fifth able to reintroduce the same customer-visible symptom, so the slice is drawn where the invariant closes.

The secondary argument: this slice is the evidence base for `DESIGN.md`. The four themes named in the brief — idempotency, ordering, retries and dead letters, authorization — are exactly what it touches, so the design note argues from something built rather than something imagined.

## What I deliberately left alone

**Multi-worker claiming and leasing (issue 7).** The correct fix is a claim step using `SELECT ... FOR UPDATE SKIP LOCKED`, which SQLite does not support. I could simulate it with an application-level lock, but that would demonstrate a mechanism the production database would not use and prove nothing about the real design. It is described in `DESIGN.md` and recorded in `PLAN.md` instead. DOMAIN.md's own wording — *"may eventually"* — supports treating this as a design horizon rather than a present defect.

**Authentication of the partner endpoint.** The brief scopes this to the design note: *"Authentication of that adapter is not implemented in the exercise, but the production design should explain its trust boundary."* Building it would answer a question that was not asked.

**Real session authentication for the customer app.** `x-customer-id` is described as a deliberate stand-in. I enforce ownership *through* that stand-in rather than replacing it; swapping in real sessions is a `DESIGN.md` concern and would expand the slice into the web app for no gain in demonstrated correctness.

**Web app failure handling and formatting (issue 9).** Real and user-visible, but genuinely lower risk than silent data corruption on a loan record. Deferred to `PLAN.md` with the fixes specified, so the deferral is a decision rather than an oversight.

**Postgres migration.** Several fixes would be cleaner on Postgres — partial indexes, `SKIP LOCKED`, a native enum, real migrations instead of `db push --accept-data-loss`. Swapping the database inside a four-hour timebox would spend the budget on infrastructure and leave the defects unfixed. The slice is built so the constraints port unchanged.

**PII in the partner response (part of issue 8).** Narrowing the POST response is in scope and cheap. Broader data-minimisation work — field-level encryption, log redaction, retention — is `DESIGN.md` material.


---

## What shipped

| # | Issue | Outcome |
|---|---|---|
| 1 | Broken authorization (IDOR) | **Fixed** — ownership is part of the query; foreign and nonexistent return an identical `404`; CORS removed |
| 2 | No idempotency | **Fixed** — composite unique constraint plus a pre-check, inside the transaction |
| 3 | No ordering guard | **Fixed** — compared against the newest accepted event; stale events rejected with no effect |
| 4 | Non-atomic write | **Fixed** — the duplicate check and all three writes are one transaction |
| 5 | Retries are dead code | **Fixed** — explicit job status, jittered exponential backoff, bounded attempts, dead-letter queue, operator replay |
| 6 | No state machine | **Fixed** — transition table in `packages/contracts`; terminal states and check-skipping both blocked |
| 7 | Worker cannot run as more than one process | **Deferred** — needs `SKIP LOCKED`; see [DESIGN.md §2](DESIGN.md) and [PLAN.md](PLAN.md) limitation 1. The idempotency-key collision within it *was* fixed |
| 8 | Error classification, HTTP semantics, PII | **Mostly fixed** — permanent failures dead-letter immediately; `202` corrected to `200`; customer contact details removed from the partner response |
| 9 | Web app failure handling | **Deferred** — [PLAN.md](PLAN.md) limitation 5 |
| 10 | Tests encode the bugs | **Fixed** — the assertion that certified issue 5 is gone; every P0 now has a test that fails without its fix |

### Verification

`45 tests pass` (from 4). Lint clean, typecheck clean across all five packages, `next build` succeeds, and the README's documented `curl` example still works.

Each fix was checked three ways: a focused test, the full gate, and live behaviour against a running system. The reasoning behind each is in [DECISIONS.md](DECISIONS.md); how the output was verified — including three occasions where a green test was hiding something — is in [TOOLING.md](TOOLING.md).

### Reading order

| File | Contains |
|---|---|
| `ISSUES.md` | What was found, how it was prioritised, what was scoped in and out |
| [`DECISIONS.md`](DECISIONS.md) | The options considered for each fix, and why one was chosen over the others |
| [`DESIGN.md`](DESIGN.md) | The production design |
| [`PLAN.md`](PLAN.md) | Known limitations, open questions, next steps |
| [`TOOLING.md`](TOOLING.md) | Tools and models used, and how their output was checked |
