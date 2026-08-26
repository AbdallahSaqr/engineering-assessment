# Known limitations and next steps

What this submission does not do, why, and what it would take. Paired with [ISSUES.md](ISSUES.md) (what was found and what shipped), [DECISIONS.md](DECISIONS.md) (why each fix took the shape it did) and [DESIGN.md](DESIGN.md) (the production target).

Everything here is a deliberate omission rather than an oversight. Where something is an assumption rather than a fact, it says so.

---

## Limitations of the implementation

### 1. The worker cannot safely run as more than one process

The most significant thing left open. `processNotificationBatch` selects pending jobs and processes them with no claim, no lease and no lock, so two workers would select the same rows and send twice.

**Why it is still here.** The correct fix is a claim step using `SELECT … FOR UPDATE SKIP LOCKED`, which SQLite does not support. Simulating it with an application-level lock would demonstrate a mechanism production would not use and prove nothing about the real design ([ISSUES.md #7](ISSUES.md), [DESIGN.md §2](DESIGN.md)).

**What it takes.** PostgreSQL, a `locked_by`/`locked_at` pair, the claim query written out in `DESIGN.md`, and a reaper that returns leases held past a timeout — without which a worker dying mid-batch strands its jobs permanently.

**Operational consequence today:** run exactly one worker. That is a scaling ceiling and a single point of failure, and it should be stated in a runbook rather than discovered.

### 2. Neither trust boundary has real authentication

The partner intake endpoint is unauthenticated, and the customer API still identifies callers by a `x-customer-id` header it takes on trust.

**Why.** Both are scoped out by the exercise — DOMAIN.md calls the header *"a deliberately simple stand-in"* and says partner authentication *"is not implemented in the exercise, but the production design should explain its trust boundary"*.

**What changed anyway:** the header is now actually *enforced* — ownership is part of the query, and a foreign application is indistinguishable from a nonexistent one ([D1](DECISIONS.md), [D2](DECISIONS.md)). The stand-in is honoured properly rather than replaced.

### 3. Rejected events leave no queryable record

A `STALE` or `INVALID_TRANSITION` outcome is logged and returned, but nothing durable records that the event arrived. When a partner asks why their event did not take effect, the answer is in log retention rather than in the database.

**Why.** Customer-visible history must contain only accepted events — showing a customer a status that was never theirs would be misleading — and the correct home is a separate audit table, which is a larger change than the slice justified ([D7](DECISIONS.md)).

**This is the gap I would close first among the ones left open.** The table shape is in [DESIGN.md §4](DESIGN.md).

### 4. The response contract change is not backward compatible

An accepted event now returns `200` with an `outcome` field instead of `202` ([D6](DECISIONS.md)). A partner asserting `status === 202` would break on deploy.

Acceptable in an assessment; not in production. The compatible sequence — add `outcome` additively, migrate partners, then version the status-code change — is written out in [DESIGN.md §6](DESIGN.md).

The provided test that asserted `202` was updated rather than deleted, with a comment marking it as a deliberate contract change.

### 5. The web app has no failure handling

Unchanged from the original, and out of scope for this slice ([ISSUES.md #9](ISSUES.md)):

- `apps/web/src/api.ts` throws a bare `Error` on any non-OK response, and there is no `error.tsx` or `not-found.tsx`, so a `404` renders as a crash page. Now more visible, because the ownership fix means a mistyped URL returns `404` where it previously returned somebody's application.
- `formatMoney` passes `maximumFractionDigits: 0` over minor units, silently truncating piastres on any non-round amount.
- `formatDate` runs server-side with no `timeZone`, so timestamps render in the server's zone despite DOMAIN.md specifying UTC.

All three are small and independent. They were left because silent corruption of a loan record outranks a rendering defect, not because they do not matter.

### 6. SQLite constrains three things the schema wants

- **`status` columns are `String`, not enums.** Both `LoanApplication.status` and `NotificationJob.status` rely on application code plus an unchecked `as ApplicationStatus` cast. PostgreSQL enums or a `CHECK` constraint would make the type system's claim true at the database.
- **The outbox poll uses a full index** where a partial index (`WHERE status = 'PENDING'`) would be smaller and better matched.
- **`prisma db push --accept-data-loss` is the migration path.** Fine against a database that is recreated; must not exist in a deployment pipeline ([DESIGN.md §6](DESIGN.md)).

### 7. Smaller items, each with a known fix

| | Limitation | Fix |
|---|---|---|
| a | Replay records nothing about **who** replayed a job | Authenticated operator endpoint writing to the audit log ([D13](DECISIONS.md)) |
| b | The intake route logs the whole parsed event, including free-text `reason` | Allow-list redaction: log event id, status, outcome — never the payload |
| c | `MockEmailProvider` ignores the idempotency key entirely, so nothing verifies that half of the contract | A fake that enforces it, plus a contract test against the real provider |
| d | Idempotency records grow without bound | A retention window longer than the partner's retry horizon — needs question 5 below answered |
| e | `lastEventOccurredAt` is still written but no longer authoritative | Harmless; either drop it or document it as derived. Left because the web app may want it |
| f | No structured correlation id on log lines | Request-scoped id propagated through the outbox row ([DESIGN.md §5](DESIGN.md)) |

---

## Limitations of the testing

The suite went from 4 tests to 45, and every P0 in `ISSUES.md` now has a test that fails without its fix. These are the honest gaps.

### 8. True concurrency is not tested, and cannot be here

SQLite serialises writes, so issuing requests together does not produce database-level concurrency. This was **measured, not assumed** — instrumenting both dedupe branches showed three "concurrent" duplicates all resolving through the pre-check and never reaching the constraint ([D4](DECISIONS.md)).

What exists instead: a test that reconstructs the race *window* by putting the database in the exact half-written state a losing request would observe, verified by instrumentation to reach the constraint branch. That proves the branch behaves correctly. It does not prove the database arbitrates correctly under real contention — that needs PostgreSQL and parallel connections.

### 9. Tests share one database and cannot run in parallel

All suites use a single `test.db` with `--no-file-parallelism` and manual `deleteMany` in `beforeEach`. It works and it is deterministic, but it is not isolation: adding a suite that assumes a clean database without resetting it would produce order-dependent failures.

A transaction-per-test harness with rollback, or a database-per-worker, is the fix. Not done because it is test infrastructure rather than a risk in `ISSUES.md`.

### 10. No coverage measurement, and no web or end-to-end tests

There is no coverage gate, so "45 tests pass" says nothing about what is unexercised. `apps/web` has no tests at all, and nothing exercises browser → web → API → worker → provider as one path.

### 11. One branch is unreachable and tested through a stub

`PermanentNotificationError` for a vanished application cannot occur under the current schema — a foreign key prevents it and the relation cascades on delete. Discovered when the test could not set itself up (`FOREIGN KEY constraint failed`), and kept as defence in depth against foreign keys being disabled or an inconsistent restore ([D12](DECISIONS.md)). It is tested through a stubbed read, with the unreachability documented in the test.

---

## Open questions I could not answer alone

These are genuine ambiguities, not things I forgot to look up. Each is currently resolved by an assumption that is recorded in code and would be confirmed with the partner or product owner in a real engagement.

1. **Can an application be declined after `OFFERED` or `APPROVED`?** DOMAIN.md's diagram is ambiguous — the two `DECLINED` branches do not line up unambiguously with a source state. I assumed **yes**, because a failed final check must be recordable or the application freezes at `OFFERED` forever and silently. The transition map is one place to change ([D8](DECISIONS.md)).

2. **May the partner send repeated same-status events with a new `reason`?** The documented graph has no self-loops, so `IN_REVIEW → IN_REVIEW` is currently rejected as invalid. If the partner does this legitimately — "documents received", then "income verification started" — we are silently losing customer-visible detail. This is the assumption I am least comfortable with.

3. **Should a customer see that a stale event arrived?** I assumed not: history shows accepted events only. If stale arrivals are considered customer-relevant, that changes both the schema and the read model.

4. **Are partner event identifiers globally unique, or unique per application?** Deduplication is scoped per application, which is safe under either answer but weaker under the first ([D5](DECISIONS.md)).

5. **What is the partner's maximum retry horizon?** It sets the idempotency retention window. Too short and a very late redelivery is reprocessed as new.

6. **Can the partner supply a monotonic sequence number?** It would replace timestamp comparison with integer comparison and remove clock trust entirely ([DESIGN.md §2](DESIGN.md)).

---

## Next steps, in order

Ordered by risk removed per unit of effort, not by size.

**Immediately, before anything else ships**

1. **Audit table for rejected events** (limitation 3). Closes the biggest gap in the work already done and makes the outcome discriminator durable rather than ephemeral.
2. **Log redaction** (7b). One route, small change, removes free-text customer data from logs.
3. **Runbook note that exactly one worker may run** (limitation 1). Costs nothing; prevents an incident.

**Before production**

4. **PostgreSQL.** Unblocks worker claiming, partial indexes, native enums and real migrations — several items wait on it.
5. **Partner authentication** — mTLS or HMAC over the raw body with a timestamp window ([DESIGN.md §3](DESIGN.md)).
6. **Real customer sessions, plus row-level security** as defence in depth behind the query-level check already built.
7. **Worker claiming with `SKIP LOCKED`, plus lease expiry.**
8. **Tracing through the outbox and metrics on the `outcome` dimension.** Cheap, and they determine how fast everything after this is diagnosed.

**Soon after**

9. Web failure handling, money formatting and timezone (limitation 5).
10. Test isolation and a coverage gate (limitations 9, 10).
11. Contract test that the provider honours idempotency keys (7c).
12. Feature-flag the transition rules, so the assumption in question 1 can be changed without a release.

---

## What I would want to verify but could not

- **Behaviour under real database contention.** Everything about concurrency here is reasoned from the constraint plus a reconstructed window, not observed under load.
- **That a real email provider honours the idempotency key.** The mock ignores it, so the only thing standing between a worker crash and a duplicate customer email is currently untested.
- **Performance.** No load testing. The write path now costs a transaction, two indexed reads and a constraint check per event. I believe that is irrelevant at partner event volumes and I have not measured it.
- **That the transition map matches the business.** It matches my reading of an ambiguous diagram. That is not the same thing.
