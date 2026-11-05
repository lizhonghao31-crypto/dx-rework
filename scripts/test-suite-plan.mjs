import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
export const STATIC_CHAIN_TESTS=Object.freeze([
  "tests/unit/current-migration-manifest-checksum.test.ts",
  "tests/unit/business-chain-ui-contract.test.ts",
  "tests/unit/business-chain-schema-cleanup.test.ts",
  "tests/unit/aliyun-oss-v4-client.test.ts",
  "tests/unit/work-reporting.test.ts",
  "tests/unit/root-superuser-self-review.test.ts",
  "tests/unit/root-global-business-bypass.test.ts",
  "tests/unit/root-ui-entry-contract.test.ts",
  "tests/unit/receiving-pr01-contract.test.ts",
  "tests/unit/n01-paper-report-entry.test.ts",
  "tests/unit/acceptance-control.test.ts",
  "tests/unit/acceptance-lab-web.test.ts",
  "tests/integration/acceptance-control-routes.test.ts"
]);
export const POSTGRES_CHAIN_TESTS=Object.freeze([
  "tests/integration/qc-progress-retirement-postgres.test.ts",
  "tests/integration/production-readiness-postgres.test.ts",
  "tests/integration/full-business-chain-postgres.test.ts",
  "tests/integration/customer-quotation-postgres.test.ts",
  "tests/integration/development-technical-postgres.test.ts",
  "tests/integration/series-plan-postgres.test.ts",
  "tests/integration/own-tail-responsibility-history-postgres.test.ts",
  "tests/integration/root-single-account-two-pass-postgres.test.ts",
  "tests/integration/receiving-postgres.test.ts",
  "tests/integration/rework-v2-n01-postgres.test.ts",
  "tests/integration/rework-v2-process-worker-preassignment-postgres.test.ts",
  "tests/integration/sourcing-pr03-postgres.test.ts",
  "tests/integration/sourcing-digital-flow-postgres.test.ts",
  "tests/integration/production-closure-postgres.test.ts",
  "tests/integration/sample-foundation-postgres.test.ts",
  "tests/integration/sample-read-postgres.test.ts",
  "tests/integration/sample-create-postgres.test.ts",
  "tests/integration/sample-workflow-postgres.test.ts",
  "tests/integration/sample-disposal-postgres.test.ts",
  "tests/integration/sample-import-postgres.test.ts",
  "tests/integration/acceptance-role-session-postgres.test.ts",
  "tests/integration/acceptance-worker-people-postgres.test.ts"
]);
export const LONG_CORRECTNESS_TESTS=Object.freeze([...POSTGRES_CHAIN_TESTS,'tests/integration/rework-postgres.test.ts','tests/integration/development-technical-postgres.test.ts']);
export const IMMEDIATE_DELETE_TESTS=Object.freeze(['tests/integration/rework-postgres.test.ts']);
// The full business fixture is SQL-heavy and must not contend with another full migration/chain.
export const ISOLATED_CORRECTNESS_TESTS=Object.freeze([...IMMEDIATE_DELETE_TESTS,'tests/integration/full-business-chain-postgres.test.ts']);
export const configForSuite=path=>ISOLATED_CORRECTNESS_TESTS.includes(path)?'vitest.postgres-immediate.config.ts':LONG_CORRECTNESS_TESTS.includes(path)?'vitest.business-chain.config.ts':'vitest.config.ts';
export const postgresTestFiles=()=>readdirSync('tests/integration').filter(name=>name.endsWith('.test.ts')&&readFileSync('tests/integration/'+name,'utf8').includes('TEST_DATABASE_URL')).map(name=>'tests/integration/'+name).sort();
export const ROOT_AUDIT_TESTS=Object.freeze(['tests/integration/root-self-system-admin-postgres.test.ts','tests/integration/supplier-onboarding-postgres.test.ts','tests/integration/supplier-maintenance-postgres.test.ts','tests/integration/quality-basic-rework-postgres.test.ts','tests/integration/wage-settlement-postgres.test.ts']);
export function postgresPlan({mapped=[],chain=false,rootAudit=false}={}) {
 const audit=rootAudit||mapped.includes(ROOT_AUDIT_TESTS[0]);
 const suites=[...new Set([...mapped,...(chain?POSTGRES_CHAIN_TESTS:[]),...(audit?ROOT_AUDIT_TESTS:[])])].sort();
 return suites.map(path=>({path,config:configForSuite(path),memberships:[...(mapped.includes(path)?['mapped']:[]),...(chain&&POSTGRES_CHAIN_TESTS.includes(path)?['chain']:[]),...(audit&&ROOT_AUDIT_TESTS.includes(path)?['root-audit']:[])]}));
}
export function fullGatePostgresPlan(environment){
 for(const key of ['DB_REQUIRED','BUSINESS_CHAIN_SENSITIVE','MIGRATION_SENSITIVE','DEPLOYMENT_SENSITIVE'])if(!['true','false'].includes(environment[key]))throw Error('POSTGRES_RISK_CONTEXT_REQUIRED: '+key);
 if(typeof environment.MAPPED_POSTGRES_TESTS!=='string'||!/^[0-9a-f]{40}$/.test(environment.BASE_SHA??''))throw Error('POSTGRES_RISK_CONTEXT_REQUIRED: mapped suites and immutable base');
 const mapped=environment.MAPPED_POSTGRES_TESTS.split(',').filter(Boolean),chain=environment.BUSINESS_CHAIN_SENSITIVE==='true'||environment.MIGRATION_SENSITIVE==='true'||environment.DEPLOYMENT_SENSITIVE==='true';
 if(environment.DB_REQUIRED==='false'){
  if(chain||mapped.length)throw Error('POSTGRES_RISK_CONTEXT_CONTRADICTION');
  return {status:'not-applicable',mapped,chain:false,plan:[]};
 }
 const plan=postgresPlan({mapped,chain,rootAudit:environment.MIGRATION_SENSITIVE==='true'});
 if(!plan.length)throw Error('POSTGRES_EMPTY_PLAN_REJECTED');
 return {status:'required',mapped,chain,plan};
}
export function executionFingerprint(context,plan) {
 return createHash('sha256').update(JSON.stringify({context,plan,configs:[...new Set(plan.map(s=>s.config))].sort().map(path=>[path,readFileSync(path,'utf8')]),runtime:readFileSync('scripts/test-execution-config.mjs','utf8'),executor:readFileSync('scripts/owned-command.mjs','utf8'),contract:readFileSync('scripts/test-resource-contract.mjs','utf8'),sourcingCases:readFileSync(new URL('../tests/fixtures/sourcing-case-inventory.json',import.meta.url),'utf8')})).digest('hex');
}
const sourcingFiles=['tests/integration/sourcing-pr03-postgres.test.ts','tests/integration/sourcing-digital-flow-postgres.test.ts'];
// Reviewed identities for this split only. Native JSON plus the original exit,
// hook-error and cleanup checks; this is not a repository-wide E/D/R proof.
export function assertSourcingCases(report,files,inventory=JSON.parse(readFileSync(new URL('../tests/fixtures/sourcing-case-inventory.json',import.meta.url),'utf8'))){
 if(inventory?.version!==1||! /^[0-9a-f]{40}$/.test(inventory.sourceBaseline??'')||JSON.stringify(Object.keys(inventory.suites??{}).sort())!==JSON.stringify([...sourcingFiles].sort()))throw Error('SOURCING_CASE_INVENTORY_INVALID');
 const key=(ancestors,title)=>{if(!Array.isArray(ancestors)||!ancestors.every(a=>typeof a==='string')||typeof title!=='string'||!title)throw Error('SOURCING_CASE_IDENTITY_INVALID');return JSON.stringify([ancestors,title]);};
 for(const file of files.filter(f=>sourcingFiles.includes(f))){
  const expected=inventory.suites[file];if(!Array.isArray(expected)||!expected.length)throw Error('SOURCING_CASE_INVENTORY_EMPTY');
  const wanted=expected.map(c=>key(c.ancestors,c.title)).sort();if(new Set(wanted).size!==wanted.length)throw Error('SOURCING_CASE_INVENTORY_DUPLICATE');
  const matches=report.testResults.filter(r=>r.name.endsWith('/'+file));if(matches.length!==1||!Array.isArray(matches[0].assertionResults))throw Error('SOURCING_CASE_REPORT_MISSING');
  const actual=matches[0].assertionResults.map(c=>{if(c.status!=='passed')throw Error('SOURCING_CASE_NOT_PASSED: '+c.title);return key(c.ancestorTitles,c.title);}).sort();
  if(JSON.stringify(actual)!==JSON.stringify(wanted))throw Error('SOURCING_CASE_SET_MISMATCH: '+file);
 }
}
export function assertSuiteResults(report,files) {
 if(!Array.isArray(files)||files.length===0)throw Error('POSTGRES_EMPTY_PLAN_REJECTED');
 if(report.success!==true||report.numFailedTests||report.numFailedTestSuites)throw Error('POSTGRES_EXECUTION_FAILED');
 for(const file of files){
  const matches=report.testResults.filter(r=>r.name.endsWith('/'+file));
  if(matches.length!==1||matches[0].status!=='passed'||!matches[0].assertionResults.some(r=>r.status==='passed'))throw Error('Mapped PostgreSQL suite executed no passing tests: '+file);
 }
 if(report.testResults.length!==files.length)throw Error('POSTGRES_UNPLANNED_SUITE');
 if(files.some(f=>sourcingFiles.includes(f)))assertSourcingCases(report,files);
}
export function assertExecutionReceipt(receipt,context,plan) {
 if(receipt.version!==1||receipt.status!=='passed'||receipt.cleanup!=='passed'||receipt.fingerprint!==executionFingerprint(context,plan)||JSON.stringify(receipt.context)!==JSON.stringify(context)||JSON.stringify(receipt.plan)!==JSON.stringify(plan))throw Error('POSTGRES_RECEIPT_CONTEXT_MISMATCH');
 assertSuiteResults(receipt.results,plan.map(s=>s.path));return receipt;
}
