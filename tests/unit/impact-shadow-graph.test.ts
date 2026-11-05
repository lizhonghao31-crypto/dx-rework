import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {describe,it,expect} from 'vitest';
import {auditShadowGraph,loadShadowPolicy} from '../../scripts/ci/impact-shadow-graph.mjs';
import {getCurrentTest} from '@vitest/runner';
import {hash,policyRulesHash,proposeShadow} from '../../scripts/ci/impact-shadow.mjs';
import {classifyFullGatePaths} from '../../scripts/ci/full-gate-risk-map.mjs';
import {fullGatePostgresPlan} from '../../scripts/test-suite-plan.mjs';

const pilot='apps/api/src/pilot.ts',suite='tests/unit/pilot.test.ts';
async function fixture(testSource:string,rootSource='export const value=1;',extra:Record<string,string>={}){
 const root=mkdtempSync(join(tmpdir(),'dx-impact-graph-'));
 const files={'package.json':JSON.stringify({workspaces:['packages/contracts']}),'packages/contracts/package.json':JSON.stringify({name:'@dx-rework/contracts',exports:{'./pilot':{types:'./dist/pilot.d.ts',import:'./dist/pilot.js'}}}),'packages/contracts/src/pilot.ts':'export const dependency=1;',[pilot]:rootSource,[suite]:testSource,...extra};
 for(const [file,body]of Object.entries(files)){mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),body);}
 execFileSync('git',['init','-q',root]);
 const policy={root:pilot,pinnedSources:{},expectedCases:[{file:suite}]};
 try{return await auditShadowGraph(root,policy);}finally{rmSync(root,{recursive:true,force:true});}
}
describe('bounded impact shadow graph',()=>{
 it('resolves source aliases without built dist, unchanged transitive imports and literal source-read edges',async()=>{
  const a=await fixture("import '../../apps-does-not-exist'; import {value} from '../../helpers/consumer.js'; it('case',()=>{});","import {dependency} from '@dx-rework/contracts/pilot'; export const value=dependency;",{'tests/helpers/consumer.ts':"import {value} from '../../apps/api/src/pilot.js'; export {value};",'tests/unit/reader.test.ts':"import {readFileSync} from 'node:fs';readFileSync('apps/api/src/pilot.ts');",'tests/unit/dynamic.test.ts':"const file=process.env.FILE;import(file);"});
  expect(a.graph.edges).toContainEqual([pilot,'packages/contracts/src/pilot.ts']);
  expect(a.graph.edges).toContainEqual(['tests/helpers/consumer.ts',pilot]);
  expect(a.graph.edges).toContainEqual(['tests/unit/reader.test.ts',pilot]);
  expect(a.graph.conservativeConsumers).toContain('tests/unit/reader.test.ts');
  expect(a.graph.conservativeConsumers).toContain('tests/unit/dynamic.test.ts');
 });
 it('expands literal parameter instances with stable identities, values and ancestors',async()=>{
  const a=await fixture("describe('family',()=>{it.each([{caseId:'zero',value:0},{caseId:'negative',value:-1}])('case $caseId',()=>{});it.each(['印花','绣花'])('craft %s',()=>{});});");
  expect(a.declarations).toEqual([
   {file:suite,ancestors:['family'],title:"case 'zero'",rowKey:'zero',parameterHash:hash({caseId:'zero',value:0})},
   {file:suite,ancestors:['family'],title:"case 'negative'",rowKey:'negative',parameterHash:hash({caseId:'negative',value:-1})},
   {file:suite,ancestors:['family'],title:'craft 印花',rowKey:'印花',parameterHash:hash('印花')},
   {file:suite,ancestors:['family'],title:'craft 绣花',rowKey:'绣花',parameterHash:hash('绣花')},
  ]);
 });
 it.each([{caseId:'simple-id',value:1},{caseId:'other-id',value:2}])('matches the native Vitest object identity $caseId',async row=>{
  const actualTitle=getCurrentTest()?.name;
  const a=await fixture("it.each([{caseId:'simple-id',value:1},{caseId:'other-id',value:2}])('matches the native Vitest object identity $caseId',()=>{});");
  expect(a.declarations.find(c=>c.rowKey===row.caseId)?.title).toBe(actualTitle);
 });
 it.each([
  "it.each([])('case %s',()=>{});",
  "const rows=['a'];it.each(rows)('case %s',()=>{});",
  "it.each([{value:1}])('case $value',()=>{});",
  "it.each([{caseId:'one',value:1}])('case $value',()=>{});",
  "it.each([{caseId:\"quote'id\",value:1}])('case $caseId',()=>{});",
  "describe.each(['a'])('family %s',()=>{it('case',()=>{});});",
 ])('rejects unsupported or ambiguous declaration %s',async source=>{await expect(fixture(source)).rejects.toThrow();});
 it.each(["export const value=process.env.X;","export const value=await import('./dynamic.js');","export const value=globalThis.value;"])('does not propose a pure entry with runtime globals or loaders %s',async source=>{const a=await fixture("it('case',()=>{});",source);expect(a.graph.unsupported.length).toBeGreaterThan(0);});
 it('matches the separately source-reviewed real 18-case catalog and rejects a deleted consumer edge',async()=>{
  const policy=loadShadowPolicy(),audit=await auditShadowGraph(process.cwd(),policy);
  const identity={head:'a'.repeat(40),base:policy.binding.anchor};
  const risk=classifyFullGatePaths([policy.root]),postgres=fullGatePostgresPlan({BASE_SHA:identity.base,DB_REQUIRED:String(risk.dbRequired),BUSINESS_CHAIN_SENSITIVE:String(risk.businessChainSensitive),MIGRATION_SENSITIVE:String(risk.migrationSensitive),DEPLOYMENT_SENSITIVE:String(risk.deploymentSensitive),MAPPED_POSTGRES_TESTS:risk.mappedPostgresTests.join(',')});
  // Graph-only assertions use a synthetic binding; real Git proof lives in binding.test.mjs.
  const binding={version:1,status:'matched',...identity,anchor:policy.binding.anchor,baseInputsHash:policy.binding.inputsHash,headInputsHash:policy.binding.inputsHash,policyRulesHash:policyRulesHash(policy)};
  const input={identity,inputs:{nonDatabase:[...new Set(policy.expectedCases.map(c=>c.file)),'tests/unit/impact-shadow-graph.test.ts'],postgres},changes:[{status:'M',path:policy.root}],policy,binding,...audit,toolchain:{node:process.versions.node,vitest:'4.1.10',typescript:'5.9.3'}};
  expect(audit.graph.unsupported).toEqual([]);expect(audit.declarations).toHaveLength(18);expect(proposeShadow(input).decision).toBe('candidate');expect(proposeShadow(input).knownPlanGaps).toEqual([]);
  const omitted={...input,inputs:{...input.inputs,postgres:{...postgres,plan:postgres.plan.filter(s=>!policy.requiredPostgresFiles.includes(s.path))}}};expect(proposeShadow(omitted).knownPlanGaps).toEqual(policy.requiredPostgresFiles);
  for(const edge of policy.requiredEdges){input.graph={...audit.graph,edges:audit.graph.edges.filter(e=>JSON.stringify(e)!==JSON.stringify(edge))};expect(proposeShadow(input).reason).toBe('missing-reviewed-consumer-edge');}
 },15_000); // Review measured 6.55s audit / 8.54s isolated test; only this repository scan gets the bounded budget.
});
