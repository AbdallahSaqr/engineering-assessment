# Decision log

A record of every non-obvious choice made while working through the issues in
[ISSUES.md](ISSUES.md), including the options rejected and why.

The reason this file exists: for most of these issues there was more than one
defensible fix. The fix that shipped is less interesting than the alternatives it
was chosen over, and a diff cannot show you an option that was considered and
discarded. This is where that lives.

Each entry records the problem, the options, the trade-offs, what was chosen, the
consequences accepted, and how it was verified.

| # | Decision | Outcome |
|---|---|---|
| D1 | How to enforce application ownership | **Option A** — ownership expressed as a query filter |
| D2 | What to return when an application is not yours | **Option B** — identical `404` for foreign and nonexistent |
| D3 | What to do about the permissive CORS policy | **Option A** — removed; nothing in the repo needs it |
| D4 | How to enforce idempotency on partner events | **Option C** — unique constraint plus a pre-check |
| D5 | What the uniqueness key should be | **Option B** — composite, scoped per application |
| D6 | What the partner sees for a duplicate delivery | **Option C** — `200` with an `outcome` discriminator |
| D7 | How to detect and handle a stale event | **B + E** — newest from history; reject without writing |
| D8 | How to express and enforce the transition rules | **Option B** — decline reachable from any non-terminal |
| D9 | What HTTP status the new outcomes should carry | **Option B** — `200`, except `409` for an invalid transition |
| D10 | How a notification job's state should be represented | **Option B** — explicit `status` column |
| D11 | The retry schedule | **Option D** — exponential, jittered, capped, bounded |
| D12 | Whether to distinguish permanent from transient failures | **Option B** — classify at the throw site |
| D13 | How an operator inspects and replays exhausted work | **Option B** — exported functions plus a CLI |
| D14 | Two smaller worker fixes | Included |

---

## D1 — How to enforce application ownership

**Issue:** [ISSUES.md #1](ISSUES.md) — the customer read path ignores the caller's identity.

### Context

The route reads `x-customer-id`, confirms it is a non-empty string, and then never
uses it. The lookup is by primary key alone:

```ts
// apps/api/src/application-service.ts:16
const application = await database.loanApplication.findUnique({
  where: { id: applicationId },
```

The question is not *whether* to check ownership, but *where* the check belongs.
That choice determines how easy it is to forget the check on the next route
somebody adds.

### Options

**Option A — filter in the query.** Make ownership part of the lookup itself, so a
row that is not yours is never returned.

```ts
const application = await database.loanApplication.findFirst({
  where: { id: applicationId, customerId },
});
```

- The service function cannot be called without an identity, because `customerId`
  becomes a required parameter. The compiler enforces that at every call site.
- A non-owned application and a nonexistent application both produce `null`, so
  the "do not disclose existence" rule (D2) is satisfied by construction rather
  than by remembering to write it.
- Single database round trip.
- Against it: the authorisation rule is expressed as a query filter, so it is less
  visible than an explicit branch. It also does not extend cleanly to a future
  case like "an operations user may read any application" — that would need a
  different code path rather than a different value.

**Option B — fetch, then compare.** Load by id, then check the owner in code.

```ts
const application = await database.loanApplication.findUnique({ where: { id } });
if (!application || application.customerId !== customerId) return null;
```

- The rule is explicit and readable; a reviewer sees the authorisation decision.
- It gives you a natural place to log a *denial* specifically — "customer X
  attempted to read application Y" — which is genuine security signal that
  Option A cannot distinguish from an ordinary typo.
- Against it: the check is a separate step that must be remembered. Delete the
  `if` and everything still compiles, still returns data, and every existing test
  still passes. That is the exact failure mode that produced this bug.
- The row is also loaded into memory before the caller is authorised, so any
  future code that logs or serialises the intermediate object leaks it.

**Option C — a Fastify `preHandler` hook.** Centralise authorisation in
middleware that resolves and authorises the application before the handler runs.

- One place to audit, and it would automatically cover new routes on this
  resource.
- Against it: there are two routes and they have *different* trust models. The
  customer route is authorised by `x-customer-id`; the partner route is an
  internal integration adapter with no customer identity at all. A blanket hook
  would have to carve out an exception immediately, which is where this kind of
  centralisation usually starts going wrong.
- It also needs the resolved application to reach the handler, which means either
  decorating the request or fetching twice.
- Reasonable at a dozen routes. Premature at two.

**Option D — enforce in the database (row-level security).** Postgres RLS with the
customer id supplied as a session variable, so the database itself refuses to
return other customers' rows.

- The strongest guarantee available: no application code path, including a future
  buggy one, can bypass it.
- Against it: SQLite has nothing equivalent, so this cannot be built here at all.
  It also requires disciplined session-variable handling on every connection, and
  it moves authorisation somewhere most engineers do not think to look.
- Belongs in `DESIGN.md` as the production hardening step, not in this slice.

### Analysis

A and B produce identical behaviour today. The difference is what happens to the
next person who touches this code.

Option B's weakness is precisely the failure that caused this issue: the check is
optional, and nothing fails if it is missing. The original author wrote the
identity check at the route and then did not carry it through to the query — which
is Option B with the second step left out. Choosing B means choosing the shape the
bug already grew in.

Option A makes the mistake harder to make: the service function will not compile
without an identity, and the identity has nowhere to go except into the filter.

Option B's one real advantage is the denial log. That is worth having, and it can
be recovered under Option A by logging at the route when the lookup returns
nothing — it loses the ability to distinguish "wrong owner" from "no such row",
which is a small price and is arguably the correct thing to log anyway, since
those two cases are deliberately indistinguishable to the caller (see D2).

### Decision

**Option A.** `getApplication` was renamed `getApplicationForCustomer` and now
takes a required `customerId`, resolving via `findFirst({ where: { id, customerId } })`.
A denial is logged at the route when the lookup returns nothing.

One consequence surfaced during implementation and is worth recording, because it
is the kind of thing that turns a small fix into a large one if handled carelessly.
`recordStatusEvent` ended by calling `getApplication` to build its response — but
the partner adapter has **no customer identity to supply**. Making `customerId`
required broke that call site, which is the constraint doing its job.

The resolution was to split the two reads by trust level rather than to weaken the
authorised one:

- `getApplicationForCustomer` — exported, requires an identity, filters on it.
- `loadApplicationView` — **not exported**, no ownership check, used only by the
  partner path inside this module.

The alternative — making `customerId` optional so both callers could share one
function — would have restored exactly the hazard Option A was chosen to remove:
a function that silently skips authorisation when the argument is absent. Keeping
the unauthorised read module-private means no customer-facing route can reach it,
and the two trust levels are visible in the names.

### Consequences accepted

- A future "operations user reads any application" feature will need a separate,
  explicitly-named service function rather than a flag on this one. That is a
  feature worth making noisy.
- The denial log does not distinguish a wrong owner from a nonexistent id.
- There are now two read paths in one module. That is acceptable while the
  unauthorised one is private and single-purpose; if a second caller ever needs
  it, that is the signal to reconsider.

### Verification

`apps/api/src/__tests__/application-access.test.ts`, plus live requests against a
running server and the seeded data:

```text
owner reads own application        -> 200
foreign customer reads it          -> 404  {"error":"application not found"}
nonexistent application            -> 404  {"error":"application not found"}
no identity header                 -> 401
whitespace-only identity           -> 401
```

Before the change the second line returned `200` together with the owner's email
address and phone number.

---

## D2 — What to return when an application is not yours

**Issue:** [ISSUES.md #1](ISSUES.md), existence-disclosure sub-issue.

### Context

Once ownership is enforced, the API has to answer a caller asking for someone
else's application. The choice leaks information or does not.

### Options

**Option A — `403 Forbidden` for a foreign application, `404 Not Found` for one
that does not exist.**

- Semantically honest, and HTTP's intended distinction: 403 means "this exists and
  you may not have it."
- Genuinely helpful for legitimate clients — a support engineer looking at a 403
  knows the customer is signed in as the wrong account, whereas a 404 could be a
  typo.
- Against it: the pair of responses is an existence oracle. Anyone can enumerate
  identifiers and learn which applications are real by the status code alone, even
  with no ability to read them. On a lending product, "which loan applications
  exist" is itself disclosure.

**Option B — an identical `404 Not Found` for both.**

- The caller cannot distinguish "does not exist" from "not yours". Enumeration
  yields nothing.
- Falls out of Option A in D1 for free — both cases are already `null`.
- Against it: less semantically precise, and it removes a useful debugging signal
  from the response. That signal has to be recovered from server-side logs.

**Option C — `404` for both, but with distinguishable error bodies or codes.**

- Splits the difference, and is what people often reach for.
- Against it: it defeats the entire point. The body is as readable as the status
  code, so the oracle survives in a less obvious form. Worse than either honest
  option, because it looks addressed.

### Analysis

DOMAIN.md settles this directly: *"The API should not disclose whether an
inaccessible application exists."* That rules out A and C.

Worth being clear that this is a real trade, not a free win. Option B costs
operability: support loses the ability to tell a mistyped identifier from a
wrong-account session by looking at the response. The mitigation is to log the
distinction server-side, where the customer cannot see it, so the information
still exists for whoever is entitled to it.

### Decision

**Option B.** Both cases return `404` with an identical body. The distinction is
written to the server log at `warn` level, where the caller cannot read it.

### Consequences accepted

- Support diagnosis for this class of problem requires log access, not just the
  HTTP response.

### Verification

The test asserts the two responses are **byte-for-byte identical**, not merely that
both are `404`:

```ts
expect(foreign.statusCode).toBe(missing.statusCode);
expect(foreign.body).toBe(missing.body);
```

This is deliberate. Asserting only on the status code would still pass if someone
later added a distinguishing message to the body — which is Option C, the version
that looks fixed and is not. The assertion is written so that regression fails.

---

## D3 — What to do about the permissive CORS policy

**Issue:** [ISSUES.md #1](ISSUES.md), compounding factor.

### Context

```ts
// apps/api/src/app.ts:20
void app.register(cors, { origin: true });
```

`origin: true` reflects whatever origin the request carries, which means any
website may make credentialed cross-origin requests to this API and read the
response.

While examining this, something worth checking first: **does anything actually
need CORS here?**

The web app fetches the API from `apps/web/src/api.ts`, which is imported by
`app/applications/[applicationId]/page.tsx` — an async React Server Component
marked `force-dynamic`. That fetch runs **on the Next.js server**, not in the
browser. There is no browser-originated request to the API anywhere in this
repository.

CORS is a browser mechanism. Server-to-server requests ignore it entirely.

### Options

**Option A — remove the CORS registration.**

- Removes the attack surface completely rather than narrowing it.
- Nothing in the repository needs it, so nothing breaks.
- Against it: anyone who later adds a browser-side fetch will hit a confusing CORS
  error with no hint of why. Needs a comment explaining the deliberate absence.

**Option B — restrict to an allow-list from an environment variable**, defaulting
to the local web origin.

- Keeps browser access possible for future work while closing the hole.
- Against it: it configures a mechanism nothing uses, and an unused allow-list
  tends to be copied into production with the local default still in it. It also
  implies browser access is expected, which is misleading about how the web app
  actually talks to the API.

**Option C — leave it and document it in `DESIGN.md`.**

- Zero risk of breaking the local setup; keeps the slice tight.
- Against it: it is a one-line removal of a real hole that compounds the exact
  vulnerability being fixed in the same breath. Deferring it would be hard to
  justify given the cost.

### Analysis

The interesting part of this decision is not the trade-off, it is the observation
that the feature is unused. Between "reflect every origin" and "carefully
allow-list origins for a mechanism no caller uses", the honest answer is neither.

Option B is the instinctive choice and is worse than it looks: it leaves
configuration that must be maintained and reviewed forever, in exchange for
enabling a call pattern this architecture does not use. If the web app ever does
need to call the API from the browser, that is a deliberate architectural change
and re-adding CORS should be part of it.

The counter-argument for B is real though: removing CORS makes the API unusable
from a browser-based tool, including things like a future internal admin page or
a developer poking at it from the console. Worth naming rather than pretending
the removal is free.

### Decision

**Option A.** The `@fastify/cors` registration was removed, along with the
dependency itself, and replaced by a comment above `buildApp` recording why the
absence is deliberate.

### Consequences accepted

- A future browser-side caller must consciously re-introduce CORS with a specific
  allow-list. That is the correct amount of friction for reopening this.
- The API is no longer reachable from browser dev-tools or a browser-based
  internal tool without that change. This is a real cost, not a free win.

### Verification

The claim under test was that no browser ever calls this API, so removing CORS
breaks nothing. Verified by running the full stack and loading the page:

```text
GET http://127.0.0.1:3000/applications/app_home_001   -> 200
rendered: "Amina Hassan", "EGP 250,000", "Submitted", "Application received"
```

The page renders its data completely, which only happens if the fetch succeeded —
and it succeeded with no CORS support present, confirming it runs server-side.

The origin is also no longer reflected:

```text
$ curl -D - -H 'Origin: https://evil.example' .../v1/applications/app_home_001
(no access-control-* headers in the response)
```

---

## D4 — How to enforce idempotency on partner events

**Issue:** [ISSUES.md #2](ISSUES.md) — a retried partner event is processed as new.

### Context

The partner delivers events **at least once**: it retries when it does not receive a timely acknowledgement, so the same logical event can arrive two or more times. This is normal and is not a partner defect — at-least-once is what any reliable delivery mechanism guarantees, and the burden of collapsing repeats onto a single effect sits with the receiver.

Each event carries `eventId`, the partner's stable identifier for it. We persist that value as `sourceEventId` and never read it back.

DOMAIN.md: *"An accepted logical event should have exactly one effect on the application history and should request at most one customer notification."*

### Options

**Option A — check before writing, in application code.**

```ts
const existing = await database.applicationStatusHistory.findFirst({
  where: { applicationId, sourceEventId: event.eventId },
});
if (existing) return /* duplicate */;
```

- No schema change; the rule is readable in one place.
- Against it: this is **check-then-act**, and it races. Two retries arriving concurrently both run the read, both see nothing, and both write. The window is narrow, but it is exactly the window a retry lands in — a partner that retries on timeout tends to deliver the repeat while the first request is still in flight, which is when the race is *most* likely, not least.
- The database still permits duplicate rows, so the invariant lives only in code and any future write path can violate it.

**Option B — a unique constraint, and treat the violation as the duplicate signal.**

Add `@@unique` on the event identifier and let the insert fail:

```ts
try {
  await database.applicationStatusHistory.create({ ... });
} catch (error) {
  if (isUniqueViolation(error)) return /* duplicate */;
  throw error;
}
```

- The database enforces the invariant, so it holds against concurrency and against code paths that have not been written yet. This is the only option that makes duplication *impossible* rather than *unlikely*.
- Against it: control flow by exception, which reads poorly; it depends on a vendor error code (`P2002` in Prisma); and the ordinary non-duplicate path is harder to follow.

**Option C — a unique constraint *and* a pre-check.**

The pre-check handles the ordinary duplicate cleanly; the constraint catches the concurrent one.

- The common case is readable and cheap, and correctness does not depend on the pre-check being right — the constraint is the actual guarantee.
- Against it: two paths to the same outcome, so both need testing, and a reader may mistake the pre-check for the enforcement mechanism. Worth a comment saying which one is load-bearing.

**Option D — a dedicated idempotency-key table.**

A separate `ProcessedEvent` table keyed on the event identifier, storing the original response so a retry can be replayed verbatim. This is the Stripe-style pattern, and what the IETF `Idempotency-Key` header draft describes.

- Generic across endpoints, and it can return the *original* response rather than a recomputed one — which matters when the response contains something non-reproducible.
- Against it: a table, a write, and a retention policy for one endpoint whose natural key already exists in the data. It also risks becoming a second source of truth that can disagree with the domain tables.
- The right answer at ten endpoints with varied payloads. Overbuilt at one.

### Analysis

The decisive question is where the invariant lives. Option A puts it in code, and code that races is code that will eventually produce the duplicate history rows this issue is about. Options B, C and D put it in the database.

Between B and C the difference is ergonomic, not behavioural — both are race-safe because both rely on the constraint. C's pre-check is a fast path and a clearer common case, not a correctness mechanism, and that distinction should be written down next to it so nobody later "simplifies" by deleting the constraint.

Option D is the correct destination if this system grows more integration endpoints, and is worth describing in `DESIGN.md` for that reason. Building it now would mean maintaining a general mechanism for a single caller whose events already carry a perfectly good natural key.

### Implementation note — this decision needs a transaction

Option C's pre-check is only meaningful inside a transaction with the writes it guards, and the three writes in `recordStatusEvent` are currently un-transacted ([ISSUES.md #4](ISSUES.md)). Idempotency and atomicity are the same change: a dedupe check that commits independently of the write it protects is not a dedupe check. They are therefore implemented together.

### Decision

**Option C.** `recordStatusEvent` now runs entirely inside `database.$transaction`, and within it:

1. loads the application, or raises `ApplicationNotFoundError`;
2. queries history for `(applicationId, sourceEventId)` — the fast path;
3. inserts the history row, catching `P2002` as the authoritative duplicate signal;
4. updates the application and inserts the notification job;
5. returns `ACCEPTED` or `DUPLICATE`.

The comment above the `catch` records which of steps 2 and 3 is load-bearing, so a later reader does not mistake the pre-check for the guarantee and remove the constraint.

### Consequences accepted

- Two code paths produce `DUPLICATE`, and both need tests — see the verification note below, which turned out to matter more than expected.
- Duplicate detection depends on a Prisma-specific error code (`P2002`). Isolated in `isUniqueViolation`, so a database or ORM change has one place to update.

### Verification

`apps/api/src/__tests__/status-events.test.ts`. Before the change, a redelivery produced two history rows and two notification jobs; it now produces one of each.

The constraint present in the database, not merely in the schema file:

```text
ApplicationStatusHistory_applicationId_sourceEventId_key
  ON "ApplicationStatusHistory"("applicationId", "sourceEventId")
NotificationJob_applicationId_sourceEventId_type_key
  ON "NotificationJob"("applicationId", "sourceEventId", "type")
```

**A test that did not prove what it claimed.** The first version of this suite issued three redeliveries through `Promise.all` and asserted a single effect, under the name *"holds the invariant when redeliveries are processed concurrently"*. It passed. Instrumenting `isUniqueViolation` and the pre-check with counters showed why that was misleading:

```text
constraint path hits: 0
pre-check path hits:  3
```

SQLite serialises writes, so `Promise.all` over `app.inject` produces no database-level concurrency. All three duplicates resolved via the pre-check, and the branch the whole decision rests on was never executed — a test named after concurrency, proving only repetition.

It was replaced by two tests. One covers repeated delivery and says plainly in a comment what it does not prove. The other simulates the race window directly: the pre-check is forced to report nothing while the row already exists, so the insert reaches the database and the constraint rejects it. Re-instrumenting confirms that branch now executes:

```text
constraint path hits: 1
```

This is worth recording because the misleading version is the one a reviewer would have accepted. It was green, it was named correctly for the intent, and it asserted the right outcome — it simply reached that outcome through the wrong code path.

---

## D5 — What the uniqueness key should be

**Issue:** [ISSUES.md #2](ISSUES.md), follow-on from D4.

### Context

Given that a unique constraint is the mechanism, its **scope** decides which events count as "the same event". Getting this wrong either fails to deduplicate, or rejects legitimate traffic.

### Options

**Option A — `sourceEventId` globally unique.**

- Simplest, and correct if the partner's identifiers are globally unique, which DOMAIN.md implies by calling it *"the partner's stable event identifier"*.
- Against it: it trusts the partner's identifier space. If the partner ever reuses an identifier across two different applications — a counter reset, a per-account sequence, a test fixture leaking into production — we would silently reject a **legitimate event for a different application**, and the failure would look like a duplicate rather than like a bug.

**Option B — composite `(applicationId, sourceEventId)`.**

- Scopes deduplication to the resource the event is about. A partner identifier collision across applications is harmless.
- The `applicationId` is already in the URL path, so it is available without trusting the body.
- Against it: it will not catch a partner genuinely misrouting an event, because the same identifier under a different application is treated as distinct.
- Slightly wider index.

**Option C — composite including a hash of the event content.**

- Would also catch a partner reusing an identifier for *different* content.
- Against it: it inverts the purpose. Two deliveries of the same logical event that differ in some incidental field would hash differently and both be accepted — the exact duplication we are preventing. Content hashing answers "have I seen these bytes", not "have I seen this event".

### Analysis

A and B differ in which failure they prefer. Option A prefers to reject a legitimate event rather than accept a duplicate; Option B prefers the reverse.

For this system, B is the safer error. The identifier is controlled by an external party we do not govern, and a false "duplicate" would silently drop a real status change — a customer never learning their loan was approved. A missed cross-application duplicate, by contrast, is a partner-side routing bug that would be visible in the history of an application that should not have received it.

The same reasoning applies to `NotificationJob`, with one addition: it also carries a `type`, and a single event may legitimately produce more than one kind of notification later. Scoping to `(applicationId, sourceEventId, type)` keeps that door open and incidentally fixes the idempotency-key collision noted in [ISSUES.md #7](ISSUES.md).

`ApplicationStatusHistory.sourceEventId` is nullable and stays nullable — history may later record events with no partner origin. Standard SQL treats NULLs as distinct in a unique index, so nullable rows are unaffected by the constraint.

### Decision

**Option B.** `@@unique([applicationId, sourceEventId])` on `ApplicationStatusHistory`, and `@@unique([applicationId, sourceEventId, type])` on `NotificationJob`.

The existing `@@index([sourceEventId])` was kept on both. It is not redundant: a composite index cannot serve a lookup on `sourceEventId` alone, because it is not the leftmost column — so an operator query for "everything from this event" still needs it.

### Consequences accepted

- A partner misrouting an event to the wrong application is not detected here. It would surface as an unexpected entry in that application's history, which is where it should be investigated.
- Two extra unique indexes on the write path. Negligible at this volume, and the cost is the point.

### Verification

A test sends the same `eventId` to two different applications and asserts both are `ACCEPTED`, with two history rows and two jobs — the case Option A would have wrongly suppressed.

---

## D6 — What the partner sees for a duplicate delivery

**Issue:** [ISSUES.md #2](ISSUES.md) and [#8](ISSUES.md).

### Context

DOMAIN.md requires the adapter to *"distinguish malformed input, an unknown application, a duplicate delivery, a stale or invalid state change, and an accepted state change in a way its caller can operate safely."*

Five outcomes, and a duplicate has to be tellable from an acceptance. This decision also sets the response shape that stale and invalid transitions will reuse, so it is worth settling once rather than three times.

### Options

**Option A — return the same `202` as a fresh acceptance.**

- Trivially safe for the partner: a retry looks like it worked.
- Against it: it discards the distinction DOMAIN.md asks for. An operator reconciling delivery counts cannot tell how much of the traffic was repeats, and a partner cannot detect that it is retrying unnecessarily.

**Option B — `409 Conflict`.**

- Semantically defensible: the request conflicts with state already recorded.
- Against it: it is an **error** code, and a well-behaved partner retrying after a timeout would see its correct, expected behaviour reported as a failure. That tends to trigger alerting, backoff, or escalation for something working as designed. An idempotent endpoint should make a safe retry *succeed*, not fail.

**Option C — `200 OK` carrying an explicit outcome discriminator.**

```json
{ "outcome": "DUPLICATE", "application": { ... } }
```

- Distinguishable by a machine-readable field rather than by status code. Both outcomes answer `200`; see the note below on why `202` is dropped entirely rather than reserved for one of them.
- The field generalises to the remaining outcomes — `ACCEPTED`, `DUPLICATE`, `STALE`, `INVALID_TRANSITION` — giving the partner one thing to switch on rather than a set of status codes to memorise.
- Against it: a new field in the response contract, and two signals (code and field) that must not be allowed to disagree.

### Analysis

Option B is the instinctive choice and is wrong for the same reason `403` was wrong in D2: it optimises for semantic tidiness over how the caller actually behaves. A retry is the partner doing the right thing; answering it with an error teaches the partner to treat correct behaviour as a fault.

Option C's discriminator is the part worth keeping. Modelling the outcome as a tagged value rather than inferring it from a status code means the remaining outcomes in this slice slot into the same contract, and the partner's handling stays a single exhaustive switch.

**Related, and settled here:** the endpoint currently answers `202 Accepted` although the work is committed before the response is written ([ISSUES.md #8](ISSUES.md)). `202` tells the caller the outcome is still pending. Since this decision is already reshaping the response, `ACCEPTED` becomes `200`, and `202` is left for a future version that genuinely defers the work.

**Also settled here:** the response currently returns the full `ApplicationView`, handing the partner the customer's name, email address and phone number. The partner sends a status and needs an acknowledgement, not contact details. The response is narrowed to the application's own fields.

### Decision

**Option C.** Both `ACCEPTED` and `DUPLICATE` answer `200`, discriminated by the `outcome` field. Customer contact details are removed from the partner response.

An earlier draft of this entry proposed `202` for `ACCEPTED` and `200` for `DUPLICATE`, using the status code as a second signal. That was dropped on implementation: it contradicted the same entry's conclusion that `202` misdescribes synchronously-committed work, and it would have left the status code and the `outcome` field as two signals capable of disagreeing. One discriminator is better than two that must be kept consistent.

### Consequences accepted

- A partner that inspects only the status code cannot tell an acceptance from a duplicate. This is deliberate — the contract requires reading `outcome` — but it is a real constraint on naive clients and should be stated in partner-facing documentation.
- `ApplicationView` remains the customer-facing shape; `ApplicationSummary` is the partner-facing one. Two projections of one entity is a small amount of duplication accepted in exchange for the partner never receiving contact details.

### Verification

See `apps/api/src/__tests__/status-events.test.ts`.

---

## D7 — How to detect and handle a stale event

**Issue:** [ISSUES.md #3](ISSUES.md) — a late-arriving older event overwrites newer state.

### Context

Events can arrive out of order. The application already carries `lastEventOccurredAt`, written on every event and read by nothing.

DOMAIN.md: *"Current state must describe the newest accepted business event, not merely the last HTTP request received."*

Two questions, and they are usually conflated: **how** do we know an event is stale, and **what** do we do with one.

### Options — detection

**Option A — compare `occurredAt` against the denormalised `lastEventOccurredAt`.**

- Uses the field already on the row; one comparison, no extra query.
- Against it: the value is a denormalised copy of the maximum `occurredAt` in history. Two sources of truth that can drift — a manual data fix touching history and not the application row would silently break ordering.

**Option B — compare against `MAX(occurredAt)` in history.**

- Single source of truth. History is append-only, so the maximum is authoritative by construction.
- Against it: an extra query inside the transaction. Covered by the existing `@@index([applicationId, occurredAt])`, so it is an index scan, not a table scan.

**Option C — require a monotonic sequence number from the partner.**

- The only mechanism that is robust against clock problems entirely: ordering becomes a partner-assigned integer rather than a timestamp we have to trust.
- Against it: the partner does not send one. It is a contract change, so it cannot be built here — but it is the right production answer and belongs in `DESIGN.md`.

**Option D — vector clocks or a version vector.**

- The general distributed-systems answer to ordering without a shared clock.
- Against it: there is exactly one writer of application state. The machinery solves a problem this system does not have.

### Options — handling

**Option E — reject the event; write nothing.**

- DOMAIN.md enumerates *"a stale or invalid state change"* separately from *"an accepted state change"*, so a stale event is by definition not accepted, and only accepted events have an effect on history.
- Against it: the arrival of a late event is operationally interesting, and dropping it leaves no trace.

**Option F — record it in history but do not change current status.**

- Preserves evidence that the event arrived, and history stays a complete record.
- Against it: history is specified as customer-visible. Showing a customer a status entry that is not, and never was, their status is misleading — and it directly contradicts the "exactly one effect for an accepted event" wording by giving an unaccepted event an effect.

**Option G — reject the event, and record it in a separate audit log.**

- Keeps customer-visible history clean while preserving the operational evidence.
- Against it: there is no audit-log table, and adding one is a larger change than this slice justifies.

### Analysis

On detection, A and B differ only in robustness against drift. B removes the possibility of the two values disagreeing, at the cost of one indexed query inside a transaction we are already holding. For a correctness rule guarding financial state, buying out an entire class of silent failure for one indexed read is worth it. `lastEventOccurredAt` continues to be maintained, but as a derived convenience rather than the authority.

On handling, the distinction that resolves F is between **domain history** and an **audit log**. They are different artefacts with different audiences: history is the customer's record of what happened to their application, an audit log is the operator's record of what the system was told. Conflating them is what makes F tempting. The correct destination is G; the honest interim is E plus a structured log line, with the audit table described in `DESIGN.md`.

**Ties.** If `occurredAt` exactly equals the newest recorded event, the incoming event is *not* older. Since true redeliveries are already caught by the idempotency check on `eventId`, an equal timestamp with a different `eventId` is a genuinely distinct event, and rejecting it would silently drop a real status change. Ties are therefore accepted, and the comparison is strictly-older (`occurredAt < newest`). The consequence is that the relative order of two events sharing a timestamp is decided by arrival order — an acceptable ambiguity given the alternative is data loss.

### Decision

**Option B for detection, Option E for handling.** The check compares `occurredAt` against the newest `occurredAt` in history, served by the existing `@@index([applicationId, occurredAt])`. A stale event returns `STALE`, writes nothing, and is logged at `warn` with the outcome, the current status and the attempted status.

`lastEventOccurredAt` is still maintained on the application row, but it is now explicitly a derived convenience for reading, not the authority for the ordering decision.

### Consequences accepted

- One additional indexed read per event, inside a transaction that is already open.
- A stale event leaves no durable record. The log line is not queryable evidence; the audit table in `DESIGN.md` is what makes it so.
- Two events sharing a timestamp are ordered by arrival, since ties are accepted rather than rejected.

### Verification

`apps/api/src/__tests__/event-ordering.test.ts`, and live against the seeded data:

```text
IN_REVIEW  @ 10:30  -> ACCEPTED  [200]
SUBMITTED  @ 09:00  -> STALE     [200]   status stays IN_REVIEW
```

Before the change the second request rewound the application to `SUBMITTED`.

A dedicated test asserts that a stale event adds no history row and no notification job, and another asserts a tie is accepted rather than silently dropped.

---

## D8 — How to express and enforce the transition rules

**Issue:** [ISSUES.md #6](ISSUES.md) — illegal and post-terminal transitions are accepted.

### Context

`APPLICATION_STATUSES` is a flat list of names. DOMAIN.md gives a graph:

```text
SUBMITTED -> IN_REVIEW -> OFFERED -> APPROVED -> DISBURSED
                        \-> DECLINED
              \---------------------> DECLINED
```

**The diagram is ambiguous, and the ambiguity is material.** The two `DECLINED` branches originate at column positions that do not line up unambiguously with a single source state: the first sits between `IN_REVIEW` and `OFFERED`, the second inside `IN_REVIEW`. Read strictly, it is unclear whether a decline is permitted from `OFFERED`, from `APPROVED`, or only from the two earliest states.

This is a question for the partner or product owner in a real engagement. It is recorded here, and in `PLAN.md`, as an assumption rather than a fact.

### Options — the rule set

**Option A — strict literal reading.** Only the transitions unambiguously drawn:

```text
SUBMITTED -> IN_REVIEW | DECLINED
IN_REVIEW -> OFFERED   | DECLINED
OFFERED   -> APPROVED
APPROVED  -> DISBURSED
```

- Faithful to the narrowest reading of the document.
- Against it: it makes a decline after an offer impossible. If the partner legitimately declines a loan after offering it — the ordinary outcome of a failed final check — we reject a real event and the customer's application freezes at `OFFERED` forever. The failure is silent and the customer is stranded.

**Option B — `DECLINED` reachable from any non-terminal state.**

```text
SUBMITTED -> IN_REVIEW | DECLINED
IN_REVIEW -> OFFERED   | DECLINED
OFFERED   -> APPROVED  | DECLINED
APPROVED  -> DISBURSED | DECLINED
DECLINED  -> (terminal)
DISBURSED -> (terminal)
```

- Matches how lending actually works: an application can fail its checks at any point before the money moves.
- Consistent with the diagram showing multiple decline branches rather than one.
- Against it: more permissive than the strictest reading, so it would accept a decline the business may consider impossible.

**Option C — enforce terminal states only.** Reject anything after `DECLINED` or `DISBURSED`, allow any other transition.

- Catches the worst case — the declined loan that became disbursed — with almost no risk of rejecting a legitimate event.
- Against it: it permits obvious nonsense such as `SUBMITTED -> DISBURSED`, skipping every check. On a lending product, a path straight from application to money is precisely the transition worth blocking.

### Options — where the rule lives

**Option D — a transition map in `packages/contracts`.** A `Record<ApplicationStatus, readonly ApplicationStatus[]>` beside the status list, shared by any consumer.

**Option E — a state machine library** (XState or similar). Powerful, and overbuilt for six states and one transition function.

**Option F — a database `CHECK` constraint.** Cannot express this: the rule depends on the *previous* row's status, which a row-level check cannot see.

### Analysis

The rule set is the interesting choice, and it is a question of which error to prefer — the same shape as D5.

Option A prefers rejecting a legitimate decline over accepting an illegitimate one. Its failure mode is bad: a real decline is dropped, the customer is left indefinitely at `OFFERED`, and nothing alerts anyone because a rejection is a normal outcome. Option C prefers the reverse and permits `SUBMITTED -> DISBURSED`, which is the single most dangerous transition in the domain.

Option B sits between them and errs in the direction that matches the business: declines happen late, disbursement does not happen early. It blocks both catastrophic cases — post-terminal changes and check-skipping — while accepting every transition a real lender would produce.

**Self-transitions.** The graph contains no self-loops, so `IN_REVIEW -> IN_REVIEW` is rejected as invalid. This is the spec-faithful reading, but it is a genuine judgement call: a partner may legitimately send repeated same-status updates carrying a new `reason` ("documents received", then "income verification started"). Under this rule the second is rejected and its reason is lost. Recorded in `PLAN.md` as an open question for the partner, because the cost of being wrong is silent loss of customer-visible detail.

On placement, Option D puts the rule next to the statuses it constrains, in the package both the API and the web app already depend on. Option E buys features — guards, side effects, visualisation — that a single pure function does not need.

### Decision

**Option B, expressed via Option D.** `ALLOWED_TRANSITIONS` and `canTransition` live in `packages/contracts` beside `APPLICATION_STATUSES`, with the ambiguity in the source diagram documented in the code where someone changing the rule will read it.

### Consequences accepted

- The decline-from-`OFFERED` and decline-from-`APPROVED` edges are an **assumption**, not a documented fact. If the partner says a decline is impossible after an offer, the map is the single place to change, and a test will fail rather than behaviour drifting silently.
- Self-transitions are rejected, so a partner sending repeated same-status updates with a new `reason` would lose the later reason. Recorded in `PLAN.md` as an open question.
- `status` remains a `String` column with the rule enforced in application code. A database-level enum would be stronger; SQLite has none, and a `CHECK` constraint cannot express a rule that depends on the previous row.

### Verification

`apps/api/src/__tests__/event-ordering.test.ts` covers the documented forward path end to end, a late decline, and the two transitions that must be blocked. Live:

```text
SUBMITTED -> DISBURSED   -> INVALID_TRANSITION [409]   status unchanged
DECLINED  -> DISBURSED   -> INVALID_TRANSITION [409]   status unchanged
OFFERED   -> DECLINED    -> ACCEPTED           [200]
```

The second line is the regression that motivated the rule: before this change, a declined loan could be disbursed.

**An interaction this surfaced.** Adding the transition check broke the constraint-race test written for D4, which had been passing. The simulation put the second call *after* the first had committed, so the application had already advanced to `IN_REVIEW` and the new self-transition rule rejected the call before it ever reached the insert — the test was asserting `DUPLICATE` and got `INVALID_TRANSITION`.

The failure was correct, and it exposed that the original simulation did not match a real race. In a genuine race both requests observe the *pre-event* application status, because neither has committed; the losing request fails at the constraint, not at the transition check. The test was rebuilt to reconstruct that window properly: a history row is inserted directly for an application still at `SUBMITTED`, reproducing the instant when a competing request has written history but not yet updated the application. Re-instrumenting confirms the constraint branch still executes (`constraint path hits: 1`).

---

## D9 — What HTTP status the new outcomes should carry

**Issue:** follow-on from [D6](DECISIONS.md).

### Context

D6 established `outcome` as the discriminator and gave both `ACCEPTED` and `DUPLICATE` a `200`. Two more outcomes now join the union, and they are not obviously the same kind of thing.

### Options

**Option A — every outcome returns `200`.**

- Maximally consistent with D6: one discriminator, no possibility of the status code and the field disagreeing.
- Against it: monitoring and alerting infrastructure generally works on status codes without parsing bodies. A partner sending nonsensical transitions would be invisible on every dashboard, and a genuine integration fault would look like healthy traffic.

**Option B — `200` for `ACCEPTED`, `DUPLICATE` and `STALE`; `409 Conflict` for `INVALID_TRANSITION`.**

- Draws the line at *"is anything actually wrong?"* A duplicate is a correct retry. A stale event is the network reordering delivery, which is expected and outside the partner's control. An invalid transition is neither — it is either a partner defect or a real business conflict, and somebody should look at it.
- The two signals answer different questions rather than duplicating one: the status code says whether something went wrong, the `outcome` field says what happened.
- Against it: it is a second signal, and D6 argued against exactly that.

**Option C — a distinct code per outcome** (`200`, `200`, `409`, `422`).

- Maximum information in the status line.
- Against it: it forces the partner to map four codes and a field that already carries the same information, and invites the two to drift.

### Analysis

The tension with D6 is real but narrower than it looks. D6 rejected using the status code to distinguish *an acceptance from a duplicate* — two outcomes that are both entirely normal, where an error code would have misreported correct partner behaviour as a fault. It did not establish that every outcome must share a code regardless of severity.

Option B keeps that principle: nothing normal is reported as an error. It adds only the distinction between "handled" and "something is wrong", which is the distinction status codes exist to carry. `STALE` is deliberately on the `200` side — late delivery is the network behaving as networks do, not the partner misbehaving, and a partner cannot fix it by retrying.

### Decision

**Option B.** `ACCEPTED`, `DUPLICATE` and `STALE` return `200`; `INVALID_TRANSITION` returns `409`. Every non-accepted outcome is logged at `warn` with the event id, the current status and the attempted status.

### Consequences accepted

- Two signals now exist where D6 argued for one. The rule keeping them consistent is narrow and stated in the route: `409` if and only if the outcome is `INVALID_TRANSITION`.
- A partner treating any non-2xx as retryable will retry an invalid transition pointlessly. The `outcome` field tells them not to, and partner-facing documentation should say so explicitly.

### Verification

Asserted per outcome in both API test files, and confirmed live — see the transcript under D8.

---

## D10 — How a notification job's state should be represented

**Issue:** [ISSUES.md #5](ISSUES.md) — failed deliveries are marked complete and never retried.

### Context

`NotificationJob` carries `attemptCount`, `nextAttemptAt`, `processedAt` and `lastError`. The retry machinery was modelled and then not implemented: `processedAt` is set in a `finally` block, so success and failure are recorded identically, and `nextAttemptAt` is never written.

A job needs to be in exactly one of: waiting to be tried, delivered, or exhausted. DOMAIN.md also requires that *"an operator should be able to inspect and replay exhausted work"*, which means "exhausted" has to be a thing you can query for.

### Options

**Option A — keep the current columns; infer state from them.**

Set `processedAt` only on success; on failure write `nextAttemptAt`. A dead job is then `processedAt IS NULL AND attemptCount >= MAX_ATTEMPTS`.

- No schema change.
- Against it, decisively: **the definition of "exhausted" moves when the retry policy is tuned.** Raising `MAX_ATTEMPTS` from 5 to 8 would silently resurrect every previously-dead job, because deadness was never recorded — it was recomputed from a constant. A job's terminal state must be a fact about the job, not a function of today's configuration.
- The state is also implicit: an operator has to know the rule to write the query.

**Option B — an explicit `status` column.**

`PENDING | DELIVERED | DEAD_LETTERED`, with the timestamps demoted to describing *when* things happened rather than *what* the state is.

- The state is a stored fact. `WHERE status = 'DEAD_LETTERED'` is the operator query, and it stays correct across policy changes.
- The polling query becomes an equality match on an indexed column.
- Against it: a schema change, and `status` plus `processedAt` can drift if a future write path sets one without the other.

**Option C — add a `deadLetteredAt` timestamp only.**

`processedAt` means delivered, `deadLetteredAt` means exhausted, both null means pending.

- Smaller change than B, and still records deadness as a fact.
- Against it: "pending" remains implicit — the absence of two things. Two mutually-exclusive nullable timestamps is a state machine encoded in nulls, which is the shape that produced this bug.

### Analysis

Option A is disqualified by the policy-coupling problem rather than by taste. A retry policy is exactly the kind of thing that gets tuned during an incident, and a tuning change that silently alters which historical jobs count as dead is a trap.

Between B and C, the deciding question is what an operator has to know. Under C, finding pending work means knowing that pending is "neither of these two columns is set". Under B it means asking for it. The redundancy risk in B is real but narrow, and it is contained by having exactly one function that writes terminal state.

`processedAt` is kept and given a single clear meaning — when the job reached a terminal state, whichever one — so no information is lost from the existing schema.

### Decision

**Option B.** `NotificationJob.status` is `PENDING | DELIVERED | DEAD_LETTERED`, defaulting to `PENDING`. The polling index changed from `[processedAt, nextAttemptAt]` to `[status, nextAttemptAt]`, and `processedAt` now means "when the job reached a terminal state", whichever one.

### Consequences accepted

- `status` and `processedAt` could drift if a future write path sets one without the other. Contained by having every terminal write happen in one function.
- `status` is a `String`, not a database enum, because SQLite has none. Same limitation as `LoanApplication.status`; noted in `DESIGN.md`.

### Verification

`apps/worker/src/__tests__/process-notifications.test.ts`. The decisive assertion is that a failed delivery leaves `status = PENDING` and `processedAt = null` — under the previous code it was recorded as complete and never polled again.

---

## D11 — The retry schedule

**Issue:** [ISSUES.md #5](ISSUES.md).

### Context

`MockEmailProvider` fails for any address ending `@retry.invalid`, and the seed data contains such a customer. A failed attempt must become eligible again later, but not immediately and not forever.

### Options

**Option A — fixed delay.** Retry every *n* seconds.

- Trivial to reason about and to test.
- Against it: it treats a two-second blip and a two-hour outage identically. During a long outage every job hammers the provider at a constant rate for the whole duration, which is the behaviour most likely to delay the provider's own recovery.

**Option B — exponential backoff.** Delay doubles each attempt.

- Retries are dense when the fault is likely transient and sparse when it is clearly not, which is the correct shape.
- Against it: with no cap, later attempts drift arbitrarily far out. And on its own it has a failure mode of its own — see C.

**Option C — exponential backoff with jitter.**

- Solves the problem B leaves: when a provider outage fails a whole batch at once, every job in that batch computes the *same* delay and retries in the same instant, re-creating the load spike that the backoff was supposed to spread. Randomising each delay decorrelates them.
- Against it: retry timing is no longer deterministic, so tests must assert on a range rather than an exact value.

**Option D — exponential, jittered, capped, with a bounded attempt count.**

- C plus an upper bound on the delay and a limit after which the job is dead-lettered rather than retried forever.
- DOMAIN.md asks for a *"bounded retry policy"*, which requires both bounds: bounded delay and bounded attempts.

### Analysis

D is C plus the two limits DOMAIN.md names, so the real choice is whether jitter earns its complexity. It does, and the reason is specific to this system: notification jobs are created in bursts by partner traffic and processed in batches of twenty, so a provider outage fails many jobs within the same second. Without jitter they would retry in lockstep — a synchronised retry storm, which is precisely the pathology backoff exists to prevent.

Concretely: base 1s, factor 2, cap 5 minutes, 5 attempts, full jitter (the delay is a random value between zero and the computed ceiling). Base and attempt count are small enough that the behaviour is observable in a local run against `@retry.invalid`.

The values are module constants overridable by environment variable, not per-job columns. A per-job policy is a real requirement in mature queues; it is speculative here.

### Decision

**Option D.** Base 1s, factor 2, cap 5 minutes, 5 attempts, full jitter, all overridable by environment variable. `nextAttemptDelayMs` takes an injectable random source so the schedule can be asserted deterministically.

### Consequences accepted

- Retry timing is non-deterministic by design, so tests assert the ceiling and the spread rather than an exact delay.
- Full jitter can produce a very short delay. The worker's poll interval floors it in practice, and the decorrelation is the point.
- The policy is global rather than per-job. Per-job policies matter in a mature queue; here it would be speculative.

### Verification

Unit tests assert the ceiling doubles per attempt (1s, 2s, 4s, 8s), that it stops at the 5-minute cap, and that four different random draws produce four different delays all within the ceiling.

Observed end to end against the seeded `omar@retry.invalid` customer, whom `MockEmailProvider` always rejects, with a shortened base and 3 attempts:

```text
job ... failed on attempt 1, retrying in 213ms: mock provider is temporarily unavailable
job ... failed on attempt 2, retrying in 276ms: mock provider is temporarily unavailable
job ... dead-lettered after 3 attempt(s): mock provider is temporarily unavailable

status=DEAD_LETTERED attempts=3 nextAttempt=None
```

The two delays differ, which is the jitter working: without it both would have been identical, and a whole failed batch would retry in lockstep.

---

## D12 — Whether to distinguish permanent failures from transient ones

**Issue:** [ISSUES.md #8](ISSUES.md) — a missing application is treated as retryable.

### Context

The loop currently catches everything and treats it the same. One of the things it catches is *"application `X` no longer exists"*, which will be equally true on every future attempt.

### Options

**Option A — retry everything.**

- Simplest, and safe in the sense that nothing is discarded early.
- Against it: a permanently broken job consumes its entire retry budget and five provider round trips to reach a conclusion available at the first attempt. It also pollutes retry metrics, hiding real transient failures among failures that were never going to succeed.

**Option B — classify at the throw site.** A distinct error type for failures known to be permanent; anything else is transient.

- Permanent failures dead-letter immediately, with the reason recorded, so an operator sees them straight away rather than five backoff intervals later.
- Against it: the classification is a judgement that can be wrong, and misclassifying a transient fault as permanent discards work that would have succeeded. Errs conservatively: only failures that are *definitionally* permanent are marked so.

**Option C — let the provider declare retryability.** A typed provider error carrying a `retryable` flag, mapped from the vendor's HTTP status or error code.

- The correct production shape: a real email provider distinguishes a 429 or 503 from a 400 or a hard bounce, and only the provider knows which is which.
- Against it: `MockEmailProvider` throws a bare `Error`, so there is nothing to map yet. Building the mapping now would be designing against an imagined API.

### Analysis

B is the available increment and C is the destination. The one case that is unambiguously permanent today is a job whose application no longer exists — no number of retries makes a deleted row reappear. That is marked permanent; everything else, including any provider failure, stays transient.

Worth noting the direction of the risk: treating a permanent failure as transient wastes attempts and delays visibility, while treating a transient failure as permanent loses a notification. So the classification is deliberately narrow.

### Decision

**Option B.** `PermanentNotificationError` is thrown for two cases: an application that no longer exists, and a stored payload that will not parse. Both dead-letter on the first attempt with the reason recorded. Everything else, including any provider failure, retries.

### Consequences accepted

- The classification is a judgement encoded in two throw sites. Kept deliberately narrow, because the cost of being wrong is asymmetric: a misclassified permanent failure wastes attempts, a misclassified transient one loses a customer notification.
- Real provider errors are all treated as transient until the provider can tell us otherwise, so a hard bounce currently consumes the full retry budget. Option C is the fix and is described in `DESIGN.md`.

### Verification

**A finding while testing this.** The test for the missing-application case failed to even set itself up:

```text
Raw query failed. Code: `787`. Message: `FOREIGN KEY constraint failed`
```

Under the current schema that state is unreachable. A foreign key prevents a job pointing at a missing application, and the relation cascades on delete, so removing an application removes its jobs with it. The branch — which existed in the original code too — is defence in depth against foreign keys being disabled, a restore from an inconsistent backup, or a future schema without the cascade.

Rather than corrupt the database to reach it, the test now stubs the application read and asserts the branch behaves correctly, with a comment recording that it is unreachable in normal operation and why. The permanent-failure *policy* is proven separately through the unreadable-payload case, which is genuinely reachable because `payload` is an unconstrained `String` column.

This is worth recording because the alternative was quietly deleting a test that would not set up, and losing the observation with it.

---

## D13 — How an operator inspects and replays exhausted work

**Issue:** [ISSUES.md #5](ISSUES.md).

### Context

DOMAIN.md: *"An operator should be able to inspect and replay exhausted work."* Once D10 makes dead-lettering a stored fact, inspection is a query — but replay needs something that exists.

### Options

**Option A — document the SQL and stop there.**

- Zero code. `prisma studio` is already wired up, so inspection genuinely works today.
- Against it: replay by hand-editing rows is exactly the operation you do not want performed manually at 3am under pressure. It is also not really a capability, and the requirement is explicit.

**Option B — exported functions plus a small script.** `listDeadLetters` and `replayDeadLetter`, with a runnable entry point.

- Replay becomes one reviewed code path with defined semantics: reset to `PENDING`, clear the schedule, make it eligible immediately, preserve `attemptCount` and `lastError` as history.
- Testable, which a SQL runbook is not.
- Against it: a script is not an interface. It requires shell access to the environment.

**Option C — an HTTP endpoint.**

- A real operator interface, usable from a tool.
- Against it: it is an privileged endpoint on a service whose only authentication is a customer-id header taken on trust. Adding an unauthenticated replay endpoint would be a worse security problem than the one already fixed in D1. Proper operator authentication is `DESIGN.md` territory.

### Analysis

C is right in production and wrong here, because the authentication it needs does not exist and inventing it is a larger project than the slice. A is not enough given the requirement is stated outright.

B gives the operation a defined, tested implementation, and moving it behind an authenticated endpoint later is then a transport change rather than a rewrite of the semantics.

Replay deliberately preserves `attemptCount` and `lastError` rather than resetting them: the fact that a job previously exhausted its retries is evidence, and a replayed job that fails again should be visibly on its second life.

### Decision

**Option B.** `listDeadLetters` and `replayDeadLetter` in `apps/worker/src/dead-letters.ts`, with a CLI at `pnpm dead-letters list | replay <jobId>`.

`replayDeadLetter` uses a conditional `updateMany` on `{ id, status: "DEAD_LETTERED" }` and treats a zero-row result as an error, so the status check and the write are one statement — replaying a job that is not dead-lettered cannot slip through a gap between a read and a write.

### Consequences accepted

- Replay requires shell access to the environment. An authenticated operator endpoint is `DESIGN.md` work.
- A replayed job keeps its attempt count, so it gets exactly one further attempt before returning to the dead-letter queue. This is intentional — replay should not silently re-trigger a full round of provider calls — but it is surprising unless stated, so the CLI prints it.

### Verification

The full operator loop, live:

```text
$ pnpm dead-letters list
1 dead-lettered notification job(s):
  id            820a45a3-...
  application   app_auto_002
  event         seed-event-003 (APPLICATION_STATUS_CHANGED)
  attempts      3
  last error    mock provider is temporarily unavailable

$ pnpm dead-letters replay 820a45a3-...
Job returned to the pending queue. It keeps its attempt count, so it has one
further attempt before dead-lettering again.

status=PENDING attempts=3 processedAt=None
```

Tests cover the round trip, a replayed job that succeeds, a replayed job that fails again and dead-letters immediately, and refusal to replay a delivered job — the last because replaying one would send the customer a duplicate.

---

## D14 — Two smaller worker fixes included with the above

Neither warrants its own options table; both are recorded because they change behaviour.

**The provider idempotency key.** It was `job.sourceEventId`, which collides across notification types for the same event — two different emails about one event would share a key and a provider honouring it would suppress the second. Changed to `${applicationId}:${sourceEventId}:${type}`, matching the uniqueness scope chosen in D5. The natural key is preferred over `job.id` because it stays stable if a job row is ever recreated for the same logical notification.

**Shutdown.** `shutdown()` set `stopping = true` and immediately disconnected Prisma while a batch could still be in flight, and never exited the process — so `SIGINT` hung and could tear down the connection under an in-flight write. The loop now signals, waits for the current batch to finish, then disconnects and exits.
