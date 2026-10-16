# Static release permission and content gate

Base: main `870ae64c4394a706ee405ea414431d79dece4063`. Gate class: FULL.

## Incident and scope

The maintenance update inherited umask 077. Frontend directories/files retained 700/600 through packaging and installation. nginx could not read them, while `/version` returned the expected API SHA. The user reported recovery after the one-off permission repair; full recovery command output was not supplied, so that report is not substituted for HTTP/hash evidence.

This change only touches deployment tools and synthetic regression fixtures. No business code, schema, owner, global umask, private directory permissions, production data or UI changes.

## Gates

- `static-release.py` uses Python 3.6+ standard library. Validate the whole public tree before chmod; directories 755, files 644, owner unchanged. Only index, Vite assets and generated release metadata are allowed. Reject hidden files, private configuration formats, symlinks, hard links, special entries and ancestor symlinks.
- Package after all metadata/checksums are written. Install validates source, normalizes destination before publishing, and normalizes an identical existing release rather than returning early. Content differences remain errors. Reused candidates still pass installation. API trees remain untouched.
- Main online/maintenance controllers discover live nginx workers from `/proc`, verify their nginx master, and read index plus referenced JS/CSS using each worker's effective UID/GID and supplementary groups. No candidate code is executed. No worker or inability to assume its identity is a failure, not a skipped check.
- Check both candidate and recovery frontend before entering maintenance; check the candidate again on maintenance resume. Check online candidate/recovery trees before candidate startup/routing. An unreadable rejected candidate must not prevent an interrupted rollback from proceeding.
- The online worker preserves the optional approved target SHA through its clean environment, and rejects a different frozen candidate on resume. This makes the final pinned delivery command effective even if main moves during candidate preparation.
- Public verification retains API SHA verification and additionally requires real loopback TLS site requests for index and referenced assets to return exactly HTTP 200 with matching bytes. SPA fallback HTML and old-generation assets fail. No redirects or external asset hosts are silently accepted.
- Existing success/rollback paths use that stronger verification. Failure after committed DDL retains maintenance, never old-schema rollback. A resumed activation whose static preflight fails reinstates maintenance routing. Recovery verification failure cannot print a release-success marker.

Private ancestors are never chmodded: if they prevent nginx traversal, preflight refuses before switching and requires explicit inspection. The OS-user preflight is not a proof of SELinux policy; actual HTTP checks remain mandatory. The reported incident host has SELinux disabled.

## Environment boundary

Shared packaging/install protection applies to both main and Acceptance bundles. Main controllers only target their existing `/opt/dx-rework` root and production site. Acceptance runtime orchestration, DB migrations, service control and credentials are not changed by this PR. The helper and isolated nginx tests also support `/acceptance/` assets and verify that normalizing main does not alter the Acceptance tree. This does not claim the separate Acceptance updater acquired a new root identity-switch capability.

## Regression evidence

- Python fixture: both umasks; actual package/install invocation; reused restrictive release; owner/content invariance; private API file retained 600; no active alias during register-only; changed content rejected; injected normalization failure leaves no published frontend/generation/active; forbidden file rejected before API installation.
- Real disposable nginx fixture: reproduced permission denied under 700/600; verified main and Acceptance TLS content after normalization; denied private tree stays private; unreadable resource, missing asset returning SPA HTML, wrong-generation bytes and unreadable root fail; re-normalization restores checks.
- Controller tests execute the real preflight blocks under synthetic failure: prepared/switching stop; rolling-back is not blocked by the rejected candidate; resumed maintenance activation restores maintenance routing and fails without success.
- Existing lifecycle, failure, maintenance target and Acceptance deployment-contract suites remain part of targeted regression.

Run filesystem/contract tests with:

```bash
npx vitest run tests/unit/static-release-permissions.test.ts tests/unit/main-maintenance-target.test.ts tests/unit/pr-17-deployment.test.ts tests/integration/pr-17-release-lifecycle.test.ts tests/integration/pr-17-deploy-failure.test.ts tests/integration/acceptance-deployment-contract.test.ts
```

The real nginx fixture must ONLY run in a disposable root container containing nginx, Python 3, curl and openssl, never on an ECS host:

```bash
DX_STATIC_DISPOSABLE=1 python3 tests/fixtures/static-release-nginx.py
```

## Delivery boundary

Installing new tools is required; merely updating application code leaves the old root controller active. The final delivery command must pin the merged main SHA, verify current SHA/schema/active port and completed phase, install the audited fixed entry, then run the same-schema online update. Do not rerun the previous 0225-to-0226 bootstrap command. No new migration is introduced. Production deployment and nginx operations remain user-executed.
