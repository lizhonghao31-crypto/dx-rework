import { describe, expect, it } from "vitest";

import { classifyFullGatePaths } from "../../scripts/ci/full-gate-risk-map.mjs";
import {fullGatePostgresPlan,POSTGRES_CHAIN_TESTS,configForSuite} from '../../scripts/test-suite-plan.mjs';

const suite='tests/integration/sample-read-postgres.test.ts';
const planFor=(paths:string[])=>{
  const risk=classifyFullGatePaths(paths);
  return {risk,plan:fullGatePostgresPlan({BASE_SHA:'a'.repeat(40),DB_REQUIRED:String(risk.dbRequired),
    BUSINESS_CHAIN_SENSITIVE:String(risk.businessChainSensitive),MIGRATION_SENSITIVE:String(risk.migrationSensitive),
    DEPLOYMENT_SENSITIVE:String(risk.deploymentSensitive),MAPPED_POSTGRES_TESTS:risk.mappedPostgresTests.join(',')})};
};

describe("sample PostgreSQL gate coverage", () => {
  it.each([
    "apps/api/src/samples/sample-analysis-service.ts",
    "packages/contracts/src/sample-analysis.ts",
  ])("retains the full business chain for sample source changes: %s", (path) => {
    const {risk:result,plan}=planFor([path]);
    expect(result.dbRequired).toBe(true);
    expect(result.businessChainSensitive).toBe(true);
    expect(plan.status).toBe('required');
    for(const entry of POSTGRES_CHAIN_TESTS)expect(plan.plan.map(row=>row.path)).toContain(entry);
  });

  it.each(['tests/integration/sample-analysis-postgres.cases.ts',suite])('executes the reviewed runnable sample owner, retaining Full and real PG: %s',path=>{
    const {risk,plan}=planFor([path]);
    expect(risk.highRisk).toBe(true);expect(risk.dbRequired).toBe(true);
    expect(risk.businessChainSensitive).toBe(false);
    expect(risk.mappedPostgresTests).toEqual([suite]);
    expect(plan).toMatchObject({status:'required',chain:false});
    expect(plan.plan).toEqual([{path:suite,config:configForSuite(suite),memberships:['mapped']}]);
  });

  it('deduplicates only the sample cases and their same runnable owner',()=>{
    const {plan}=planFor(['tests/integration/sample-analysis-postgres.cases.ts',suite]);
    expect(plan.plan).toEqual([{path:suite,config:configForSuite(suite),memberships:['mapped']}]);
  });

  it.each(['tests/helpers/business-anchor-fixture.ts','apps/api/src/samples/sample-analysis-service.ts',
    'packages/contracts/src/sample-analysis.ts','apps/api/src/auth/service.ts','package-lock.json',
    'packages/domain/src/unknown-policy.ts','tests/integration/unknown-postgres.test.ts',
    'tests/integration/receiving-postgres.test.ts'])('restores the complete necessary chain when the sample owner is mixed with %s',extra=>{
    const {risk,plan}=planFor([suite,extra]);
    expect(risk.dbRequired).toBe(true);expect(risk.businessChainSensitive).toBe(true);
    expect(plan.chain).toBe(true);
    for(const entry of POSTGRES_CHAIN_TESTS)expect(plan.plan.map(row=>row.path)).toContain(entry);
  });

  it.each([
    "apps/web/src/sample-operations.css",
    "docs/roadmap/ui-polish-20260908-v1.0.md",
  ])("does not escalate presentation-only %s", (path) => {
    const result = classifyFullGatePaths([path]);
    expect(result.dbRequired).toBe(false);
    expect(result.businessChainSensitive).toBe(false);
    expect(result.mappedPostgresTests).toEqual([]);
  });
});
