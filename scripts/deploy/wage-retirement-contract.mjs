import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const fail = (message) => {
  throw new Error(`WAGE_RETIREMENT_CONTRACT_FAILED: ${message}`);
};

const [contract, routes, detail, migration] = await Promise.all([
  read("packages/contracts/src/wages.ts"),
  read("apps/api/src/wages/wage-routes.ts"),
  read("apps/web/src/wages/wage-period-detail.tsx"),
  read("apps/api/migrations/0074_wage_review_adjustment_retirement.sql"),
]);

for (const retired of [
  "pending_tail_review",
  "pending_admin_review",
  "WageAdjustment",
  "WageReviewAction",
]) {
  if (contract.includes(retired)) fail(`contract still exposes ${retired}`);
}

for (const retired of [
  "/wage-adjustments",
  "tail-approve",
  "administrative-approve",
  "administrative-return",
]) {
  if (routes.includes(retired)) fail(`route still exposes ${retired}`);
}

if (detail.includes("工资调整") || detail.includes("WageAdjustmentForm")) {
  fail("wage detail still exposes adjustment UI");
}
if (!migration.includes("status='ready_to_lock'")) {
  fail("migration does not backfill unlocked wage periods to ready_to_lock");
}

console.log("WAGE_RETIREMENT_CONTRACT_OK");
