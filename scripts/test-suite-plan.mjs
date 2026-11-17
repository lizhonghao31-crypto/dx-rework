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
export const LONG_CORRECTNESS_TESTS=Object.freeze(['tests/integration/factory-supervision-instances-browser-postgres.test.ts','tests/integration/terminal-quality-projections-browser-postgres.test.ts','tests/integration/order-time-washing-rework-browser-postgres.test.ts','tests/integration/order-time-washing-rework-postgres.test.ts','tests/integration/task-completion-postgres.test.ts','tests/integration/budget-washing-fees-postgres.test.ts','tests/integration/budget-washing-fees-browser-postgres.test.ts','tests/integration/time-framework-cockpit-native-browser-postgres.test.ts','tests/integration/bulk-washing-browser-postgres.test.ts','tests/integration/bulk-washing-postgres.test.ts','tests/integration/special-craft-library-postgres.test.ts','tests/integration/special-craft-native-postgres.test.ts','tests/integration/special-craft-browser-postgres.test.ts','tests/integration/automatic-quotation-native-browser-postgres.test.ts','tests/integration/whole-order-deletion-postgres.test.ts','tests/integration/whole-order-deletion-browser-postgres.test.ts','tests/integration/order-time-requests-postgres.test.ts','tests/integration/order-time-requests-browser-postgres.test.ts','tests/integration/order-time-reading-postgres.test.ts','tests/integration/order-time-settings-postgres.test.ts','tests/integration/customer-default-merchandisers-postgres.test.ts','tests/integration/r5-settings-native-browser-postgres.test.ts','tests/integration/order-time-plan-postgres.test.ts','tests/integration/sla-settings-sets-postgres.test.ts','tests/integration/supplychain-board-native-browser-postgres.test.ts','tests/integration/fixed-progress-postgres.test.ts','tests/integration/effective-packing-postgres.test.ts','tests/integration/fixed-timeline-native-browser-postgres.test.ts','tests/integration/fixed-timeline-postgres.test.ts','tests/integration/development-execution-read-native-browser-postgres.test.ts','tests/integration/receiving-board-native-browser-postgres.test.ts','tests/integration/sourcing-detail-native-browser-postgres.test.ts','tests/integration/master-data-pages-postgres.test.ts','tests/integration/master-data-pages-native-browser-postgres.test.ts','tests/integration/wage-period-pages-native-browser-postgres.test.ts','tests/integration/wage-period-pages-postgres.test.ts','tests/integration/responsibility-queue-pages-native-browser-postgres.test.ts','tests/integration/responsibility-queue-pages-postgres.test.ts','tests/integration/sourcing-page-details-postgres.test.ts','tests/integration/production-read-batches-postgres.test.ts','tests/integration/workspace-page-facts-postgres.test.ts','tests/integration/workspace-page-native-browser-postgres.test.ts','tests/integration/cockpit-thumbnails-native-browser-postgres.test.ts','tests/integration/attachment-image-preview-postgres.test.ts','tests/integration/module-bundles-native-browser-postgres.test.ts',...POSTGRES_CHAIN_TESTS,'tests/integration/journey-page-native-browser-postgres.test.ts','tests/integration/journey-fact-model-postgres.test.ts','tests/integration/journey-fact-updates-postgres.test.ts','tests/integration/rework-postgres.test.ts','tests/integration/development-technical-postgres.test.ts','tests/integration/sla-calculation-postgres.test.ts','tests/integration/sla-settings-drafts-postgres.test.ts','tests/integration/sla-notification-preferences-postgres.test.ts','tests/integration/m01-settings-native-browser-postgres.test.ts','tests/integration/m01-short-lead-native-browser-postgres.test.ts','tests/integration/m01-production-statistics-postgres.test.ts','tests/integration/m01-delivery-calendar-postgres.test.ts','tests/integration/m01-delivery-calendar-native-browser-postgres.test.ts','tests/integration/m01-sla-history-postgres.test.ts','tests/integration/m01-current-production-native-browser-postgres.test.ts','tests/integration/m01-production-period-postgres.test.ts','tests/integration/m01-production-collaboration-postgres.test.ts','tests/integration/m01-production-period-native-browser-postgres.test.ts','tests/integration/m01-production-collaboration-native-browser-postgres.test.ts','tests/integration/m01-journey-performance-postgres.test.ts','tests/integration/acceptance-session-retention-postgres.test.ts','tests/integration/m01-cockpit-home-native-browser-postgres.test.ts']);
export const IMMEDIATE_DELETE_TESTS=Object.freeze(['tests/integration/rework-postgres.test.ts']);
// The full business fixture is SQL-heavy and must not contend with another full migration/chain.
export const ISOLATED_CORRECTNESS_TESTS=Object.freeze([...IMMEDIATE_DELETE_TESTS,'tests/integration/full-business-chain-postgres.test.ts']);
export const configForSuite=path=>ISOLATED_CORRECTNESS_TESTS.includes(path)?'vitest.postgres-immediate.config.ts':LONG_CORRECTNESS_TESTS.includes(path)?'vitest.business-chain.config.ts':'vitest.config.ts';
export const postgresTestFiles=()=>readdirSync('tests/integration').filter(name=>name.endsWith('.test.ts')&&readFileSync('tests/integration/'+name,'utf8').includes('TEST_DATABASE_URL')).map(name=>'tests/integration/'+name).sort();
export const ROOT_AUDIT_TESTS=Object.freeze(['tests/integration/root-self-system-admin-postgres.test.ts','tests/integration/supplier-onboarding-postgres.test.ts','tests/integration/supplier-maintenance-postgres.test.ts','tests/integration/quality-basic-rework-postgres.test.ts','tests/integration/wage-settlement-postgres.test.ts']);
export const SLA_JOURNEY_CHAIN_EXCLUSIONS=Object.freeze(["tests/integration/own-tail-responsibility-history-postgres.test.ts","tests/integration/sample-foundation-postgres.test.ts","tests/integration/sample-read-postgres.test.ts","tests/integration/sample-create-postgres.test.ts","tests/integration/acceptance-worker-people-postgres.test.ts"]);
export function postgresPlan({mapped=[],chain=false,rootAudit=false,chainProfile='full'}={}) {
 if(!['full','sla-journey-v1','sla-journey-engine-v1'].includes(chainProfile))throw Error('POSTGRES_CHAIN_PROFILE_UNKNOWN');
 if(chainProfile!=='full'&&(!chain||rootAudit))throw Error('POSTGRES_CHAIN_PROFILE_CONTEXT_INVALID');
 const omissions=chainProfile==='sla-journey-v1'?SLA_JOURNEY_CHAIN_EXCLUSIONS:chainProfile==='sla-journey-engine-v1'?['tests/integration/own-tail-responsibility-history-postgres.test.ts']:[];
 const chainTests=POSTGRES_CHAIN_TESTS.filter(path=>!omissions.includes(path));
 const audit=rootAudit||mapped.includes(ROOT_AUDIT_TESTS[0]);
 const suites=[...new Set([...mapped,...(chain?chainTests:[]),...(audit?ROOT_AUDIT_TESTS:[])])].sort();
 return suites.map(path=>({path,config:configForSuite(path),memberships:[...(mapped.includes(path)?['mapped']:[]),...(chain&&chainTests.includes(path)?['chain']:[]),...(audit&&ROOT_AUDIT_TESTS.includes(path)?['root-audit']:[])]}));
}
export function fullGatePostgresPlan(environment){
 for(const key of ['DB_REQUIRED','BUSINESS_CHAIN_SENSITIVE','MIGRATION_SENSITIVE','DEPLOYMENT_SENSITIVE'])if(!['true','false'].includes(environment[key]))throw Error('POSTGRES_RISK_CONTEXT_REQUIRED: '+key);
 if(typeof environment.MAPPED_POSTGRES_TESTS!=='string'||!/^[0-9a-f]{40}$/.test(environment.BASE_SHA??''))throw Error('POSTGRES_RISK_CONTEXT_REQUIRED: mapped suites and immutable base');
 const mapped=environment.MAPPED_POSTGRES_TESTS.split(',').filter(Boolean),chain=environment.BUSINESS_CHAIN_SENSITIVE==='true'||environment.MIGRATION_SENSITIVE==='true'||environment.DEPLOYMENT_SENSITIVE==='true';
 const chainProfile=environment.CHAIN_PROFILE??'full';
 if(!['full','sla-journey-v1','sla-journey-engine-v1'].includes(chainProfile))throw Error('POSTGRES_CHAIN_PROFILE_UNKNOWN');
 if(chainProfile!=='full'&&(!chain||environment.DB_REQUIRED!=='true'||environment.MIGRATION_SENSITIVE==='true'||environment.DEPLOYMENT_SENSITIVE==='true'))throw Error('POSTGRES_CHAIN_PROFILE_CONTEXT_INVALID');
 if(environment.DB_REQUIRED==='false'){
  if(chain||mapped.length)throw Error('POSTGRES_RISK_CONTEXT_CONTRADICTION');
  return {status:'not-applicable',mapped,chain:false,plan:[]};
 }
 const plan=postgresPlan({mapped,chain,rootAudit:environment.MIGRATION_SENSITIVE==='true',chainProfile});
 if(!plan.length)throw Error('POSTGRES_EMPTY_PLAN_REJECTED');
 return {status:'required',mapped,chain,plan};
}
export function executionFingerprint(context,plan) {
 return createHash('sha256').update(JSON.stringify({context,plan,configs:[...new Set(plan.map(s=>s.config))].sort().map(path=>[path,readFileSync(path,'utf8')]),runtime:readFileSync('scripts/test-execution-config.mjs','utf8'),executor:readFileSync('scripts/owned-command.mjs','utf8'),contract:readFileSync('scripts/test-resource-contract.mjs','utf8')})).digest('hex');
}
export function assertSuiteResults(report,files) {
 if(!Array.isArray(files)||files.length===0)throw Error('POSTGRES_EMPTY_PLAN_REJECTED');
 if(report.success!==true||report.numFailedTests||report.numFailedTestSuites)throw Error('POSTGRES_EXECUTION_FAILED');
 for(const file of files){
  const matches=report.testResults.filter(r=>r.name.endsWith('/'+file));
  if(matches.length!==1||matches[0].status!=='passed'||!matches[0].assertionResults.some(r=>r.status==='passed'))throw Error('Mapped PostgreSQL suite executed no passing tests: '+file);
 }
 if(report.testResults.length!==files.length)throw Error('POSTGRES_UNPLANNED_SUITE');
}
export function assertExecutionReceipt(receipt,context,plan) {
 if(receipt.version!==1||receipt.status!=='passed'||receipt.cleanup!=='passed'||receipt.fingerprint!==executionFingerprint(context,plan)||JSON.stringify(receipt.context)!==JSON.stringify(context)||JSON.stringify(receipt.plan)!==JSON.stringify(plan))throw Error('POSTGRES_RECEIPT_CONTEXT_MISMATCH');
 assertSuiteResults(receipt.results,plan.map(s=>s.path));return receipt;
}
