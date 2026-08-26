# Tooling

What I used, why, how I used it, and — the part that actually matters — how I checked its output.

## What I used

| Tool | Version / model | Used for |
|---|---|---|
| **Claude Code** | Claude Opus 5 (1M context) | Exploration, implementation, drafting the written deliverables |
| Vitest | 3.2.7 | The test suite, and the probe suite used during assessment |
| TypeScript | 5.9.3 | `tsc --noEmit` per package |
| ESLint | 10.9.0 | Lint |
| Prisma CLI | 6.19.3 | Schema, client generation, `db push` |
| Next.js | 15.5.23 | `next build` |
| `curl` | — | Live verification against a running API |
| Python `sqlite3` | stdlib | Reading indexes and rows directly out of the SQLite file |

No web search and no documentation lookup were needed: the repository is small, the stack is one I know, and DOMAIN.md answered the domain questions. I did not use any tool I could not check the output of.

## Why this set

**Claude Code with Opus 5**, because the interesting part of this exercise is not typing speed — it is reading an unfamiliar system quickly, holding the whole thing in view while deciding what matters, and keeping a reasoned record of why each fix took the shape it did. Long context suits that: the entire repository is small enough to reason about at once, so nothing had to be summarised or forgotten between decisions.

**The repository's own toolchain for verification**, deliberately. The value of `pnpm test`, `tsc` and `next build` here is that they are indifferent to how the code was produced. A model can be confidently wrong; a failing type check cannot be talked round.

**`curl` and direct SQLite reads** because assertions inside the test process share the process's assumptions. Querying the database file directly is how I confirmed the unique indexes physically exist rather than merely appearing in `schema.prisma`, and `curl` against a running server is how I confirmed the HTTP contract rather than what `app.inject` reports.

## How I used it

The shape of the work, in order:

1. **Clone, install, run the baseline.** Established that lint, typecheck, build and 4 tests were green *before* any change, so later failures could be attributed.
2. **Write a throwaway probe suite** exercising each suspected defect through the real Fastify app and the real worker against a real database. Deleted afterwards; its findings are folded into the shipped tests. This is what turned a reading of the code into `ISSUES.md`.
3. **Prioritise, then agree scope** before writing any fix.
4. **For each issue: enumerate options, argue the trade-offs, choose, then implement.** The options considered and rejected are in [DECISIONS.md](DECISIONS.md). A diff cannot show you an alternative that was weighed and discarded, which is why that file exists.
5. **Verify each change three ways**: a focused test, the full gate (lint, typecheck, tests, build), and live behaviour against a running system.
6. **Write the deliverables last**, from what was actually built.

An important process note: **I chose the options; the tool laid them out.** At each decision point the alternatives and trade-offs were presented and I selected, sometimes after pushing back. That is why the decision log reads as a set of judgements rather than a changelog.

## How I checked the output

This is the section I would want to be asked about. The short version: **I did not trust anything I had not seen fail.** Three times that discipline caught something a green test suite was hiding.

### 1. A test that passed while proving nothing

The first concurrency test fired three redeliveries through `Promise.all`, asserted a single effect, and was named *"holds the invariant when redeliveries are processed concurrently"*. It passed.

I did not believe it, because I could not explain *how* it would fail. So I instrumented both dedupe branches with counters and re-ran:

```text
constraint path hits: 0
pre-check path hits:  3
```

SQLite serialises writes, so `Promise.all` over `app.inject` produces no database-level concurrency. All three duplicates resolved via the pre-check, and **the unique constraint — the entire point of the decision — was never executed.** A test named after concurrency, proving only repetition.

It was replaced with two tests: one covering repeated delivery that states in a comment what it does not prove, and one that reconstructs the race window directly. Re-instrumented to confirm: `constraint path hits: 1`.

**This is the one worth dwelling on, because the misleading version is the one a reviewer would have accepted.** Green, correctly named for its intent, asserting the right outcome — and reaching that outcome through the wrong code path.

### 2. A later change proved the first fix's test was still wrong

Adding the state-machine check broke that rebuilt race test. It expected `DUPLICATE` and got `INVALID_TRANSITION`.

The failure was correct, and it exposed a flaw I had not seen: the simulation ran the second call *after* the first had committed, so the application had already advanced and the new self-transition rule rejected it before the insert. In a genuine race **both requests observe the pre-event state**, because neither has committed — the loser fails at the constraint, not at the transition check.

Rebuilt again, properly: insert a history row directly for an application still at `SUBMITTED`, reproducing the instant when a competing request has written history but not yet updated the application. Confirmed by instrumentation a third time.

### 3. A test that could not set itself up revealed a dead branch

The test for "application no longer exists" failed before asserting anything:

```text
Raw query failed. Code: `787`. Message: `FOREIGN KEY constraint failed`
```

That state is unreachable under the current schema: a foreign key stops a job pointing at a missing application, and the relation cascades on delete, so removing an application removes its jobs with it.

The easy move was to delete a test that would not run. Instead the branch is kept as defence in depth, tested through a stubbed read with the unreachability documented, and the permanent-failure *policy* is proven separately through a malformed payload — which is genuinely reachable, because `payload` is an unconstrained `String` column.

### 4. Type checking caught what passing tests did not

After adding the idempotency tests, all tests were green and `tsc` was not:

```text
status-events.test.ts(59,5): error TS2322: Type 'unknown' is not assignable to 'InjectPayload | undefined'
```

An `unknown` payload type in a test helper broke Fastify's overload resolution and cascaded into five errors. The tests passed because at runtime the object was fine. This is the argument for running the whole gate rather than the part that looks relevant.

### 5. Checking the database rather than the schema file

Adding `@@unique` to `schema.prisma` proves nothing about the running database. I read the indexes out of the SQLite file directly:

```text
ApplicationStatusHistory_applicationId_sourceEventId_key
  ON "ApplicationStatusHistory"("applicationId", "sourceEventId")
NotificationJob_applicationId_sourceEventId_type_key
  ON "NotificationJob"("applicationId", "sourceEventId", "type")
```

### 6. Live verification of every claim about behaviour

Each finished piece was exercised against a running system, not only through `app.inject`:

```text
owner reads own application         -> 200
foreign customer reads it           -> 404   (was 200 + email + phone)
nonexistent application             -> 404   byte-identical body
Origin: https://evil.example        -> no access-control-* headers

README's own curl example           -> ACCEPTED            [200]
same event again                    -> DUPLICATE           [200]
event dated earlier                 -> STALE               [200]
DISBURSED, skipping checks          -> INVALID_TRANSITION  [409]

job … failed on attempt 1, retrying in 213ms
job … failed on attempt 2, retrying in 276ms
job … dead-lettered after 3 attempt(s)
```

Two things that only live checks would show. The web app still renders after CORS was removed — which is the actual proof the fetch was server-side all along, and therefore that removing CORS was safe. And the two retry delays *differ*, which is the jitter working: without it a whole batch failing together would retry in lockstep.

### 7. Verifying claims in the written deliverables

Before submitting, I re-checked the factual assertions in `DESIGN.md` against the code rather than against memory — that the intake route really does log the full event including free-text `reason`, that `MockEmailProvider` really does ignore the idempotency key, that `--accept-data-loss` really is in the scripts, that the status columns really are `String`. Design notes drift from reality faster than code does.

## What I did not let the tool decide

- **Scope.** The slice was chosen deliberately and the exclusions are argued in `ISSUES.md`. The tool's instinct is to fix everything it finds; most of the value here was in *not* doing that.
- **Ambiguities in the spec.** DOMAIN.md's transition diagram is genuinely ambiguous. That is recorded as an assumption in three places rather than resolved silently ([PLAN.md](PLAN.md) question 1).
- **Whether a test is meaningful.** Three times a suite was green and wrong. Passing is evidence, not proof.

## Honest limits

- Generated code was reviewed, but review is weaker than execution. The things I trust most are the assertions that were watched to fail before they passed.
- The verification is only as good as the questions asked. Concurrency was checked because I doubted it; something I did not think to doubt would not have been caught this way.
- Everything about behaviour under real contention is reasoned rather than observed, because SQLite cannot demonstrate it ([PLAN.md](PLAN.md) limitation 8).
