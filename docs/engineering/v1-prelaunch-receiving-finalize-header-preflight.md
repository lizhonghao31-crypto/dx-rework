# Receiving image finalize header fix preflight

- Repository: `lizhonghao31-crypto/dx-rework`
- Base branch: `main`
- Base SHA: `52366e760d2a48f89376addd93063d269594e406`
- Working branch: `fix/v1-prelaunch-receiving-finalize-header`
- Task scope: stop the receiving page from declaring an empty attachment finalize request as JSON, and preserve framework 4xx request errors.
- Allowed files:
  - `apps/web/src/receiving-page.tsx`
  - `apps/api/src/app.ts`
  - `tests/unit/v1-prelaunch-receiving-rework-contract.test.ts`
  - `tests/integration/health.test.ts`
  - `docs/engineering/v1-prelaunch-receiving-finalize-header-preflight.md`
- Forbidden files and behavior: OSS signing/storage, attachment service and routes, receiving data and state transitions, database migrations, permissions, wages, responsibility rules, node flow, and UI layout.
