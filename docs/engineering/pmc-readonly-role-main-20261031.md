# PMC independent read-only role (main)

Base: `main@dc880453323de96599f57afafcc8f7c6f11c6756`. Role: `pmc`, display `PMC`. Scope is the approved production-management read parity; no deployment or employee grants are performed.

## Authority boundary

| Existing authority | PMC read | Writes retained only by existing roles |
| --- | --- | --- |
| Production management's 33 grants | Fixed 23 read grants in `pmc-access.ts` and migration 0232 | No copy of decision, price, supplier maintenance, assignment, approval or reporting grants |
| `tools:user` | `tools:read`: same bound-attachment ownership and existing export policy | Upload/finalize blocked before storage, at route/service and database boundaries |
| `supplier_onboarding:approve` used for reads | `supplier_onboarding:read`: same all-application/profile/version/decision/duplicate-check reads | Request, resubmit and approval paths keep their original guards |
| `todo:routing_exception_manage` used for reads | `todo:routing_exception_read`: same personal assigned-to scope | Transfer retains original manage capability and production-management role |
| Responsibility determine used to view facts | Persisted actual PMC + `external_responsibility:view` recheck, same pending queue/order facts | No synthetic management role; determine/takeover/sign/confirm/reopen flags remain false |
| Pattern, cutting, wage, external/own-factory reads | Explicit read-role lists and SQL functions | Write role lists, supplier write function and settlement-mark authority unchanged |

Authentication and SQL reject delegated write capabilities for a sole PMC identity. HTTP rejects business mutation methods, except the existing authorized export-read POSTs. Auth login/logout, download/export audit and generated export artifacts retain their technical side effects. Existing authenticated GET paths keep their domain read guards; no business-mutating GET is added. Existing supplier maintenance forms remain write-only; supplier directory/detail/history and applications are accessible for reading.

Multiple actual roles keep the existing union: PMC adds reads, never business writes, and does not remove another role's existing writes. Root remains exempt. No account is assigned automatically. Migration 0232 is the next contiguous main migration; release's separate migration inventory is not copied or reordered in this main PR.

## Local validation

Node 22.22.2 / npm 10.9.9; dedicated loopback Docker PostgreSQL 16.15 and 13.23. Test role has no superuser/createdb/createrole/replication privileges. Full genuine migrations initialize owned random schemas using the official migration library. No production or Acceptance connection is used.

- Initial 4 permission assertions failed as intended, then all passed. The expanded focused permission set (including pure/compound/Root, HTTP mutation methods, suppliers, exports and fields) passed 23/23 across four suites.
- All unit tests: 1814 passed / 2 failed initially. The cutting reader-array expectation needed the approved PMC reader; the UX source check needed the unchanged existing elevated-reader prefix retained. Both were corrected without weakening writer assertions; targeted four-suite rerun passed 23/23. Other passing cases were not repeatedly run locally.
- `pmc-readonly-postgres.test.ts`: final six tests passed on PG16.15 and PG13.23. They check the exact catalog allow/deny set; old role grants/checksums/history unchanged; no migration employee assignment; same-key migration replay; real delegated-write filtering/session policy; Root/manager/compound roles; actual supplier application reads and rejected approval/batch maintenance; scoped attachment grants and rejected uploads; generated export completion/download; inactive and foreign identity rejection.
- Existing full N01–N11/current-schema suite: PG16.15 35/35 passed. Added PMC real order/attachment/amount/responsibility history and wage HTTP/XLSX read coverage. Subsequent pending-responsibility queue/flags/rejected-save assertions were verified by the affected N01–N11 + PMC tests: 2 passed, 33 deliberately not selected.
- Real Chromium application components: existing warehouse/cutting runner 13 passed (4 PMC mobile/desktop pending/recorded cases, existing worker/Root/receiver regressions); supplier application runner 4 passed (PMC versus production management at 390/1440 widths; profile/bank data visible; approval form absent for PMC; no non-GET calls).
- Typecheck, lint, package/application builds, migration checksum lint and worktree secret scan passed. Root build post-hook is not used to duplicate the already-run database chain.

## Failures and limits retained

- Initial new test setup errors (disabled fixture user, singleton production-management grant, immutable corporation identity, an undefined test identifier and incorrect export-claim helper name) were corrected in fixtures/assertions, not by changing business constraints. A failed fixture transaction now always rolls back before release.
- Running two schema-heavy suites together caused one local shared-memory error during cleanup. The unchanged complete PG16 chain passed when run alone; no PostgreSQL limits or test thresholds were changed.
- A filtered legacy finance test lacked earlier wage fixtures; the full PG16 file above passed with its original initialization sequence.
- PG13 PMC-specific six tests passed. Its old complete-chain attempts hit syntax errors in unchanged main files: `rework-node-history.ts` uses implicit alias `version`; `management-reporting-report-wages.ts` uses implicit alias `name`. Neither file is changed by this PR. These are existing-source compatibility observations, not a claim that the whole PG13 business suite passed or a completed baseline checkout comparison. They remain outside this role-only change.
- The supplier browser fixture initially selected an inaccessible mobile table-cell role; inspected DOM showed the correct row. Assertion now selects the exact visible text. Fixture identity persists across full-page navigation, matching session behavior. No business assertion, timeout, scope or production guard was relaxed.
- Browser fixtures are synthetic. No live user, account-role assignment, production database, deployed environment or real order was validated or modified.

Remote Full Gate and GitHub Codex Review are separate required evidence and must be recorded for the final PR head; this local record does not claim they have run.

## First remote Full result

Full `41216272841` on `106da38b` passed lint/types/build, then reported 2116 passed / 1 failed / 399 skipped. The failure was the unchanged exact trusted-actor assertion in `public-tools-routes.test.ts`: an unnecessary `authorizationCapabilities` property had been added by this PR. The property was removed from the Tools actor; existing per-request capabilities still drive the route checks and bound-download callback. No assertion or authority was relaxed. A corrected-head Full and subsequent GitHub Review remain required.
