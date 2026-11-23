# Workbench PR6: existing delayed reading feedback

Target: `release/digital-production-v1` at `3597dd0e8a22a1ce9d14bb128f51d76ffbaa28b0` (verified actual remote after #1083 squash merge). Branch: `fix/workbench-read-feedback`.

Approved source: the complete design-workbench v7 §10, F01–F09 and K14. This is the sixth approved batch; no new workflow or performance experiment.

## Behavior and impact

- The only product change is the rendered common foreground status: `请稍等` → `读取中，请稍候` in `foreground-loading.tsx`.
- The existing250ms display threshold, immediate request start, latest-request ownership, target deduplication, stale-response rejection, AbortController behavior, retry and quiet-refresh behavior remain unchanged.
- The existing polite/nonblocking status remains; there is no new spinner, overlay, scope registry, route manager, focus policy or CSS change. Save/upload/publish/unknown-write receipt wording and business semantics are unchanged.
- Six existing test files use the new literal. Existing unit tests additionally assert a single polite status, and the existing real production-dashboard A/B/C case checks input focus during the visible wait and after obsolete B completes. Its old350ms background-only sleep is replaced by the installed browser clock API; the actual delayed reads are controlled by response gates.
- Original-document readers and directory read wiring were inspected. Static risk candidates were recorded privately, but no additional runtime defect was established, so no speculative request-lifecycle changes are included.

## Actual local verification

Source fingerprint: `c2fbdf2c50566ac3d47844db17f3bde265ae7c34f3ca7565c2998f1e4fc539fb`. The source was unchanged across the original executions and this evidence assembly; passing tests were not rerun.

| Check | Actual result |
| --- | --- |
| Existing `foreground-loading.test.ts`, canonical non-DB config | 2 passed,0 failed,0 skipped; original249/250ms, ownership/dedup/stale/error/retry checks retained |
| Existing production-dashboard A/B/C signed browser case | 1 passed,0 failed;4 other cases not selected locally |
| Seven changed source/test files, ESLint | exit0 |
| Web workspace typecheck | exit0 |
| `git diff --check` | exit0 |

Browser evidence uses real production assets, signed synthetic identity, loopback safety-marked `dx_rework_ci` and `dx_rework_acceptance_clock_test`, PG16.14 and a role without superuser/BYPASSRLS. The suite's actual canonical config is `vitest.config.ts` with one ordinary worker; it was not forced into the separate two-worker long-correctness config. The exact resource manifest was cleaned after workers completed.

The browser holds B/C responses while A remains visible, asserts the exact delayed text and unchanged input focus, proves late B cannot replace A or clear C's wait, then verifies actual C rows, failure feedback and successful original Refresh retry. A background badge read does not display the foreground message. The unit fake clock verifies instant completion does not flash.

The remaining sibling browser cases are not represented as locally passed; the existing final gate mapping retains them. This is not a rerun of all117 workbench acceptance items, onsite Acceptance verification, a performance comparison or a deployment.

## Required normal gate

The actual repository classifier, run on the complete approved seven-file diff, returns `highRisk=true`, `dbRequired=true`, `businessChainSensitive=true`, due to `cockpit-home-browser`, `delivery-calendar-browser` and `postgres-test` paths. Consequently the supported final level is Full; no classifier, workflow or protection is changed to label it Quick. Only the initial Light and necessary independent Review are requested in parallel, followed by the one required final gate for the frozen head/base.

Local original logs and Vitest JSON are private; their actual hashes and source provenance are fixed in the current construction record. The branch contains only the approved feedback/test change and required evidence. Main, production data and deployment remain outside this change.
