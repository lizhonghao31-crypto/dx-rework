# PR-144 Preflight

- repository: `lizhonghao31-crypto/dx-rework`
- base branch: `main`
- base SHA: `7b8f4c1387e606cef8fbc47c886564aaf0e485d3`
- working branch: `agent/verify-tail-flow-full-gate`
- task scope: repair the two PostgreSQL business-chain gates so they execute the mandatory N01 image rule and the N02–N07 parallel tail-inspection workflow on the current schema; close the exact text/UUID trigger defect exposed by the first real Full Gate
- allowed files:
  - `apps/api/migrations/0069_rework_image_submission_uuid_cast.sql`
  - `apps/api/src/rework/tail-inspection-service.ts`
  - `apps/api/src/platform/migration-manifest.json`
  - `tests/integration/full-business-chain-postgres.test.ts`
  - `tests/integration/root-single-account-two-pass-postgres.test.ts`
  - `tests/integration/root-self-system-admin-postgres.test.ts`
  - `tests/unit/n01-image-and-wage-integrity.test.ts`
  - `tests/unit/tail-inspection-parallel-flow.test.ts`
  - `docs/engineering/pr-144-preflight.md`
- forbidden files: production services other than the listed tail-inspection service, routes, historical migrations 0001–0068, contracts, UI, DingTalk integration, deployment configuration, secrets and environment files

The first remote Full Gate exposed a production database defect in migration 0068:
`attachments.entity_id` is text, while `rework_orders.rework_order_id` is UUID. A
forward-only 0069 migration replaces the guard function with an explicit `::text`
cast; 0068 remains byte-for-byte unchanged. No service, route, contract or UI changes
are permitted in this PR.

The second Full Gate applied 0069 successfully, then exposed that the Root audit
regression creates an isolated schema, replays the entire migration history, and
executes its authorization assertions under Vitest's 5-second default. It timed out
at 5.006 seconds without an assertion failure. That single PostgreSQL test receives a
20-second ceiling; its setup, assertions and cleanup remain unchanged.

The fourth Full Gate reached N06 and exposed a second production audit defect. The
tail-report event is correctly bound to the tail-inspection assignment for the report
insert guard, but that same event cannot authorize the order status write because the
order guard requires a `rework_order` event. When N06 completes the parallel counts,
the service now appends a separate order-transition audit event before moving the
order to `pending_order_review`; both events share the trusted request and actor.
