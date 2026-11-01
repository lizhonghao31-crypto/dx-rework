# GitHub Actions Usage Constitution v2.1

Status: P0 mandatory for `lizhonghao31-crypto/dx-rework`.

## Purpose

GitHub Actions is an evidence layer, not a development scratchpad. Diagnosis and targeted checks happen before pushing; GitHub validates an intended PR Head.

## Gate selection

Every PR is classified **before creation** and its title must start with exactly one prefix:

- `[QUICK]` — low risk; push light checks, then explicitly request final Quick.
- `[FULL]` — high risk; push light checks, then explicitly request final Full.

Only the final heavy levels are mutually exclusive. Both modes run push light checks before Review. A Full-title push must not allocate the expensive Full worker; a Quick request must not allocate it either. Body/wording/reopen events cannot start final heavy work. The explicit immutable request and exact-Head proof are defined in [the supported protocol](review-first-final-head-20261027.md).

High-risk means migration/schema, auth/permissions, financial or quantity semantics, core workflow/approval/audit/idempotency, cross-module critical behavior, deployment/infrastructure/Actions, shared platform changes, or P0/P1 fixes.

## Execution policy

1. Do not push iterative debugging commits when the same diagnosis and repair can be completed before push.
2. Known incomplete changes must not be pushed.
3. Related code/tests/migration/manifest changes are prepared as one intended Head.
4. A new Head, actual base tip or risk mode invalidates prior final evidence; require the current complete tuple and actual job success. Skipped same-name checks or old receipts cannot approve merge.
5. Quick Gate stays lightweight: exact Head, governance guard, install, lint, typecheck, workspace build without root `postbuild`, migration static lint and secret scan. It must not run PostgreSQL, full migration replay, backup/restore, PR-17 acceptance, release packaging, browser installation or preview.
6. Full Gate owns heavy validation, runs only on an explicit final Full request at the actual PR Head, and retains the original diff risk map and all applicable required stages. Light success cannot substitute for it.
7. Automatic PR Preview and standalone Governance runners remain disabled for ordinary PR events.
8. No noop commit may be created only to trigger CI.
9. A failed job may be rerun once on the same Head. Repeated failure requires root-cause diagnosis before another run.
10. Local checks → push light checks → required GitHub Codex Review → consolidate Review/self-check repairs → freeze final Head → explicitly request the classified final Gate → evidence check → authorized merge. A normally completed Review is not repeatedly requested after each concentrated repair. From the posted request's server time, fifteen minutes without conclusion is abnormal: first check completion/new requests, then reopen under the standing user authorization. No code push or CI rerun accompanies a Review retry. Service failure is not success; denied/uncertain sends require reconciliation.
11. Review does not authorize Codex construction; implementation remains with the current ChatGPT Work/assistant unless the business owner explicitly requests Codex coding.

## Machine guard

`scripts/ci/verify-actions-policy.mjs` enforces light-before-final routing, reusable-only Full, bounded selected workers, actual receipts, read-only contents permission, no automatic Preview/Governance runners, and stale-run cancellation. Native Node regressions exercise the actual workflow conditions and controller/runtime decisions. The operator helper verifies exact Head/base/mode, Review threads, actual run/job success and executed-check receipts; it does not change server settings or merge by itself. Current visible protection is off and the detail API is 403: inaccessible policies remain unknown, and direct owner merge cannot be prevented by this code alone. No settings change is claimed.

Weakening or bypassing this policy requires explicit business-owner approval.

## Digital production integration branch

PRs targeting `release/digital-production-v1` use the same light-first, explicitly requested exact-Head Quick/Full Gates as PRs targeting `main`. This exact branch is explicitly allowed; unrelated release branches are not enabled. Gate classification binds the actual remote base tip and PR Head; stale base snapshots cannot approve a newer tuple. This does not enable deployment, Preview or extra runners.

## Approved unified-plan stacked PR bases (2026-10-21)

The authorized P01—P15 implementation keeps every PR unmerged until group release approval. `unified-p*` base branches therefore use the same exact-Head light-first final gates. This adds only the planned stacked base namespace: no deployment, Preview, additional runner, permission or sensitive-domain exemption is enabled. The first PR still targets `release/digital-production-v1`; subsequent PRs target their dependency branch. Group candidate boundaries remain P06, P12 and P15. When a dependency is repaired or rebased, downstream Heads must be synchronized and retested.

## Approved Full Gate budget (updated 2026-10-24)

The user explicitly approved a fixed **30-minute job budget for every Full Gate** on 2026-10-24, replacing the earlier same-repository `unified-p` 30-minute / other-head 20-minute split. Quick Gate stays at 5 minutes. This changes the heavy worker upper limit, not individual test timeouts or checks. The 2026-10-27 approved routing change is separately described above: the same worker is explicit after Review; request/certification jobs each have a two-minute bound. No extra token scope, secret, Preview or deployment is enabled. The machine guard requires exactly one explicit 30-minute Full timeout and rejects larger, missing, repeated, zero, null or conditional budgets.

The first update missed synchronizing `unified-gate-budget.test.ts`; that deterministic test mismatch caused run40065813917 to fail before PostgreSQL stages. It was an omitted test update, not a flaky test or business failure. The budget regression now checks the current authorization and keeps the invalid-budget and Quick-limit negative cases.

Evidence: P07 c6ec6a46 run39519276659/job118959096890 started00:07:19 UTC; normal suite ran00:09:32—00:14:10 (4m38), mappedPG00:14:30—00:18:52 (4m22), Root audit53s, canonical29/33700:19:45—00:25:37 (5m52), low-privilege recovery00:25:43—00:27:34 (1m51), PR17 acceptance5s. Packaging started00:27:39 after successful preceding stages; cancellation at00:28:00 interrupted it without an assertion failure. The previous fixed 20-minute job limit is insufficient for this observed complete workload. Thirty minutes gives bounded headroom for packaging and runner variance, rather than omitting/reducing checks or repeatedly rerunning for timing luck. Original cancelled runs remain evidence, never a pass. The first same-head retry had already been requested before this budget instruction; a real budget-fix push supersedes it via original stale-run cancellation.

## Exact SLA dependency bases (approved 2026-10-25)

The user approved adding only `deliver/sla-foundation-development-budget-20261024` and `deliver/sla-preparation-cutting-dispatch-20261024` to the Quick/Full pull-request base filters, enabling the existing #855/#856 dependency chain before integration. The policy guard enforces these exact names and rejects wildcard/unapproved additions. This does not change gate selection, contents, risk thresholds, timeout, permissions, unrelated-edit filtering, concurrency, Review or deployment. The change is carried by #855 and inherited by #856; #854's validated tree is unchanged. `pull_request` evaluates the workflow at its event merge ref; each existing checkout still validates the explicit PR Head. A later base edit continues to trigger the existing checks and must not be silently suppressed or reported as reused evidence.

## Evidence and cost closeout

Record baseline, old test health, complete scope and failure/retry/concurrency matrix before pushing. At each checkpoint report actual last result/current command/blocker rather than only a plan. Freeze one assembled repair after collecting Review and same-scope findings. Keep exact final SHA/run/job/attempt, Review request timestamps and findings closure, merge/tree and passed/failed/unrun boundaries. Record light/heavy counts and actual durations; do not infer model speed or coding hours from missing timestamps. Existing risk classification, same-Head transient retry limit and no-noop rules remain in force. Platform protection, tokens or installation scopes require separate explicit authorization and must never be silently changed.

## Approved engineering execution contract (2026-11-01)

The owner approved one governance PR for canonical local/CI execution, elimination of same-context duplicate/unrelated work, and separation of release integration, independent Acceptance, and production promotion. The immutable Head/base, Review-first order, actual receipts, 30-minute Full worker, production exact-main source guard and permission/security boundaries remain mandatory.

`test-preflight.mjs` runs native Node protocol and time-inventory checks, changed/managed resource registration and migration lint before heavy work. A fresh labelled, low-privilege PostgreSQL fixture then proves initialization and actual failed-child cleanup before broad suites. Non-DB discovery excludes database suites; `test-suite-plan.mjs` and `run-business-chain-gate.mjs --full-gate` are the same local/CI PostgreSQL entry. The Root audit group is explicit rather than hidden test-file imports. Mapped, chain and Root memberships are unioned once; each executable file must have a real passing assertion. Receipts bind Head/base, CI run/attempt or explicit local execution ID, live database OID/user/server version, Node, finite config and resource contract, and require cleanup. They cannot reuse evidence across Heads or runs. No cross-head cache is introduced.

Migration and checksum-bound permission inventory require real upgrade/Root/ACL, backup recovery and multi-version low-privilege maintenance, without automatically selecting activation/packaging. Actual maintenance executors, activation and transport use separate flags; unclassified deployment logic remains conservative. Selected steps and certification recompute the same scope. A skipped non-applicable lifecycle stage is explicitly non-applicable, never credited as executed.

For release PRs, compatibility uses `--intent integration --baseline-ref <actual frozen base>`. The independent Acceptance launcher uses `--intent acceptance` plus its trusted live identity/history/owner preflight. Current-main additions are explicit publication TODOs with production promotion and application semantics unverified. Production intent retains strict main inclusion; production tools retain their exact-main and real-ledger checks. No intent flag accepts a user-supplied DB identity as proof. This replaces the prior unconditional main-history prerequisite for every release/Acceptance update under the owner's current governance authorization; it is not a temporary skip switch. See [the evidence and handoff](../engineering/engineering-efficiency-20261101.md).
