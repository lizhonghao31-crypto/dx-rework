# PR-144 Preflight

- repository: `lizhonghao31-crypto/dx-rework`
- base branch: `main`
- base SHA: `7b8f4c1387e606cef8fbc47c886564aaf0e485d3`
- working branch: `agent/verify-tail-flow-full-gate`
- task scope: repair the two PostgreSQL business-chain gates so they execute the mandatory N01 image rule and the N02–N07 parallel tail-inspection workflow on the current schema
- allowed files:
  - `tests/integration/full-business-chain-postgres.test.ts`
  - `tests/integration/root-single-account-two-pass-postgres.test.ts`
  - `docs/engineering/pr-144-preflight.md`
- forbidden files: production services, routes, migrations, contracts, UI, DingTalk integration, deployment configuration, secrets and environment files

This PR changes no production behavior. Its first remote Full Gate is intentionally
used to expose any runtime defect that the previously skipped PostgreSQL gates failed
to detect; any product-code fix found by that gate must be separately reviewed before
it is added to this PR.
