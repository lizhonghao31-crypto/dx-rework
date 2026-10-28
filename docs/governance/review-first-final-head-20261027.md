# Review first, final Head Gate

Status: code workflow adopted by this change; repository protection settings are a separate operational concern.

## Approved scope and starting state

The business owner approved the serial plan on 2026-10-27 at 15:28 UTC (`Sentinel_cf6bfdf46e108191b08e3daf843f90b9`): first repair the seven original rework PostgreSQL tests, then a separate governance PR. The preceding proposal explicitly included merge after the final Gate. PR #870 is merged at `27c87172ba82e83117994d16e86095e3c161cee7`, tree `7c7b33c86155c9915ce877aee505a6be5a2c37a2`; this governance change starts there. It does not change application code, database migrations, roles, thresholds or deployment.

The seven original rework tests passed on isolated PostgreSQL 13.23 and 16.15, and on #870's exact-Head Full Gate40533947895. This evidence is reused; governance does not repeat those local database runs. Old test failures remain recorded in the previous handoff.

## Execution and evidence

1. Freeze actual remote base SHA, one-PR scope and entry/consumer list. Record existing test health, allowed/forbidden files, acceptance criteria, time/permission/date boundaries where relevant, and failure/retry/concurrency/rollback cases. Do not push a known incomplete implementation.
2. Run affected local checks and inspect the complete diff. Push one assembled candidate with `[QUICK]` or `[FULL]`. Both run **Push light checks**; no expensive Full worker starts on a PR push, reopen, body edit or title wording edit. Review begins after actual light success, before final heavy validation.
3. Collect Review findings and same-scope self-check findings; fix them together locally. Reply with evidence and resolve valid findings. Push the assembled repair once. A new Head invalidates previous final evidence and requires light checks at the new Head. A genuinely failing final Gate still requires repair and new verification; this process cannot promise one CI run regardless of defects.
4. Freeze the final Head. Explicitly request the existing Quick or Full level. Only the selected worker actually executes its checks. Full stays one 30-minute heavy worker with the existing diff risk map; Quick stays five minutes. Two metadata jobs have separate two-minute bounds. No required-name placeholder may turn a skipped worker green.
5. Read the current PR Head, actual target branch tip, title mode, required/not-required Review decision and corresponding Codex state/resolved threads, actual workflow/job conclusions and the structured executed-check receipt; reread Head/base/mode after those reads and reject observed drift before returning approval. Merge only using the expected full Head SHA under the existing task authorization. A new Head, actual base tip or mode invalidates the tuple. Do not ask again for unchanged already-authorized scope; a tool denial is still binding and must be reported with action, target, reason and execution state.

Review may have run on the ancestor candidate before concentrated fixes, as required by the approved order. The final evidence records the reviewed SHA, its ancestry, resolved threads, final Head and final Gate separately; it does not pretend the final Head itself received a second Review. A missing/failed service response or unresolved thread is never success.

## Explicit final request without new CI permissions

The immutable request branch is:

```
gate/{quick|full}/{PR}/{Head40}/{base40}/{baseRefBase64url}
```

It points **at the PR's actual final Head**, not a PR merge ref, synthetic commit, main or deployment branch. `base40` is read from the actual target branch tip, not assumed from a possibly stale PR snapshot. The branch name encodes the complete tuple and is canonical/allowlisted/round-trip checked against `GITHUB_SHA`. Branch creation emits GitHub's native `create` event; ordinary branch/tag creations allocate no job. GitHub documents the event SHA as the last commit of the created branch: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#create .

The supported operator entry is `node scripts/ci/pr-gate-controller.mjs`:

```
node scripts/ci/pr-gate-controller.mjs request-final --pr <number> --head <40-char-SHA>
node scripts/ci/pr-gate-controller.mjs request-final --pr <number> --head <40-char-SHA> --apply
node scripts/ci/pr-gate-controller.mjs verify-merge --pr <number> --head <40-char-SHA>
```

The first command is read-only. For a genuinely low-risk Quick change that existing rules/task authorization permit without Review, both request and verification accept `--review-not-required --review-reason '<risk rationale>' --review-authorization '<existing authority reference>'`. Missing rationale/authority, Full mode, a started/failed Review or unresolved threads fail closed. The flag records an existing decision, does not grant authority or mark a failed Review passed, and cannot waive a required Full check; actual Quick light/final success still enforces the shared sensitive-path classifier. Record the returned `reviewDecision` in PR evidence. Default remains required Review. `--apply` creates only this repository's exact immutable request ref after the recorded required/not-required Review decision and actual light evidence checks. Concurrent create uses GitHub's atomic ref creation; duplicates inspect the existing ref/run rather than create another name or restart expensive work. Network uncertainty is inspected before treating creation as successful. Denials propagate. The helper has no force/update/delete, merge, deployment, protection, permission or rerun command. Existing failed/cancelled final runs remain failed; permitted same-Head transient job reruns retain the same run/attempt identity and require fresh evidence. Do not delete/recreate refs or add nonces to evade a failure.

CI keeps only `contents: read`. The CI runtime consumes GitHub's actual `needs.<worker>.result` and its receipt, recomputes the exact diff's required stages, checks Head/base/run/attempt, and emits **Final Gate exact Head** only when the selected real worker passed. Unselected jobs use other names. The operator must be able to read Actions logs including GitHub's temporary download redirect. In this restricted executor the CLI redirect returned Forbidden, while the existing authorized GitHub connector read the same job log successfully. Do not change proxy/network/token permissions to conceal this limit: CLI verification remains blocked if its own log transport is unavailable. A task can independently inspect actual server run/job identities and connector-fetched receipts using the pure verification protocol; that is separately recorded evidence, not a claimed successful CLI invocation. No added `actions:read`, `pull-requests:read`, token, installation or write scope is needed. The operator entry requires Node22 and the already installed/authorized GitHub CLI (no npm install); it reuses `gh api` proxy/auth handling with a 30-second request bound, explicit github.com host, parsed actual HTTP status, stdin JSON and no shell interpolation. The local first native Node fetch failed with ECONNREFUSED while the existing CLI connection remained readable; this is a transport compatibility repair, not a new token or permission. Operator-side reads use the already connected identity: this repository's PR metadata, branch tip, Codex comments/threads, ancestor comparison, CI runs/jobs/logs and existing request refs; tokens remain in memory and are never printed or saved. Read-only GraphQL queries use POST transport but do not mutate threads.

## Review timeout

The standing business-owner instruction is fifteen minutes **from the posted request's server `created_at`**. A still-running or explicit service-failed Review has no code conclusion. At the boundary, reread completion and newer requests before reopening. No push, title edit or CI rerun is involved.

```
node scripts/ci/pr-gate-controller.mjs watch-review --pr <number> --head <40-char-SHA> --request-id <posted-comment-id> --watch --apply --review-retry-authorized --state-dir <private-local-directory>
```

The flag records that standing authorization exists; it is not a way to invent authorization. The helper uses a per-request local exclusive lock and durable sent/uncertain/denied record, rechecks the Head and bot result inside the lock, and never blindly repeats an uncertain or denied comment. One active controller is the supported execution model; independent machines cannot share this local lock. A stale lock or uncertain record needs read-only reconciliation, not automatic removal or a second sender. A new successful request resets the next fifteen-minute interval.

## Platform boundary — no settings changed

Read-only observation at 2026-10-27 17:05:23 UTC:

| Endpoint | Observed field/result |
| --- | --- |
| `GET /repos/lizhonghao31-crypto/dx-rework/branches/release%2Fdigital-production-v1` | `protected=false`; `protection.enabled=false`; `protection.required_status_checks.enforcement_level=off`; `contexts=[]`, `checks=[]` |
| same branch `/protection` | HTTP403, `Resource not accessible by integration`; hidden protection details unknown |
| `GET /repos/lizhonghao31-crypto/dx-rework/rules/branches/release%2Fdigital-production-v1` | `[]` within readable scope |
| `GET /repos/lizhonghao31-crypto/dx-rework/rulesets?includes_parents=true` | `[]` within readable scope |

These are not proof that inaccessible policies do not exist. No branch protection, app installation, token or repository setting is modified by this PR. **Final Gate exact Head** is the single candidate check name backed by this Head's actually completed certification job, but it is not claimed to be configured as a server-required check. The supported merge process fails closed on absent/failed/stale/skipped evidence; it cannot prohibit an owner from directly merging through an unprotected GitHub UI or deleting/reforging request refs. Server enforcement requires a separately authorized repository-settings change by an identity able to read and administer it. Do not represent manual/operator verification as a GitHub hard gate.

## Progress and closeout

At each meaningful stage, record actual command/run/request ID, last finished result, current operation, next concrete step and blocker. Keep progress visible at least every minute during active work; do not stop at “Thinking” or claim running means progress. The controller does not replace task-level progress updates. Evidence must distinguish local success, final CI success, Review, merge, deploy and business acceptance. Record exact merge/tree, unchanged protected targets, tested/failed/unrun scope, cost (number and actual duration of light/heavy jobs), avoided duplicate events and any rerun's root cause. Never infer exact coding time or Fast/model speed from missing logs.

## Shared clock-inventory preflight

The first final Gate40552967024 at fd684d333f14af182e2cc6c60939d34de4bf53d5 failed one existing cross-repository guard: 2901 tests passed, one time-inventory test failed,857 were optional skips; downstream database/packaging checks did not run. Final certification correctly failed and the run is not approval evidence. The pre-push affected-test selection omitted this shared guard, an avoidable omission, not a scene-clock business failure.

Exactly two new `scripts/ci/pr-gate-controller.mjs` candidates are explicitly recorded in the existing source-hash inventory: real physical time used to measure the Review's fifteen-minute deadline, and real observation audit output. GitHub request/summary timestamps, derived deadline display, polling and network timeouts also stay in the real audit/security domain; no order occurrence or Acceptance scenario clock is involved. All existing rows/hashes and the discovery/check implementation remain unchanged. No broad CI-script exemption, threshold or assertion is weakened. The native lightweight protocol test command now includes this existing full-repository inventory guard, so future changes are caught in local/light verification before an expensive Gate. The repair and changed clock-inventory test are checked locally before one new frozen final request; the failed Head/run remains preserved.
