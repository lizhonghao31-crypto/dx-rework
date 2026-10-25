# GitHub Actions Usage Constitution v2.0

Status: P0 mandatory for `lizhonghao31-crypto/dx-rework`.

## Purpose

GitHub Actions is an evidence layer, not a development scratchpad. Diagnosis and targeted checks happen before pushing; GitHub validates an intended PR Head.

## Gate selection

Every PR is classified **before creation** and its title must start with exactly one prefix:

- `[QUICK]` — low-risk change; run Quick Gate only.
- `[FULL]` — high-risk change; run Full Gate only.

The workflows are mutually exclusive by title. A `[FULL]` PR must not allocate the Quick Gate hosted job. A `[QUICK]` PR must not allocate the Full Gate hosted job.

High-risk means migration/schema, auth/permissions, financial or quantity semantics, core workflow/approval/audit/idempotency, cross-module critical behavior, deployment/infrastructure/Actions, shared platform changes, or P0/P1 fixes.

## Execution policy

1. Do not push iterative debugging commits when the same diagnosis and repair can be completed before push.
2. Known incomplete changes must not be pushed.
3. Related code/tests/migration/manifest changes are prepared as one intended Head.
4. Any new Head invalidates prior Gate evidence.
5. Quick Gate stays lightweight: exact Head, governance guard, install, lint, typecheck, workspace build without root `postbuild`, migration static lint and secret scan. It must not run PostgreSQL, full migration replay, backup/restore, PR-17 acceptance, release packaging, browser installation or preview.
6. Full Gate owns heavy validation and runs only for `[FULL]` PRs.
7. Automatic PR Preview and standalone Governance runners remain disabled for ordinary PR events.
8. No noop commit may be created only to trigger CI.
9. A failed job may be rerun once on the same Head. Repeated failure requires root-cause diagnosis before another run.
10. Codex Review starts only after the required Gate passes on the final intended Head. Default maximum is one Review; a second requires a real P0/P1 repair or explicit business-owner approval.
11. Review does not authorize Codex construction; implementation remains with the current ChatGPT Work/assistant unless the business owner explicitly requests Codex coding.

## Machine guard

`scripts/ci/verify-actions-policy.mjs` enforces the mutually exclusive `[QUICK]` / `[FULL]` topology, lightweight Quick Gate, no automatic Preview/Governance runners, and stale-run cancellation.

Weakening or bypassing this policy requires explicit business-owner approval.

## Digital production integration branch

PRs targeting `release/digital-production-v1` use the same title-selected, exact-Head Quick/Full Gates as PRs targeting `main`. This exact branch is explicitly allowed; unrelated release branches are not enabled. Gate classification continues to use the event's actual base and head SHA. This does not enable deployment, Preview or extra runners.

## Approved unified-plan stacked PR bases (2026-10-21)

The authorized P01—P15 implementation keeps every PR unmerged until group release approval. `unified-p*` base branches therefore use the same exact-Head title-selected gates. This adds only the planned stacked base namespace: no deployment, Preview, additional runner, permission or sensitive-domain exemption is enabled. The first PR still targets `release/digital-production-v1`; subsequent PRs target their dependency branch. Group candidate boundaries remain P06, P12 and P15. When a dependency is repaired or rebased, downstream Heads must be synchronized and retested.

## Approved Full Gate budget (updated 2026-10-24)

The user explicitly approved a fixed **30-minute job budget for every Full Gate** on 2026-10-24, replacing the earlier same-repository `unified-p` 30-minute / other-head 20-minute split. Quick Gate stays at 5 minutes. This changes the upper limit, not execution speed, individual test timeouts, stage selection, exact-Head checks, triggers, concurrency, permissions, secrets, runner count, Preview or deployment. The machine guard requires exactly one explicit 30-minute Full timeout and rejects larger, missing, repeated, zero, null or conditional budgets.

The first update missed synchronizing `unified-gate-budget.test.ts`; that deterministic test mismatch caused run40065813917 to fail before PostgreSQL stages. It was an omitted test update, not a flaky test or business failure. The budget regression now checks the current authorization and keeps the invalid-budget and Quick-limit negative cases.

Evidence: P07 c6ec6a46 run39519276659/job118959096890 started00:07:19 UTC; normal suite ran00:09:32—00:14:10 (4m38), mappedPG00:14:30—00:18:52 (4m22), Root audit53s, canonical29/33700:19:45—00:25:37 (5m52), low-privilege recovery00:25:43—00:27:34 (1m51), PR17 acceptance5s. Packaging started00:27:39 after successful preceding stages; cancellation at00:28:00 interrupted it without an assertion failure. The previous fixed 20-minute job limit is insufficient for this observed complete workload. Thirty minutes gives bounded headroom for packaging and runner variance, rather than omitting/reducing checks or repeatedly rerunning for timing luck. Original cancelled runs remain evidence, never a pass. The first same-head retry had already been requested before this budget instruction; a real budget-fix push supersedes it via original stale-run cancellation.

## Exact SLA dependency bases (approved 2026-10-25)

The user approved adding only `deliver/sla-foundation-development-budget-20261024` and `deliver/sla-preparation-cutting-dispatch-20261024` to the Quick/Full pull-request base filters, enabling the existing #855/#856 dependency chain before integration. The policy guard enforces these exact names and rejects wildcard/unapproved additions. This does not change gate selection, contents, risk thresholds, timeout, permissions, unrelated-edit filtering, concurrency, Review or deployment. The change is carried by #855 and inherited by #856; #854's validated tree is unchanged. `pull_request` evaluates the workflow at its event merge ref; each existing checkout still validates the explicit PR Head. A later base edit continues to trigger the existing checks and must not be silently suppressed or reported as reused evidence.
