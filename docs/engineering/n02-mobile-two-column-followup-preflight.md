# N02 mobile two-column follow-up preflight

- Repository: `lizhonghao31-crypto/dx-rework`
- Base branch: `main`
- Base SHA: `18d37dc9867fc20a3a363943e264514822234b14`
- Working branch: `codex/n02-mobile-two-column-followup`
- Task scope: restore a compact two-column N02 mobile card with process/price on the left and worker maintenance on the right, correct the public-process action label, and remove the mobile sticky action overlap.
- Allowed files:
  - `apps/web/src/process-worker-assignment-form.tsx`
  - `apps/web/src/process-worker-assignment-form.css`
  - `apps/web/src/process-worker-assignment-mobile-sheet.css`
  - `tests/unit/n02-mobile-assignment-sheet.test.ts`
  - this preflight record
- Forbidden scope: API, permissions, default-roster persistence semantics, process state, price/quantity rules, other pages, dependencies, migrations, and deployment.
- Verification: focused N02 mobile/desktop layout contract, web typecheck/lint/build, exact-head Quick Gate and Full Gate; staging phone screenshot UAT remains required after deployment.
