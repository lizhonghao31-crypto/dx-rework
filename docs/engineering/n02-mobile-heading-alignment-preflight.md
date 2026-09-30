# N02 mobile heading alignment preflight

- Repository: `lizhonghao31-crypto/dx-rework`
- Base branch: `main`
- Base SHA: `bdbb75611d3bb1002a284b73f09abffe64c207e2`
- Working branch: `codex/n02-mobile-heading-alignment`
- Task scope: align the mobile worker heading with the process heading and make the default-worker controls visually compact beside that heading while preserving a safe touch target.
- Allowed files:
  - `apps/web/src/process-worker-assignment-mobile-sheet.css`
  - `tests/unit/n02-mobile-assignment-sheet.test.ts`
  - this preflight record
- Forbidden scope: JSX, API, permissions, persistence semantics, process state, pricing/quantity rules, other pages, dependencies, migrations, and deployment.
- Verification: focused N02 mobile layout contract, web typecheck/lint/build, exact-head Quick Gate and Full Gate; staging phone screenshot UAT remains required after deployment.
