# GitHub Actions Usage Constitution v1.0

Status: P0 mandatory for `lizhonghao31-crypto/dx-rework`.

## Purpose

GitHub Actions is an evidence layer, not a development scratchpad. Development, diagnosis and targeted tests happen before pushing a PR Head; GitHub-hosted runners validate staged results.

## Mandatory execution policy

1. Ordinary PR Head updates may allocate only the single Quick Gate hosted job in `.github/workflows/ci.yml`.
2. Quick Gate uses fail-closed scope routing: governance-only changes skip business dependencies; safe UI-only changes must contain only `apps/web/src` CSS/TSX plus a changed unit contract test and run scoped UI dependencies, changed-file lint, web typecheck, the web dependency-chain build and the changed contract tests; every other change retains the full ordinary Quick Gate.
3. Quick Gate must not run PostgreSQL, the full test suite, migration replay, backup/restore, PR-17 acceptance, release packaging, Playwright/browser installation or preview generation/deployment.
4. Heavy validation lives in `.github/workflows/full-gate.yml` and may allocate a runner only while the PR has the `full-gate` label.
5. Once `full-gate` is present, any new Head invalidates prior Full Gate evidence and must run the Full Gate again.
6. Automatic PR Preview is disabled. Preview must never run on `opened`, `synchronize` or `reopened` without an explicit future policy change approved by the business owner.
7. Standalone Governance must not allocate a runner for ordinary PR events; governance checks are part of Quick Gate.
8. No noop commit may be created only to trigger CI. Do not push iterative debugging commits to an open PR when the same work can be diagnosed and batched locally.
9. A failed job may be rerun once on the same Head. A repeated failure requires root-cause diagnosis before any further run.
10. Codex Review starts only after the final intended Head passes Full Gate. Default maximum is one review request per PR; a second review requires an unresolved P0/P1 or explicit business-owner approval.
11. Default maximum Full Gate executions is two per PR. A third requires explicit business-owner approval and a written cause for the prior repeated failure.
12. Monthly normal-development target is at most 1,200 GitHub-hosted Linux minutes, preserving at least 800 included minutes as contingency rather than planned consumption.

## Machine guard

`scripts/ci/verify-actions-policy.mjs` runs inside Quick Gate and rejects restoration of the high-burn topology, including automatic Preview/Governance runners, unsafe widening of the UI-only allowlist, removal of UI contract-test requirements, heavy work in Quick Gate, removal of `full-gate` gating, or stale-run cancellation being disabled.

## Change control

Weakening or bypassing this policy, the machine guard, or the workflow topology requires explicit business-owner approval in the specific PR. Convenience, a failed CI run, or lack of local tooling is not approval.
