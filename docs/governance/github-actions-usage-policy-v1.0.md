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
