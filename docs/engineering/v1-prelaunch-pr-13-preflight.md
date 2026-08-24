# V1 prelaunch PR-13 preflight

- Repository: `lizhonghao31-crypto/dx-rework`
- Base branch: `main`
- Base SHA: `8365bb1462ff9523c390030b312d4cfce0249bcf`
- Working branch: `codex/v1-prelaunch-n02-inline-default-workers`
- Task scope: let a tail supervisor maintain each public process's default workers directly inside N02; unsaved edits remain order-local, while the dedicated Save action updates the audited global default roster.
- Allowed files:
  - `apps/api/src/access/routes.ts`
  - `apps/web/src/process-worker-assignment-form.tsx`
  - `apps/web/src/process-worker-assignment-form.css`
  - `tests/integration/access-routes.test.ts`
  - `tests/unit/v1-prelaunch-default-candidates-frontline.test.ts`
  - this preflight record
- Forbidden scope: database migrations, process state changes, wage or responsibility rules, deployment, DingTalk integration, and unrelated master-data UI changes.
- Verification: focused route/UI contract tests, web typecheck/lint/build, exact-head GitHub Quick Gate and Full Gate, plus desktop/mobile UI evidence where the environment permits.
