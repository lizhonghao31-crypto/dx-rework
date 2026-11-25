import { readFileSync,readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { assertMappedPostgresTests, classifyFullGatePaths, POSTGRES_CASE_SUITES, INDEPENDENT_POSTGRES_TESTS, hasStaticPostgresCaseImport, assertStaticPostgresCaseImport, SLA_JOURNEY_SOURCE_PATHS, SLA_JOURNEY_SUPPORT_PATHS, SLA_JOURNEY_REQUIRED_TESTS, SLA_JOURNEY_UNRELATED_CHAIN_TESTS } from "../../scripts/ci/full-gate-risk-map.mjs";
import {configForSuite,fullGatePostgresPlan,POSTGRES_CHAIN_TESTS} from '../../scripts/test-suite-plan.mjs';
import {settingsBrowserRequired} from '../../scripts/ci/prepare-settings-browser.mjs';

it('maps rework collection consumers to their native authorization, queue and closure regressions',()=>{
 const suites=['full-business-chain','management-reporting','production-closure','m01-production-statistics'];
 for(const file of ['apps/api/src/rework/work-reporting-service.ts','apps/api/src/rework/rework-business-detail-service.ts',
  'apps/api/src/rework/fixed-external-responsibility-service.ts','apps/api/src/rework/production-external-responsibility-service.ts',
  'apps/api/src/reporting/management-reporting-orders.ts','apps/api/src/production-platform/order-closure-service.ts',
  'apps/web/src/reporting/reporting-client.ts','apps/web/src/reporting/workflow-queue-page.tsx','packages/contracts/src/reporting.ts']){
  expect(classifyFullGatePaths([file]).mappedPostgresTests,file).toEqual(expect.arrayContaining(suites.map(name=>`tests/integration/${name}-postgres.test.ts`)));
 }
});

it('retains both original authenticated draft/receipt browsers for every recovery producer and current page consumer',()=>{
 const suites=['tests/integration/instruction-recovery-native-browser-postgres.test.ts','tests/integration/development-creation-draft-native-browser-postgres.test.ts'];
 for(const path of ['apps/api/src/production-platform/instruction-command-receipts.ts','apps/api/src/production-platform/po-customer-date-service.ts','apps/api/src/production-platform/production-instruction-service.ts','apps/api/src/production-platform/production-instruction-routes.ts','packages/contracts/src/production-instruction.ts','apps/web/src/instruction-recovery-state.ts','apps/web/src/use-instruction-recovery.ts','apps/web/src/production-instruction-panel.tsx','apps/web/src/development-creation-draft.ts','apps/web/src/use-development-creation-draft.ts','apps/web/src/digital-designer-workspace.tsx','apps/web/src/digital-development-create-form.tsx',...suites]){
  const risk=classifyFullGatePaths([path]);for(const suite of suites)expect(risk.mappedPostgresTests,path).toContain(suite);
 }
 for(const suite of suites){expect(configForSuite(suite)).toBe('vitest.business-chain.config.ts');expect(settingsBrowserRequired({DB_REQUIRED:'true',BASE_SHA:'a'.repeat(40),BUSINESS_CHAIN_SENSITIVE:'false',MIGRATION_SENSITIVE:'false',DEPLOYMENT_SENSITIVE:'false',MAPPED_POSTGRES_TESTS:suite})).toBe(true);}
});

it('keeps terminal summaries and effective positive receipt quality in the actual authenticated App and native washing plan',()=>{
 const suite='tests/integration/terminal-quality-projections-browser-postgres.test.ts';
 for(const path of ['apps/api/src/production-platform/packing-quality-coverage.ts','apps/web/src/digital-journey-cockpit-model.ts','apps/web/src/cockpit-home.tsx','tests/helpers/order-time-rewash-fixture.ts',suite]){
  expect(classifyFullGatePaths([path]).mappedPostgresTests,path).toContain(suite);
 }
 expect(configForSuite(suite)).toBe('vitest.business-chain.config.ts');
 expect(settingsBrowserRequired({DB_REQUIRED:'true',BASE_SHA:'a'.repeat(40),BUSINESS_CHAIN_SENSITIVE:'false',MIGRATION_SENSITIVE:'false',DEPLOYMENT_SENSITIVE:'false',MAPPED_POSTGRES_TESTS:suite})).toBe(true);
});

it('keeps independent rewash plans, strict stored input and their shared native setup in both actual service and authenticated App coverage',()=>{
 const suites=['tests/integration/order-time-washing-rework-postgres.test.ts','tests/integration/order-time-washing-rework-browser-postgres.test.ts'];
 for(const file of ['apps/api/src/production-platform/order-time-washing-rework.ts','apps/api/src/production-platform/bulk-washing-rework-binding.ts','apps/api/src/production-platform/bulk-washing-rework-source.ts','apps/api/src/production-platform/bulk-washing-rework-planning.ts','apps/api/src/production-platform/journey-washing-rework-facts.ts','apps/web/src/order-time-rewash-fields.tsx','packages/contracts/src/order-time-washing-rework.ts','apps/api/migrations/0295_order_time_rewash_input.sql','tests/helpers/order-time-rewash-fixture.ts','apps/api/src/production-platform/order-time-plan-repository.ts','apps/api/src/production-platform/order-time-operation-state.ts','apps/api/src/production-platform/order-time-request-service.ts','apps/api/src/production-platform/order-time-reading.ts','apps/api/src/production-platform/fixed-schedule-basis.ts']){
  const risk=classifyFullGatePaths([file]);
  for(const suite of suites)expect(risk.mappedPostgresTests,file).toContain(suite);
  const plan=fullGatePostgresPlan({DB_REQUIRED:'true',BASE_SHA:'a'.repeat(40),MAPPED_POSTGRES_TESTS:risk.mappedPostgresTests.join(','),BUSINESS_CHAIN_SENSITIVE:String(risk.businessChainSensitive),MIGRATION_SENSITIVE:String(risk.migrationSensitive),DEPLOYMENT_SENSITIVE:String(risk.deploymentSensitive)});
  for(const suite of suites)expect(plan.plan?.some(entry=>entry.path===suite&&entry.config==='vitest.business-chain.config.ts'),file+':'+suite).toBe(true);
 }
});

it('runs every consumer of the original shared authenticated App browser with the existing long correctness configuration',()=>{
 const suites=readdirSync('tests/integration').filter(name=>name.endsWith('.test.ts')).map(name=>'tests/integration/'+name).filter(path=>/from ['"]\.\.\/acceptance\/supplychain-settings-browser\.js['"]/.test(readFileSync(path,'utf8')));
 expect(suites).toContain('tests/integration/budget-washing-fees-browser-postgres.test.ts');
 for(const suite of suites){
  expect(configForSuite(suite),suite).toBe('vitest.business-chain.config.ts');
  expect(settingsBrowserRequired({DB_REQUIRED:'true',BASE_SHA:'a'.repeat(40),BUSINESS_CHAIN_SENSITIVE:'false',MIGRATION_SENSITIVE:'false',DEPLOYMENT_SENSITIVE:'false',MAPPED_POSTGRES_TESTS:suite}),suite).toBe(true);
 }
 expect(configForSuite('tests/integration/budget-washing-fees-postgres.test.ts')).toBe('vitest.business-chain.config.ts');
 expect(configForSuite('tests/integration/digital-budget-shared-postgres.test.ts')).toBe('vitest.config.ts');
});

it('keeps shared failed-upload state and native task completion in the real authenticated upload plan',()=>{
 for(const name of ['document-upload-previews','digital-development-execution-panel','development-external-pattern','development-result-upload','task-workbench-sample']){
  const risk=classifyFullGatePaths([`apps/web/src/${name}.tsx`]);
  for(const suite of ['development-execution-read-native-browser','digital-development-execution','development-technical'])expect(risk.mappedPostgresTests).toContain(`tests/integration/${suite}-postgres.test.ts`);
 }
});

it('keeps factory read-region changes in the original authenticated washing and factory browser plan',()=>{
 for(const file of ['apps/web/src/factory-flow-read.ts','apps/web/src/factory-flow-panel.tsx'])expect(classifyFullGatePaths([file]).mappedPostgresTests).toContain('tests/integration/bulk-washing-browser-postgres.test.ts');
});

it('selects exact native-window navigation and original App return coverage for every projection, route and link consumer',()=>{
 const suite='tests/integration/washing-window-navigation-browser-postgres.test.ts';
 for(const path of ['apps/api/src/production-platform/journey-washing-window-record.ts','apps/api/src/production-platform/journey-washing-facts.ts','apps/api/src/production-platform/journey-washing-rework-facts.ts','apps/api/src/production-platform/journey-washing-projection.ts','apps/api/src/production-platform/fixed-schedule-basis.ts','apps/api/src/production-platform/fixed-schedule-progress.ts','apps/api/src/production-platform/journey-fact-model.ts','apps/web/src/bulk-washing-panel.tsx','apps/web/src/washing-window-target.ts','apps/web/src/washing-window-target.css','apps/web/src/cockpit-record-link.tsx','apps/web/src/cockpit-detail.tsx','apps/web/src/cockpit-node-dates.tsx','apps/web/src/cockpit-node-rows.tsx','apps/web/src/digital-detail-route.ts','apps/web/src/factory-task-target.ts','apps/web/src/factory-flow-panel.tsx','apps/web/src/journey-sla-details.tsx','apps/web/src/node-materials-panel.tsx','packages/contracts/src/bulk-washing.ts','packages/contracts/src/digital-production-journey.ts','tests/helpers/order-time-rewash-fixture.ts',suite])expect(classifyFullGatePaths([path]).mappedPostgresTests,path).toContain(suite);
 expect(configForSuite(suite)).toBe('vitest.business-chain.config.ts');
 expect(settingsBrowserRequired({DB_REQUIRED:'true',BASE_SHA:'a'.repeat(40),BUSINESS_CHAIN_SENSITIVE:'false',MIGRATION_SENSITIVE:'false',DEPLOYMENT_SENSITIVE:'false',MAPPED_POSTGRES_TESTS:suite})).toBe(true);
});

it('keeps washing projection changes in the native quantity, fact model and request regression plan',()=>{
 for(const file of ['journey-washing-facts','journey-washing-projection']){
  const risk=classifyFullGatePaths([`apps/api/src/production-platform/${file}.ts`]);
  for(const suite of ['bulk-washing','order-time-requests','journey-fact-model','m01-journey-performance'])expect(risk.mappedPostgresTests).toContain(`tests/integration/${suite}-postgres.test.ts`);
 }
});

it('maps factory promise and washing adoption adapters to original request and browser regressions',()=>{
 for(const name of ['factory-commitments','washing']){
  const risk=classifyFullGatePaths([`apps/api/src/production-platform/order-time-${name}.ts`]);
  expect(risk.mappedPostgresTests).toContain('tests/integration/order-time-requests-postgres.test.ts');
  expect(risk.mappedPostgresTests).toContain('tests/integration/order-time-requests-browser-postgres.test.ts');
 }
 expect(classifyFullGatePaths(['apps/web/src/order-time-milestone-fields.tsx']).mappedPostgresTests).toContain('tests/integration/r5-settings-native-browser-postgres.test.ts');
});

it('keeps framework and version-reader changes in the original time-plan database regression scope',()=>{
 for(const path of ['apps/api/src/production-platform/order-time-framework.ts','packages/contracts/src/order-time-framework.ts']){
  const risk=classifyFullGatePaths([path]);
  expect(risk.mappedPostgresTests).toContain('tests/integration/order-time-plan-postgres.test.ts');
  expect(risk.mappedPostgresTests).toContain('tests/integration/order-time-reading-postgres.test.ts');
 }
});

it('keeps the extracted development read and original GET/QR consumers in the existing native plan',()=>{
 const suite='tests/integration/development-execution-read-native-browser-postgres.test.ts';
 for(const path of ['apps/api/src/production-platform/development-execution-read.ts','apps/api/src/production-platform/development-execution-service.ts','apps/api/src/production-platform/development-execution-routes.ts',suite]){
  const risk=classifyFullGatePaths([path]);
  expect(risk.mappedPostgresTests).toContain(suite);
  expect(risk.migrationSensitive).toBe(false);
 }
 expect(configForSuite(suite)).toBe('vitest.business-chain.config.ts');
 expect(settingsBrowserRequired({DB_REQUIRED:'true',BASE_SHA:'a'.repeat(40),BUSINESS_CHAIN_SENSITIVE:'false',MIGRATION_SENSITIVE:'false',DEPLOYMENT_SENSITIVE:'false',MAPPED_POSTGRES_TESTS:suite})).toBe(true);
});

it('keeps the original homepage browser and shared correctness budget in the exact home projection plan',()=>{
 const suite='tests/integration/m01-cockpit-home-native-browser-postgres.test.ts';
 for(const path of ['apps/web/src/cockpit-home.tsx','apps/web/src/cockpit-detail.tsx','apps/web/src/cockpit-detail.css','apps/web/src/cockpit-detail-risks.tsx','apps/web/src/cockpit-stage-progress.tsx','apps/web/src/cockpit-documents.tsx','apps/web/src/cockpit-operation-log.tsx','apps/web/src/node-materials-panel.tsx','apps/web/src/cockpit-home-progress.tsx','apps/web/src/cockpit-home-dialog.tsx','apps/web/src/cockpit-timing-coverage.tsx','apps/web/src/digital-journey-cockpit.tsx','apps/api/src/production-platform/journey-projection.ts','packages/contracts/src/digital-production-journey.ts','tests/acceptance/m01-cockpit-home-native-browser.ts','tests/fixtures/m01-cockpit-home-native-ui.tsx',suite]){
  expect(classifyFullGatePaths([path]).mappedPostgresTests).toContain(suite);
 }
 expect(configForSuite(suite)).toBe('vitest.business-chain.config.ts');
 expect(settingsBrowserRequired({DB_REQUIRED:'true',BASE_SHA:'a'.repeat(40),BUSINESS_CHAIN_SENSITIVE:'false',MIGRATION_SENSITIVE:'false',DEPLOYMENT_SENSITIVE:'false',MAPPED_POSTGRES_TESTS:suite})).toBe(true);
 expect(classifyFullGatePaths(['apps/web/src/receiving-page.tsx']).mappedPostgresTests).not.toContain(suite);
});

it('keeps the actual delivery browser in the canonical plan with locked Chromium and the shared finite correctness budget',()=>{
 const suite='tests/integration/m01-delivery-calendar-native-browser-postgres.test.ts';
 for(const path of ['apps/api/src/production-platform/delivery-calendar-images.ts','apps/api/src/production-platform/delivery-calendar-query.ts','packages/contracts/src/delivery-calendar.ts','apps/web/src/delivery-calendar-page.tsx','apps/web/src/delivery-calendar-grid.tsx','apps/web/src/delivery-calendar-model.ts','apps/web/src/delivery-calendar.css','apps/web/src/digital-cockpit-page.tsx','apps/web/src/digital-journey-cockpit-model.ts',suite])expect(classifyFullGatePaths([path]).mappedPostgresTests).toContain(suite);
 expect(configForSuite(suite)).toBe('vitest.business-chain.config.ts');expect(settingsBrowserRequired({DB_REQUIRED:'true',BASE_SHA:'a'.repeat(40),BUSINESS_CHAIN_SENSITIVE:'false',MIGRATION_SENSITIVE:'false',DEPLOYMENT_SENSITIVE:'false',MAPPED_POSTGRES_TESTS:suite})).toBe(true);expect(classifyFullGatePaths(['apps/web/src/wages/wage-page.tsx']).mappedPostgresTests).not.toContain(suite);
});

it('keeps native persistent-session and Chromium coverage in the exact auth/config plan', () => {
  const suite='tests/integration/acceptance-session-retention-postgres.test.ts';
  for(const path of ['apps/api/src/auth/service.ts','apps/api/src/auth/acceptance-control.ts','packages/config/src/index.ts',suite]) {
    const risk=classifyFullGatePaths([path]);
    expect(risk.mappedPostgresTests).toContain(suite);
    expect(configForSuite(suite)).toBe('vitest.business-chain.config.ts');
    const env={DB_REQUIRED:'true',BASE_SHA:'a'.repeat(40),BUSINESS_CHAIN_SENSITIVE:'false',MIGRATION_SENSITIVE:'false',DEPLOYMENT_SENSITIVE:'false',MAPPED_POSTGRES_TESTS:suite};
    expect(settingsBrowserRequired(env)).toBe(true);
  }
  expect(classifyFullGatePaths(['apps/api/src/wages/wage-service.ts']).mappedPostgresTests).not.toContain(suite);
});

const amendmentSuite='tests/integration/development-amendment-postgres.test.ts';
it.each(['apps/api/src/receiving/packing-receipt-allocations.ts','apps/api/src/production-platform/packing-scope-readiness.ts','apps/api/src/production-platform/packing-readiness-evidence.ts','apps/api/src/production-platform/packing-allocation-evidence.ts'])('maps isolated packing responsibility producer changes to the original real PG consumer: %s',path=>{
 expect(classifyFullGatePaths([path]).mappedPostgresTests).toContain('tests/integration/effective-packing-postgres.test.ts');
});
it('maps the original receipt packing editor to its authenticated browser flow',()=>{
 expect(classifyFullGatePaths(['apps/web/src/packing-receipt-allocation-fields.tsx']).mappedPostgresTests).toContain('tests/integration/receiving-board-native-browser-postgres.test.ts');
});
const amendmentPlan=(paths:string[])=>{
 const r=classifyFullGatePaths(paths);
 return fullGatePostgresPlan({BASE_SHA:'7e5fbbcebb06e5c5f4dd96e0e95defb5dbbcbf7e',DB_REQUIRED:String(r.dbRequired),BUSINESS_CHAIN_SENSITIVE:String(r.businessChainSensitive),MIGRATION_SENSITIVE:String(r.migrationSensitive),DEPLOYMENT_SENSITIVE:String(r.deploymentSensitive),MAPPED_POSTGRES_TESTS:r.mappedPostgresTests.join(','),CHAIN_PROFILE:r.chainProfile});
};

describe('same-round correction source-only PG coverage',()=>{
 it.each([
  'apps/api/src/production-platform/development-document-format.ts',
  'apps/api/src/production-platform/development-material-suppliers.ts',
  'apps/api/src/production-platform/development-amendment-service.ts',
  'packages/contracts/src/digital-development.ts',
  'packages/contracts/src/digital-development-amendments.ts',
  'apps/api/src/production-platform/development-routes.ts',
  'apps/api/src/production-platform/development-service.ts',
  'apps/api/src/production-platform/development-amendment-repository.ts',
  'apps/api/src/production-platform/development-supply.ts',
  'apps/api/src/production-platform/development-material-reopen.ts',
  'apps/api/src/production-platform/development-material-verification.ts',
  'apps/api/src/production-platform/development-material-readiness.ts',
  'apps/api/src/production-platform/development-material-check-rules.ts',
  'apps/api/src/production-platform/development-execution-service.ts',
  'apps/api/src/production-platform/development-execution-read.ts',
  'apps/api/src/production-platform/development-execution-routes.ts',
  'apps/api/src/production-platform/development-round-repository.ts',
  'apps/api/src/production-platform/development-round-service.ts',
  'apps/api/src/production-platform/development-route-service.ts',
  'apps/api/src/production-platform/development-route.ts',
  'apps/api/src/production-platform/access-policy.ts',
  'apps/api/src/pattern-room/order-service.ts',
  'packages/contracts/src/digital-development-execution.ts',
  'packages/contracts/src/pattern-orders.ts',
 ])('selects unchanged real correction regression for %s alone',path=>{
  const risk=classifyFullGatePaths([path]),plan=amendmentPlan([path]);expect(risk.highRisk).toBe(true);expect(risk.mappedPostgresTests).toContain(amendmentSuite);expect(()=>assertMappedPostgresTests(risk.mappedPostgresTests)).not.toThrow();
  const shortLead=path==='apps/api/src/production-platform/access-policy.ts'?['tests/integration/m01-short-lead-native-browser-postgres.test.ts']:[];
  const imagePreview=['apps/api/src/production-platform/development-routes.ts','apps/api/src/production-platform/development-service.ts'].includes(path)?['tests/integration/attachment-image-preview-postgres.test.ts']:[];
  const execution=/development-execution-(read|service|routes)\.ts$/.test(path)?['tests/integration/digital-development-execution-postgres.test.ts','tests/integration/development-sla-enrollment-postgres.test.ts','tests/integration/development-execution-read-native-browser-postgres.test.ts']:[];
  expect(plan.plan.map(s=>s.path)).toEqual([...POSTGRES_CHAIN_TESTS,amendmentSuite,...shortLead,...imagePreview,...execution].sort());
  expect(plan.plan.find(s=>s.path===amendmentSuite)?.config).toBe('vitest.config.ts');
 });
 it('guards the actual amendment-service domain imports against a newly omitted direct dependency',()=>{
  const source=readFileSync('apps/api/src/production-platform/development-amendment-service.ts','utf8');
  const dependencies=[...source.matchAll(/from ["']\.\/(development-[^"']+)\.js["']/g)].map(m=>'apps/api/src/production-platform/'+m[1]+'.ts');
  expect(dependencies.length).toBeGreaterThanOrEqual(5);
  for(const path of dependencies)expect(classifyFullGatePaths([path]).mappedPostgresTests).toContain(amendmentSuite);
 });
 it('keeps one real suite when source, contract, its test and duplicates are changed together',()=>{
  const paths=['apps/api/src/production-platform/development-document-format.ts','apps/api/src/production-platform/development-amendment-service.ts','packages/contracts/src/digital-development.ts',amendmentSuite,amendmentSuite],plan=amendmentPlan(paths);
  expect(plan.plan.filter(s=>s.path===amendmentSuite)).toHaveLength(1);expect(plan.plan.map(s=>s.path)).toEqual([...POSTGRES_CHAIN_TESTS,amendmentSuite].sort());expect(POSTGRES_CHAIN_TESTS).not.toContain(amendmentSuite);
 });
 it.each(['apps/web/src/example-page.tsx','docs/governance/example.md','apps/api/src/wages/wage-service.ts','apps/api/src/production-platform/bulk-preparation-service.ts','apps/api/src/production-platform/development-technical-service.ts'])('does not add correction PG to unrelated path %s',path=>{expect(classifyFullGatePaths([path]).mappedPostgresTests).not.toContain(amendmentSuite);});
 it('preserves unknown/shared fallback and all original chain entries without pretending the chain is every PG suite',()=>{
  for(const path of ['apps/api/src/new-domain/unclassified-service.ts','packages/contracts/src/new-sensitive-contract.ts','vitest.config.ts','apps/api/src/production-platform/development-future-service.ts']){const risk=classifyFullGatePaths([path]),plan=amendmentPlan([path]);expect(risk.highRisk).toBe(true);expect(risk.businessChainSensitive).toBe(true);expect(plan.plan.map(s=>s.path)).toEqual([...POSTGRES_CHAIN_TESTS].sort());}
  const combined=amendmentPlan(['apps/api/src/production-platform/development-document-format.ts','apps/api/src/new-domain/unclassified-service.ts','apps/api/migrations/9999_test.sql']);
  for(const path of [...POSTGRES_CHAIN_TESTS,amendmentSuite])expect(combined.plan.map(s=>s.path)).toContain(path);
  expect(combined.plan.map(s=>s.path)).not.toContain('tests/integration/migration-compatibility-postgres.test.ts');
 });
});

it("requires Full and the real DB chain without operational drills for shared lane code", () => {
  const result = classifyFullGatePaths(["scripts/ci/full-gate-lanes.mjs"]);
  expect(result.highRisk).toBe(true);
  expect(result.dbRequired).toBe(true);
  expect(result.deploymentSensitive).toBe(true);
  expect(result).toEqual(classifyFullGatePaths(["scripts/ci/ci-gate-runtime.mjs"]));
  expect(result.maintenanceSensitive).toBe(false);
  expect(result.activationSensitive).toBe(false);
  expect(result.transferSensitive).toBe(false);
  expect(amendmentPlan(['scripts/ci/full-gate-lanes.mjs']).plan.map(s=>s.path)).toEqual([...POSTGRES_CHAIN_TESTS].sort());
});

describe("Full Gate sensitive path mapping", () => {
  it('maps diagnostic startup, request hooks and snapshot changes to the real driver regression',()=>{
    for(const path of ['apps/api/src/platform/journey-diagnostic.ts','apps/api/src/server.ts','apps/api/src/app.ts','apps/api/src/acceptance-clock/hooks.ts','apps/api/src/production-platform/journey-snapshot-reads.ts','tests/unit/journey-diagnostic.test.ts']) {
      const result=classifyFullGatePaths([path]);expect(result.dbRequired).toBe(true);expect(result.mappedPostgresTests).toContain('tests/integration/journey-diagnostic-postgres.test.ts');
    }
  });
  it("maps changed bulk requirements and their shared clock fixture to all actual consumer suites",()=>{
    for(const path of ['tests/helpers/business-anchor-fixture.ts','tests/helpers/bulk-preparation-fixture.ts','tests/helpers/bulk-preshrink-correction-fixture.ts','apps/api/src/production-platform/bulk-preshrink-correction-service.ts','apps/api/src/production-platform/bulk-sla-evidence.ts']){
      const result=classifyFullGatePaths([path]);expect(result.businessChainSensitive).toBe(true);
      for(const suite of ['business-anchors-clock','production-readiness','sourcing-pr03','bulk-preshrink-correction'])expect(result.mappedPostgresTests).toContain(`tests/integration/${suite}-postgres.test.ts`);
      expect(()=>assertMappedPostgresTests(result.mappedPostgresTests)).not.toThrow();
    }
  });
  it("requires real PG13 Journey reads for query, route, contract and regression changes",()=>{
    for(const path of ["apps/api/src/production-platform/journey-log.ts","apps/api/src/production-platform/journey-query.ts","apps/api/src/production-platform/identity-routes.ts","packages/contracts/src/digital-production-journey.ts","tests/integration/digital-journey-postgres.test.ts","scripts/ci/journey-pg13-regression.mjs"]){
      const result=classifyFullGatePaths([path]);expect(result.journeyPg13Compat).toBe(true);expect(result.dbRequired).toBe(true);expect(result.mappedPostgresTests).toContain("tests/integration/digital-journey-postgres.test.ts");
    }
    for(const path of ["apps/web/src/cockpit-home.tsx","apps/api/src/receiving/receiving-service.ts","docs/requirements/cockpit-display-v1.0.md"])expect(classifyFullGatePaths([path]).journeyPg13Compat).toBe(false);
  });
  it.each([
    ["apps/api/src/pattern-room/order-service.ts", "pattern-room", []],
    ["apps/api/src/access/service.ts", "access", ["tests/integration/access-postgres.test.ts"]],
    ["apps/api/src/auth/service.ts", "access", ["tests/integration/employee-access-lifecycle-postgres.test.ts"]],
    ["apps/api/src/wages/wage-service.ts", "wages", ["tests/integration/finance-wage-access-postgres.test.ts"]],
    ["apps/api/src/access/supplier-onboarding-service.ts", "suppliers", ["tests/integration/supplier-onboarding-postgres.test.ts"]],
    ["apps/api/src/tools/attachments.ts", "tools", ["tests/integration/public-tools-postgres.test.ts"]],
    ["apps/api/src/receiving/receiving-service.ts", "receiving", ["tests/integration/receiving-postgres.test.ts"]],
  ])("maps %s to %s and real PostgreSQL coverage", (path, domain, expectedTests) => {
    const result = classifyFullGatePaths([path]);
    expect(result.dbRequired).toBe(true);
    expect(result.businessChainSensitive).toBe(true);
    expect(result.domains).toContain(domain);
    for (const test of expectedTests) expect(result.mappedPostgresTests).toContain(test);
  });

  it.each(Object.entries(POSTGRES_CASE_SUITES))("maps imported module %s to runnable suite %s", (module, suite) => {
    const result = classifyFullGatePaths([module]);
    expect(result.dbRequired).toBe(true);
    expect(result.businessChainSensitive).toBe(!INDEPENDENT_POSTGRES_TESTS.includes(suite));
    expect(result.mappedPostgresTests).toEqual([suite]);
    if(INDEPENDENT_POSTGRES_TESTS.includes(suite)) expect(hasStaticPostgresCaseImport(readFileSync(suite, "utf8"), module)).toBe(true);
    else expect(readFileSync(suite,"utf8")).toContain(module.split("/").at(-1)!.replace(/\.ts$/, ".js"));
    expect(() => assertMappedPostgresTests(result.mappedPostgresTests)).not.toThrow();
  });

  it("deduplicates a case module and its suite and rejects non-runnable entries", () => {
    const module = "tests/integration/receiving-analysis-postgres.cases.ts";
    const suite = "tests/integration/receiving-postgres.test.ts";
    expect(classifyFullGatePaths([module, suite]).mappedPostgresTests).toEqual([suite]);
    expect(() => assertMappedPostgresTests([module])).toThrow("not a runnable test suite");
  });

  it("fails closed for an unknown backend or shared-contract path", () => {
    for (const path of [
      "apps/api/src/new-domain/unclassified-service.ts",
      "packages/contracts/src/new-sensitive-contract.ts",
    ]) {
      const result = classifyFullGatePaths([path]);
      expect(result.highRisk).toBe(true);
      expect(result.dbRequired).toBe(true);
      expect(result.businessChainSensitive).toBe(true);
      expect(result.domains).toContain("backend");
    }
  });

  it("keeps isolated web, CSS and documentation changes out of DB escalation", () => {
    for (const path of [
      "apps/web/src/example-page.tsx",
      "apps/web/src/example.css",
      "docs/governance/example.md",
    ]) {
      const result = classifyFullGatePaths([path]);
      expect(result.highRisk).toBe(false);
      expect(result.dbRequired).toBe(false);
      expect(result.mappedPostgresTests).toEqual([]);
    }
  });

  it("maps access/auth through a discoverable PostgreSQL wrapper", () => {
    const result = classifyFullGatePaths(["apps/api/src/access/service.ts"]);
    expect(result.mappedPostgresTests).toContain("tests/integration/full-business-chain-postgres.test.ts");
    expect(result.mappedPostgresTests).not.toContain("tests/integration/member-module-policy-postgres.cases.ts");
  });

  it("does not schedule a deleted PostgreSQL test path while still escalating the diff", () => {
    const deleted = classifyFullGatePaths(["tests/integration/removed-postgres.test.ts"]);
    expect(deleted.businessChainSensitive).toBe(true);
    expect(deleted.dbRequired).toBe(true);
    expect(deleted.domains).toContain("postgres-test");
    expect(deleted.mappedPostgresTests).not.toContain("tests/integration/removed-postgres.test.ts");
  });

  it("runs receiving analysis cases through the real receiving suite", () => {
    const result = classifyFullGatePaths(["tests/integration/receiving-analysis-postgres.cases.ts"]);
    expect(result.dbRequired).toBe(true);
    expect(result.businessChainSensitive).toBe(false);
    expect(result.mappedPostgresTests).toEqual(["tests/integration/receiving-postgres.test.ts"]);
  });

  it('keeps native readiness, cut and termination readers on their actual PostgreSQL consumers',()=>{
    const readiness=classifyFullGatePaths(['apps/api/src/production-platform/task-readiness-facts.ts']);
    expect(readiness.mappedPostgresTests).toEqual(expect.arrayContaining([
      'tests/integration/production-readiness-postgres.test.ts','tests/integration/development-technical-postgres.test.ts','tests/integration/digital-production-tasks-postgres.test.ts','tests/integration/journey-fact-model-postgres.test.ts'
    ]));
    for(const name of ['journey-cut-scopes','journey-termination']){
      const result=classifyFullGatePaths(['apps/api/src/production-platform/'+name+'.ts']);
      expect(result.mappedPostgresTests).toContain('tests/integration/journey-fact-model-postgres.test.ts');
      expect(result.maintenanceSensitive).toBe(false);
    }
  });

  it('maps fixed timeline native writes and real craft controls without a maintenance drill',()=>{
    for(const path of ['apps/api/src/production-platform/fixed-order-route.ts','apps/api/src/production-platform/factory-step-ledger.ts','apps/web/src/independent-craft-field.tsx']){
      const result=classifyFullGatePaths([path]);
      expect(result.mappedPostgresTests).toEqual(expect.arrayContaining(['tests/integration/fixed-timeline-postgres.test.ts','tests/integration/fixed-timeline-native-browser-postgres.test.ts']));
      expect(result.maintenanceSensitive).toBe(false);
    }
  });

  it("maps migration, deployment and changed PostgreSQL tests explicitly", () => {
    const migration = classifyFullGatePaths(["apps/api/migrations/9999_test.sql"]);
    expect(migration.migrationSensitive).toBe(true);
    expect(migration.dbRequired).toBe(true);
    expect(migration.mappedPostgresTests).not.toContain("tests/integration/migration-compatibility-postgres.test.ts");
    expect(migration.maintenanceSensitive).toBe(false);

    const deployment = classifyFullGatePaths([".github/workflows/full-gate.yml"]);
    expect(deployment.deploymentSensitive).toBe(true);
    expect(deployment.dbRequired).toBe(true);
    expect(classifyFullGatePaths(["scripts/dx-acceptance.sh"]).deploymentSensitive).toBe(true);
    expect(classifyFullGatePaths(["scripts/ci/acceptance-maintenance-drill.mjs"]).deploymentSensitive).toBe(true);
    for(const path of ["scripts/ci/ci-gate-runtime.mjs","scripts/ci/pr-gate-protocol.mjs","scripts/ci/pr-gate-controller.mjs","scripts/ci/verify-actions-policy.mjs","scripts/check-main-release-compat.mjs","scripts/ci/main-release-history-drill.mjs","docs/operations/g1-acceptance-compat-update.sh"])expect(classifyFullGatePaths([path]).deploymentSensitive).toBe(true);
    expect(deployment.mappedPostgresTests).not.toContain("tests/integration/migration-compatibility-postgres.test.ts");
    expect(classifyFullGatePaths([".github/workflows/future-deploy.yml"]).mappedPostgresTests).toContain("tests/integration/migration-compatibility-postgres.test.ts");
    for (const path of ["scripts/migration-lib.mjs", "scripts/migration-history-policy.mjs", "scripts/check-migration-export.mjs"]) {
      const result = classifyFullGatePaths([path]);
      expect(result.migrationSensitive).toBe(true);
      expect(result.highRisk).toBe(true);
      expect(result.dbRequired).toBe(true);
      expect(result.mappedPostgresTests).toContain("tests/integration/migration-compatibility-postgres.test.ts");
      expect(result.maintenanceSensitive).toBe(true);
    }

    const changedTest = "tests/integration/supplier-onboarding-postgres.test.ts";
    const test = classifyFullGatePaths([changedTest]);
    expect(test.mappedPostgresTests).toContain(changedTest);
    expect(test.dbRequired).toBe(true);
  });
});


it('maps current-production immutable-result, permission, material and aggregate consumers into the original PostgreSQL suite',()=>{
 const suite='tests/integration/m01-production-statistics-postgres.test.ts';
 for(const path of ['apps/api/src/production-platform/production-statistics-query.ts','apps/api/src/production-platform/production-statistics-materials.ts','apps/api/src/production-platform/production-statistics-projection.ts','apps/api/src/production-platform/analysis-result-store.ts','apps/api/src/production-platform/reporting-query.ts','apps/api/src/production-platform/reporting-routes.ts','apps/api/src/production-platform/factory-production-facts.ts','packages/contracts/src/production-statistics.ts','packages/contracts/src/digital-production-analysis.ts','packages/domain/src/production-statistics.ts'])expect(classifyFullGatePaths([path]).mappedPostgresTests).toContain(suite);
 for(const path of ['apps/api/src/production-platform/reporting-query.ts','apps/api/src/production-platform/reporting-routes.ts','packages/contracts/src/digital-production-analysis.ts','tests/helpers/business-anchor-fixture.ts'])expect(classifyFullGatePaths([path]).mappedPostgresTests).toContain('tests/integration/time-reading-clock-postgres.test.ts');
});

it('keeps all three original browser modes in the canonical plan when their shared runner or fixture changes',()=>{for(const path of ['tests/acceptance/m01-current-production-native-browser.ts','tests/fixtures/m01-current-production-native-ui.tsx']){const plan=amendmentPlan([path]).plan.map(row=>row.path);for(const suite of ['m01-current-production','m01-production-period','m01-production-collaboration'])expect(plan).toContain('tests/integration/'+suite+'-native-browser-postgres.test.ts');}});

describe('M01 measured Journey batches stay on the original native gate',()=>{
 it('maps each actual batching consumer and its suite to the100s canonical correctness configuration',()=>{
  const suite='tests/integration/m01-journey-performance-postgres.test.ts';
  for(const path of ['apps/api/src/production-platform/journey-query.ts','apps/api/src/production-platform/journey-snapshot-reads.ts','apps/api/src/production-platform/journey-snapshot-batches.ts','apps/api/src/production-platform/journey-batch-templates.ts','apps/api/src/production-platform/journey-task-summary.ts',suite]){const scope=classifyFullGatePaths([path]);expect(scope.dbRequired).toBe(true);expect(scope.mappedPostgresTests).toContain(suite);}
  expect(configForSuite(suite)).toBe('vitest.business-chain.config.ts');
 });
 it('runs page argument, authorization and browser read regression suites when the shared task reader changes',()=>{
  for(const path of ['apps/api/src/production-platform/task-page-read-context.ts','apps/api/src/production-platform/task-service.ts','apps/api/src/production-platform/journey-selection-access.ts','apps/web/src/digital-production-page.tsx']){
   const scope=classifyFullGatePaths([path]);expect(scope.dbRequired).toBe(true);
   for(const suite of ['m01-journey-performance','journey-fact-model','workspace-page-facts','workspace-page-native-browser','current-task-plan-browser'])expect(scope.mappedPostgresTests).toContain(`tests/integration/${suite}-postgres.test.ts`);
  }
 });
});

it('R3-04 relative standard calculator remains in the original native settings and original SLA PostgreSQL plan',()=>{
 for(const path of ['packages/domain/src/sla-relative-calculation.ts','packages/domain/src/sla-calculation.ts']){const tests=classifyFullGatePaths([path]).mappedPostgresTests;expect(tests).toContain('tests/integration/m01-settings-native-browser-postgres.test.ts');expect(tests).toContain('tests/integration/sla-calculation-postgres.test.ts');}
 expect(configForSuite('tests/integration/m01-settings-native-browser-postgres.test.ts')).toBe('vitest.business-chain.config.ts');
});

it('keeps original native todo search, read-token and notification suites in the canonical plan for split reads',()=>{
 for(const path of ['apps/api/src/todos/selection.ts','apps/api/src/todos/content-reads.ts','apps/api/src/todos/global-search.ts','apps/api/src/todos/service.ts','apps/api/src/production-platform/notification-service.ts']){
  const risk=classifyFullGatePaths([path]);
  for(const suite of ['todo-global-search','digital-my-todo-context','digital-production-notifications'])expect(risk.mappedPostgresTests).toContain('tests/integration/'+suite+'-postgres.test.ts');
  expect(risk.businessChainSensitive).toBe(true);
 }
});

it('keeps cumulative native packing scope, physical-time precision and original permissions in the canonical PG plan',()=>{
 const suite='tests/integration/effective-packing-postgres.test.ts';
 for(const path of ['apps/api/src/receiving/packing-actual-time.ts','apps/api/src/receiving/packing-alias-invalidation.ts','apps/api/src/receiving/receiving-service.ts','apps/api/src/receiving/receiving-quantity-query.ts','apps/api/src/production-platform/order-closure-service.ts','apps/api/src/production-platform/packing-sla-evidence.ts','packages/contracts/src/receiving-packing-time.ts',suite])expect(classifyFullGatePaths([path]).mappedPostgresTests).toContain(suite);
 expect(configForSuite(suite)).toBe('vitest.business-chain.config.ts');
 expect(classifyFullGatePaths(['apps/web/src/wages/wage-page.tsx']).mappedPostgresTests).not.toContain(suite);
});

it('treats the extracted Full CI receipt worker as shared gate code while retaining real backup-tool drills',()=>{
 const shared=classifyFullGatePaths(['.github/workflows/full-gate.yml']);
 expect(shared.highRisk).toBe(true);expect(shared.dbRequired).toBe(true);expect(shared.deploymentSensitive).toBe(true);expect(shared.maintenanceSensitive).toBe(false);
 for(const path of ['scripts/backup-postgres.sh','scripts/restore-postgres.sh','scripts/deploy/backup-runtime.sh'])expect(classifyFullGatePaths([path]).maintenanceSensitive).toBe(true);
});

it('maps actual paired-settings writers, migration and full-App harness to native atomic/publication and readonly cases',()=>{
 for(const path of ['apps/api/src/production-platform/sla-settings-sets.ts','packages/contracts/src/sla-settings-sets.ts','apps/api/migrations/0283_sla_settings_sets.sql','tests/acceptance/supplychain-settings-browser.ts']){
  const result=classifyFullGatePaths([path]);expect(result.mappedPostgresTests).toContain('tests/integration/sla-settings-sets-postgres.test.ts');expect(result.mappedPostgresTests).toContain('tests/integration/m01-settings-native-browser-postgres.test.ts');
 }
});


it('maps actual supply-chain integration consumers to the original App and native fixed progress checks',()=>{const result=classifyFullGatePaths(['apps/web/src/cockpit-fixed-schedule.tsx','apps/web/src/components.tsx']);expect(result.mappedPostgresTests).toContain('tests/integration/supplychain-board-native-browser-postgres.test.ts');expect(result.mappedPostgresTests).toContain('tests/integration/fixed-progress-postgres.test.ts');});

it('maps the new order-time storage and algorithm to its actual PG cases without operational drills',()=>{
 for(const path of ['apps/api/src/production-platform/order-time-plan-repository.ts','apps/api/src/production-platform/order-time-schedule.ts','packages/contracts/src/order-time-plan.ts','apps/api/migrations/0284_order_time_plan_versions.sql']){
  const scope=classifyFullGatePaths([path]);expect(scope.mappedPostgresTests).toContain('tests/integration/order-time-plan-postgres.test.ts');expect(scope.maintenanceSensitive).toBe(false);
 }
});

 it('keeps automatic quotation browser coverage on the existing native correctness budget',()=>{
  const suite='tests/integration/automatic-quotation-native-browser-postgres.test.ts';
  for(const path of ['apps/api/src/production-platform/quotation-assembly.ts','apps/api/src/production-platform/development-commercial-fields.ts','apps/web/src/digital-quotation-panel.tsx',suite]){
   const plan=amendmentPlan([path]);
   expect(plan.plan.filter(s=>s.path===suite)).toEqual([{path:suite,config:'vitest.business-chain.config.ts',memberships:['mapped']}]);
  }
  for(const path of ['apps/api/src/production-platform/quotation-assembly.ts','apps/api/src/production-platform/development-commercial-fields.ts'])expect(classifyFullGatePaths([path]).mappedPostgresTests).toContain(amendmentSuite);
 });

it('keeps exact craft instance adapters and frozen labels in native and authenticated browser coverage',()=>{
 for(const name of ['development-craft-instance-evidence','task-craft-display','development-sla-evidence','journey-supervision','journey-task-summary']){
  const mapped=classifyFullGatePaths([`apps/api/src/production-platform/${name}.ts`]).mappedPostgresTests;
  expect(mapped).toContain('tests/integration/special-craft-native-postgres.test.ts');expect(mapped).toContain('tests/integration/special-craft-browser-postgres.test.ts');
 }
});

it('keeps frozen factory graph, exact fact serialization and clock rebuild in the original App regression',()=>{
 for(const name of ['factory-evaluation-route','factory-sla-evidence','fixed-factory-timing','sla-order-service','journey-supervision','journey-fact-model','journey-selection-clock']){
  const plan=amendmentPlan([`apps/api/src/production-platform/${name}.ts`]);
  expect(plan.plan.filter(row=>row.path==='tests/integration/factory-supervision-instances-browser-postgres.test.ts')).toEqual([{path:'tests/integration/factory-supervision-instances-browser-postgres.test.ts',config:'vitest.business-chain.config.ts',memberships:['mapped']}]);
 }
});

it('executes the linked-applicability App and transactional regression for every real confirmation caller',()=>{
 for(const name of ['order-time-linked-applicability','order-time-plan-repository','order-time-operation-state','order-time-request-service','order-time-automatic']){
  const plan=amendmentPlan([`apps/api/src/production-platform/${name}.ts`]);
  expect(plan.plan.filter(row=>row.path==='tests/integration/order-time-linked-applicability-browser-postgres.test.ts')).toEqual([{path:'tests/integration/order-time-linked-applicability-browser-postgres.test.ts',config:'vitest.business-chain.config.ts',memberships:['mapped']}]);
 }
});

it('keeps exact task current-P readers, original B and native UI in canonical database coverage',()=>{
 for(const file of ['apps/api/src/production-platform/current-task-plan-targets.ts','apps/api/src/production-platform/fixed-task-targets.ts','apps/api/src/production-platform/framework-node-targets.ts','apps/api/src/production-platform/order-time-work-task-kind.ts','apps/api/src/production-platform/order-time-reading.ts','apps/api/src/production-platform/task-service.ts','apps/web/src/task-plan-targets.tsx','apps/web/src/task-plan-targets.css','apps/web/src/task-workbench-sample.tsx','apps/web/src/bulk-task-workbench.tsx','apps/web/src/bulk-preparation-panel.tsx','apps/web/src/digital-production-tasks-panel.tsx','packages/contracts/src/digital-production-tasks.ts','tests/helpers/current-task-plan-fixture.ts','tests/helpers/order-time-rewash-fixture.ts']){
  const plan=amendmentPlan([file]);
  for(const path of ['tests/integration/current-task-plan-postgres.test.ts','tests/integration/current-task-plan-browser-postgres.test.ts'])expect(plan.plan.filter(row=>row.path===path)).toEqual([{path,config:'vitest.business-chain.config.ts',memberships:['mapped']}]);
 }
});

it('keeps incomplete-publication and exact native craft choices in original request and App regressions',()=>{
 for(const file of ['order-time-publication-intent','fixed-development-work','fixed-order-work','fixed-work-definition']){
  const risk=classifyFullGatePaths([`apps/api/src/production-platform/${file}.ts`]);
  for(const suite of ['order-time-requests-postgres','order-time-requests-browser-postgres'])expect(risk.mappedPostgresTests).toContain(`tests/integration/${suite}.test.ts`);
 }
 expect(classifyFullGatePaths(['apps/web/src/order-time-washing-rebase.ts']).mappedPostgresTests).toContain('tests/integration/order-time-requests-browser-postgres.test.ts');
});

describe('reviewed single-owner PostgreSQL test-only selection', () => {
  it.each(INDEPENDENT_POSTGRES_TESTS)('keeps Full and the unchanged runnable entry without unrelated chain: %s', suite => {
    const risk=classifyFullGatePaths([suite]), plan=amendmentPlan([suite]);
    expect(risk.highRisk).toBe(true);
    expect(risk.dbRequired).toBe(true);
    expect(risk.businessChainSensitive).toBe(false);
    expect(plan.chain).toBe(false);
    expect(plan.plan.map(row=>row.path)).toEqual(risk.mappedPostgresTests);
    expect(plan.plan.map(row=>row.path)).toContain(suite);
  });
  it('deduplicates the reviewed case and its owner without weakening execution context', () => {
    const suite='tests/integration/receiving-postgres.test.ts';
    const plan=amendmentPlan(['tests/integration/receiving-analysis-postgres.cases.ts',suite,suite]);
    expect(plan.chain).toBe(false);
    expect(plan.plan).toEqual([{path:suite,config:configForSuite(suite),memberships:['mapped']}]);
  });
  it.each([
    'tests/helpers/business-anchor-fixture.ts',
    'apps/api/src/production-platform/journey-fact-repository.ts',
    'apps/api/src/auth/service.ts',
    'apps/api/migrations/9999_test.sql',
    'packages/domain/src/digital-sla-plan.ts',
    'packages/domain/src/new-unclassified-domain.ts',
    'tests/integration/unknown-postgres.test.ts',
    'tests/integration/sample-read-postgres.test.ts',
    'tests/integration/member-module-policy-postgres.cases.ts',
    'vitest.config.ts',
  ])('retains the conservative chain for mixed or multi-owner input: %s', extra => {
    const plan=amendmentPlan(['tests/integration/receiving-postgres.test.ts',extra]);
    expect(plan.chain).toBe(true);
    for(const suite of POSTGRES_CHAIN_TESTS)expect(plan.plan.map(row=>row.path)).toContain(suite);
  });
  it('fails closed for standalone unknown domain code and deleted test entries', () => {
    for(const path of ['packages/domain/src/new-unclassified-domain.ts','tests/integration/removed-postgres.test.ts']){
      const risk=classifyFullGatePaths([path]);
      expect(risk.highRisk).toBe(true);expect(risk.businessChainSensitive).toBe(true);
    }
  });
});

describe('case bindings use executable static imports, not textual mentions', () => {
  const module='tests/integration/receiving-analysis-postgres.cases.ts';
  it('recognizes the original side-effect import', () => {
    expect(hasStaticPostgresCaseImport('import "./receiving-analysis-postgres.cases.js";',module)).toBe(true);
  });
  it.each([
    '// import "./receiving-analysis-postgres.cases.js";',
    '/* import "./receiving-analysis-postgres.cases.js"; */',
    'const explanation = \'import "./receiving-analysis-postgres.cases.js";\';',
    'const explanation = `import "./receiving-analysis-postgres.cases.js";`;',
    'import type { Something } from "./receiving-analysis-postgres.cases.js";',
    'void import("./receiving-analysis-postgres.cases.js");',
    '',
  ])('rejects a missing static execution edge: %s', source => {
    expect(hasStaticPostgresCaseImport(source,module)).toBe(false);
    expect(()=>assertStaticPostgresCaseImport(source,module,"tests/integration/receiving-postgres.test.ts")).toThrow("POSTGRES_CASE_IMPORT_REQUIRED");
  });
  it('does not preserve coverage when the import is removed but its comment remains', () => {
    const before='import "./receiving-analysis-postgres.cases.js";\n// receiving-analysis-postgres.cases.js';
    expect(hasStaticPostgresCaseImport(before,module)).toBe(true);
    expect(hasStaticPostgresCaseImport(before.split('\n').slice(1).join('\n'),module)).toBe(false);
  });
});

describe('reviewed SLA/Journey production-source profile', () => {
  it('retains exact mapped readers plus every non-exempt chain bridge for the RP2 source family', () => {
    const input=[...SLA_JOURNEY_SOURCE_PATHS,...SLA_JOURNEY_SUPPORT_PATHS];
    const risk=classifyFullGatePaths(input),plan=amendmentPlan(input);
    // This profile includes the actual forecast UI source, so retain its
    // newly registered native consumer in addition to every existing bridge.
    const expected=[...new Set([...SLA_JOURNEY_REQUIRED_TESTS,...POSTGRES_CHAIN_TESTS.filter(path=>!SLA_JOURNEY_UNRELATED_CHAIN_TESTS.includes(path)),'tests/integration/bounded-forecast-native-browser-postgres.test.ts'])].sort();
    expect(plan.plan.map(row=>row.path)).toEqual(expected);
    expect(risk.highRisk).toBe(true);expect(risk.dbRequired).toBe(true);
    expect(risk.journeyPg13Compat).toBe(true);
    expect(risk.domains).toContain('sla-journey-reviewed-source-profile');
    for(const path of SLA_JOURNEY_UNRELATED_CHAIN_TESTS)expect(plan.plan.map(row=>row.path)).not.toContain(path);
    for(const row of plan.plan)expect(row.config).toBe(configForSuite(row.path));
  });
  it('explicitly maps the shared SLA engine to the actual Journey consumers, not only the old generic chain', () => {
    const plan=amendmentPlan(['packages/domain/src/digital-sla-plan.ts']);
    for(const path of SLA_JOURNEY_REQUIRED_TESTS)expect(plan.plan.map(row=>row.path)).toContain(path);
    expect(plan.chain).toBe(true);
    for(const path of POSTGRES_CHAIN_TESTS.filter(path=>!path.includes('own-tail-responsibility-history')))expect(plan.plan.map(row=>row.path)).toContain(path);
    expect(classifyFullGatePaths(['packages/domain/src/digital-sla-plan.ts']).chainProfile).toBe('sla-journey-engine-v1');
  });
  it.each([
    'apps/api/src/auth/service.ts','apps/api/src/access/service.ts',
    'apps/api/src/production-platform/task-service.ts',
    'apps/api/src/production-platform/journey-new-unclassified.ts',
    'packages/domain/src/new-unclassified-domain.ts',
    'apps/api/migrations/9999_test.sql',
    'tests/helpers/business-anchor-fixture.ts',
    'scripts/ci/full-gate-risk-map.mjs',
    'tests/integration/own-tail-responsibility-history-postgres.test.ts',
    'tests/integration/sample-create-postgres.test.ts',
    'apps/api/src/samples/sample-create-service.ts',
    'packages/contracts/src/index.ts',
    'scripts/acceptance/worker-people-maintenance.ts',
    'scripts/acceptance/authorization-guard.ts',
    'tests/integration/acceptance-worker-people-postgres.test.ts',
    'apps/api/src/tools/repositories.ts',
    'apps/api/src/platform/errors.ts',
    'apps/api/src/platform/migration-manifest.json',
  ])('restores the full chain when an unaudited or independently affected boundary is added: %s', path => {
    const plan=amendmentPlan(['packages/domain/src/digital-sla-plan.ts',path]);
    expect(plan.chain).toBe(true);
    for(const test of POSTGRES_CHAIN_TESTS)expect(plan.plan.map(row=>row.path)).toContain(test);
  });
});

it('rejects forged or incompatible chain profile context', () => {
 const env={BASE_SHA:'a'.repeat(40),DB_REQUIRED:'true',BUSINESS_CHAIN_SENSITIVE:'true',MIGRATION_SENSITIVE:'false',DEPLOYMENT_SENSITIVE:'false',MAPPED_POSTGRES_TESTS:'tests/integration/digital-journey-postgres.test.ts',CHAIN_PROFILE:'sla-journey-v1'};
 expect(()=>fullGatePostgresPlan({...env,CHAIN_PROFILE:'unknown'})).toThrow('POSTGRES_CHAIN_PROFILE_UNKNOWN');
 expect(()=>fullGatePostgresPlan({...env,MIGRATION_SENSITIVE:'true'})).toThrow('POSTGRES_CHAIN_PROFILE_CONTEXT_INVALID');
 expect(()=>fullGatePostgresPlan({...env,DEPLOYMENT_SENSITIVE:'true'})).toThrow('POSTGRES_CHAIN_PROFILE_CONTEXT_INVALID');
 expect(()=>fullGatePostgresPlan({...env,DB_REQUIRED:'false',BUSINESS_CHAIN_SENSITIVE:'false'})).toThrow('POSTGRES_CHAIN_PROFILE_CONTEXT_INVALID');
});

it('restores the four indirectly loaded suites and retains only independent historical exclusion for engine changes', () => {
 const paths=[...SLA_JOURNEY_SOURCE_PATHS,...SLA_JOURNEY_SUPPORT_PATHS,'packages/domain/src/digital-sla-plan.ts'];
 const risk=classifyFullGatePaths(paths),plan=amendmentPlan(paths);
 expect(risk.chainProfile).toBe('sla-journey-engine-v1');
 const retained=POSTGRES_CHAIN_TESTS.filter(path=>!path.includes('own-tail-responsibility-history'));
 expect(plan.plan.map(row=>row.path)).toEqual([...new Set([...SLA_JOURNEY_REQUIRED_TESTS,...retained,'tests/integration/bounded-forecast-native-browser-postgres.test.ts'])].sort());
});


it('retains the original authenticated finite forecast consumer for each exact UI field path without changing full fallback',()=>{
 for(const file of ['apps/web/src/cockpit-detail.css','apps/web/src/cockpit-fixed-schedule.tsx','apps/web/src/cockpit-node-dates.tsx','apps/web/src/po-delivery-dates.tsx','tests/integration/bounded-forecast-native-browser-postgres.test.ts']){
  const plan=amendmentPlan([file]);
  const path='tests/integration/bounded-forecast-native-browser-postgres.test.ts';
  expect(plan.plan.filter(row=>row.path===path)).toEqual([{path,config:'vitest.business-chain.config.ts',memberships:['mapped']}]);
 }
});
