# N02 responsive layout follow-up preflight

- Repository: `lizhonghao31-crypto/dx-rework`
- Base branch: `main`
- Base SHA: `33a47c71b7e4ca78986ee1d43be228be37f14b75`
- Working branch: `codex/n02-responsive-layout-followup`
- Task scope: keep default-worker actions beside the worker title on desktop, place remove controls before names, and correct the mobile N02 grid so source choices stack vertically with horizontal text while the worker area stays left aligned.
- Allowed files:
  - `apps/web/src/process-worker-assignment-form.tsx`
  - `apps/web/src/process-worker-assignment-form.css`
  - `apps/web/src/process-worker-assignment-mobile-sheet.css`
  - `tests/unit/n02-mobile-assignment-sheet.test.ts`
  - this preflight record
- Forbidden scope: API, permissions, persistence semantics, process state, price/quantity rules, other pages, dependencies, migrations, and deployment.
- Verification: focused N02 layout contract, web typecheck/lint/build, exact-head Quick Gate and Full Gate; desktop/mobile visual UAT remains required after staging deployment.
