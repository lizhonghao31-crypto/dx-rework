# SLA delivery candidate: foundation, development and budget

Candidate restored from pr04-local-checkpoint/working-tree-before-pr05.tar.gz (90 saved files), not copied from the mixed WIP. Baseline original PR02 47756fcd4f5b06d1e15dd671654642912b158f34 retains original PR01/02 history. Current release 77a15f2f980d5d66c0312cc8d33b48544f289870 merged locally solely to retain the existing #853 CI event/build/summary fixes. No main changes or release writes.

Scope: canonical policy references and compatibility migration0254; development enrollment0255; original development main chain, external patterns and independent numbered revisions; shared budget final merchandiser freeze; original three approval todo windows and owner/root authority. Shared API, task and native event connections are a single dependency-closed candidate. PR01/02 original branches/PRs remain unchanged; this candidate carries their original commits rather than reimplementing them.

Excluded: PR05–08 later local business changes; unfinished PR09 settings/in-flight application; PR10 completion; Acceptance test clock. All remain preserved in WIP0ee7bd457a813be8a3fd1ceb859437f0ce616c4b and existing checkpoints. This is not completion of the full authorized SLA model. No fabrication of cutter receipt, shipping-sample gates, separate shipment registration or historical completion.

Slow-test diagnostics change only sourcing-pr03-postgres.test.ts and full-business-chain-postgres.test.ts. Each main beforeAll logs schema_migration_ms then fixture_ms; afterAll logs cleanup_ms; sourcing C05 setup logs fixture_c05_ms. performance.now is monotonic; each phase uses finally, completed/failed status, and only suite/phase/ms/status. Missing phases do not become zero. Assertions, waits, migration coverage and isolation unchanged. Full business chain and C05 diagnostics are to be collected by the one necessary CI, not rerun locally.

Local checks: API/Web typecheck passed. Foundation/config/plan/shared-budget targeted regressions15 passed; selected development enrollment/external pattern/revision/source-transfer4 passed; original approval-owner/root2 passed. Source suite emitted schema1252ms, fixture25ms, cleanup607ms in this local run; these are local evidence, not hosted-runner forecasts. No local Full run. Existing API errors in unfinished PR09 are excluded by checkpoint restoration, not hidden or patched.

UI historical component-browser evidence remains in prior engineering record; no new claim of complete authenticated-app acceptance. Deployment account compatibility, full CI and remaining business groups are unverified. No Review/merge/deployment authorization executed for this candidate.

## 2026-10-25 concentrated #854 repair — local candidate, not pushed

Reference Head: `76ef086784a0bde5920fab695784c96e63a02609`; release base: `77a15f2f980d5d66c0312cc8d33b48544f289870`; main: `67841e105fe7090e219477171d3cf79565719241`. Splitting is paused by the latest user decision. No remote mutation, new CI or Review was performed in this repair pass.

### Repairs assembled locally

- The six effective-quantity transfer cases now prepare crafts through the actual release management-decision entry. Transfer payloads cannot change crafts; route rejection coverage explicitly includes both craft IDs and names. Corrected quantities, price-increase owner approval, frozen lines/crafts/dates, audit-event matching, idempotency, original-history preservation and late transaction rollback assertions remain.
- Raw SQL negative cases assert the release remainder guard and immutable-event guard, then check their precise error branches instead of assuming main's constraint name. This is not proof of upgrade convergence: see the separate blocker below.
- Current contract version status no longer disappears merely because the current cycle has no return timestamp. Upload wording uses the current-document file count, while historical signed attachments remain readable.
- Returned approval todos keep both their original deadline and original snapshot reference. Missing historical basis or deadline remains unknown; the latest configuration cannot be attached to an old deadline. Snapshot lookup is restricted to the same mother order. This is a narrowly reused existing fix, not import of the P5–6 batch.

### Actual local verification

PostgreSQL **16.2**, local loopback isolated test database, restricted runner with the repository test-database marker verified. No production or Acceptance database access.

One concentrated Vitest run using `vitest.business-chain.config.ts`:

| File | Passed | Failed / skipped |
| --- | ---: | ---: |
| development-sla-enrollment-postgres | 18 | 0 / 0 |
| digital-budget-shared-postgres | 2 | 0 / 0 |
| digital-journey-postgres | 23 | 0 / 0 |
| digital-production-identity-postgres | 37 | 0 / 0 |
| digital-sla-configuration-postgres | 9 | 0 / 0 |
| digital-sla-plan-postgres | 4 | 0 / 0 |
| full-business-chain-postgres | 58 | 0 / 0 |
| sourcing-factory-change-routes | 8 | 0 / 0 |
| sourcing-pr03-postgres | 121 | 0 / 0 |
| sourcing-todo-sla | 9 | 0 / 0 |
| **Total, 10 files** | **289** | **0 / 0** |

Command: Node 22.22.2 / Vitest 4.1.10 `run` with exactly the ten files above, `--config vitest.business-chain.config.ts --reporter=default --reporter=json`. The database URL was supplied only as the local test environment variable. Evidence: `/workspace/.pg854-isolated/final-related-result.json` and `final-related.log`. An earlier targeted effective-quantity run passed six selected cases; its 115 unselected cases were not counted as additional coverage.

- ESLint on all five changed source/test files: exit 0, zero warnings.
- `tsc --noEmit -p apps/api/tsconfig.json` and Web equivalent: exit 0.
- `tsc -p apps/api/tsconfig.json`: exit 0. This compiled the API; it was not a deployment/package-recovery test.
- Web `vite build`: exit 0; existing large-chunk warning remains, no unrelated bundle work.
- `npm audit --omit=dev --audit-level=high --json`: exit 0, zero high/critical; seven moderate findings in Fastify/AJV/fast-uri dependencies remain. Read-only audit used the available npm 11.9.0 client with Node 22; dependency/lock files were not modified.
- `contract-transfer-delivery-browser.mjs`: **32/32** scenarios passed with real page/component code and intercepted synthetic local HTTP, not an authenticated deployed-app acceptance. Viewports include 1440/1280/768/390/360 widths. Covers role visibility, pending submit, duplicate-click prevention, nearby errors, retained retry input/key, POST-success/load-failure distinction, current versus old contract cycle, price-only submission and existing owner approval. Screenshot inspection confirmed existing visual style and no horizontal overflow. Narrow-screen screenshots include the existing fixed bottom navigation; they are not full-page captures. Evidence `/workspace/daxing-pr854-ui-20261025-final/browser-result.json` plus PNGs.

This is scoped local evidence, **not Full Gate success**, deployed-state verification, migration recovery coverage or business acceptance. Existing Review fixes remain in the reference Head and native-chain regression; no new Codex Review conclusion is claimed.

### Blocking upgrade convergence: requires scope decision before push

The actual migration runner was tested against fresh and exact release-base histories in separate disposable schemas. Release-base migrations were executed from their unchanged files and real checksums; all prior receipts/checksums/timestamps remained unchanged after upgrade.

- Fresh build through reference Head ends with 0236's `sourcing_factory_remaining_lines` guard.
- Exact release-base upgrade starts with that guard, but reconciliation executes missing main migration `0230_sourcing_factory_change_current_quantity` after already-applied 0236 and leaves the **whole-order quantity** guard instead.
- Therefore fresh and upgraded databases end with different transfer rules. The 289 passing tests use fresh schemas and do not disprove this defect.

Reproduction uses `discoverValidatedMigrations`, `migrationExecutionSql` and `applyMigrations`; local script `/workspace/.pg854-isolated/check-854-upgrade.mjs`. It creates/drops only its own `pr854_guard_*` schemas after test-target validation. No historical migration, manifest, receipt or checksum was edited.

Existing later candidate `1c349f86` contains a forward convergence migration 0261, but #854 ends at 0255; 0256–0260 belong to later batches. Taking 0261 alone violates the current contiguous-migration rules. Taking all intervening schemas, renumbering existing migrations, editing 0230/0236, fake receipts or bypassing compatibility checks is outside the current authorization and has not been done.

Consequently #854 cannot be described as independently safe to upgrade. Migration implementation and push/CI are paused pending an explicit decision on the forward repair's place in the dependency chain. Existing 855/856 and their unpushed candidates are untouched. The local code/test repairs above are preserved and can continue once that boundary is resolved; no promise that the entire Gate has only these previously observed failures.

Smallest prospective scope adjustment: allocate the next forward convergence migration to #854, then re-sequence only later migrations proven never applied, together with their candidate manifests/tests. This affects the #855/#856 dependency chain and cannot be authorized implicitly as a fixture fix. Whether all those later migration identities are unused in every environment that must be retained is currently **unknown**; no production investigation or renumbering was performed. If existing identities must all be retained, the alternative is to defer independent upgrade eligibility until the later schema sequence and 0261 are integrated, which does not meet the current requirement that #854 alone be safe. This is the exact unresolved trade-off, not a request to import the entire later business implementation.

### Route B explicitly selected — 2026-10-25 12:02 UTC

The user selected **B**, superseding the prospective renumbering option and the temporary push hold above. Keep all migration identities/checksums. #854 is a **code batch, not independently deployable**. The forward convergence repair remains 0261 in the later dependency chain; do not move it or add P5–8 features here. Existing 855/856 and the saved 7216176b/1c349f86 candidates are unchanged.

Only the six-file local repair set documented above is being delivered. Previously passing 289 tests and 32 browser scenarios remain applicable because production/test content has not changed since those runs; documentation-only updates do not require repeating them. Additional directly affected static contract tests, migration-file validation and changed-worktree secret scanning are checked before commit. Untracked `.compat-local.json` is local evidence and is excluded.

The existing exact-diff classifier selects Full Gate, database/migration/business-chain/deployment checks, PG13 Journey compatibility and ten mapped PostgreSQL files. The current Full job limit remains 30 minutes, not a duration guarantee. One stable push to the existing PR starts its necessary run; no workflow/risk-map/timeout change or duplicate dispatch is part of this work.

Route B does not waive any existing gate. If a real upgrade-behavior assertion fails because the later convergence repair is absent, preserve that failure and report it; do not suppress it or report code-batch green as deployment approval. Even a completely green #854 run does not resolve the separately reproduced fresh-versus-release-upgrade guard mismatch. Final deployment eligibility requires the complete follow-on migration sequence including 0261, fresh/main/release upgrade convergence, retained receipt/checksum evidence, quantity/approval/audit/rollback regressions, and final P1–8 integration/acceptance. No merge, deployment, PR closure, new Review request or production-data operation is authorized in this step.

Pre-push completion: ten additional directly affected unit/contract files passed **35/35** in 1.73 seconds; migration static validation and worktree secret scan exited 0; `git diff --check` clean. Original 289 and browser 32 evidence was not rerun. Remote main/base/PR Head were reconfirmed unchanged immediately before the intended commit. Prior Codex Review's two P1 issues are already repaired in the reference ancestry and exercised by the native-chain regression. This new six-file change is not claimed to have a new Codex Review; no duplicate request was sent.

Final shared-call review found an omission in the first Route B push (`332fd65c`): the reader expected the original `slaTiming.snapshotId`, but `TodoService` had not yet persisted it. The first Full run 40191623189 was explicitly cancelled after discovering this incomplete connection, not a test success or infrastructure failure. Do not reuse it as final Gate evidence. The lookup now runs before the immutable todo.create event, which captures the same dueAt/snapshotId subsequently inserted in the todo in the same transaction. Legacy/unrelated todos add no SLA payload. Real SLA04 PostgreSQL cases for owner/root verify initial persisted snapshot/date and their preservation after return (2 passed; 119 unselected). Related original todo and sourcing regressions are rechecked because the shared creation path changed; unchanged browser/config/plan checks are not needlessly repeated.

Snapshot-write correction verification: complete sourcing suite **121/121**, original todo routes **5/5**, SLA adapter **9/9** passed after the shared write-path change; modified files lint and API typecheck exited 0. The separate legacy `todo-notification-foundation-postgres` fixture produced **1 pass / 3 fail**: it only installs 0001–0028, while unchanged current delivery code needs `current_sourcing_case_lines` (0193+) and unchanged access code needs `app_users.manual_access_disabled`. Failures occur in delivery-worker/access-service, not in the modified snapshot lookup/write path; source/fixture comparison confirms this mismatch predates this delta (no baseline rerun claimed). This optional extra suite is not in the exact-diff mapped list and is not weakened or reported green. It remains a known partial-schema fixture limitation. Combined diagnostic run: 136 pass / 3 fail / 0 skip, not a fully passing run. Evidence: `snapshot-connection-regressions.json`. The two SLA04 owner/root cases explicitly assert that the actual todo.create audit stores its originating snapshot ID and deadline and preserves both after return. All original role denial, finance, audit and quantity assertions remain.
