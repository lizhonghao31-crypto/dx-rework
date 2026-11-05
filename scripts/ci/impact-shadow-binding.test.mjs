import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {SHADOW_POLICY_PATH,shadowInputsHash,stampShadowPolicy,verifyShadowBinding} from './impact-shadow-binding.mjs';
import {policyRulesHash,parseShadowChanges,proposeShadow} from './impact-shadow.mjs';

const rootFile='apps/api/src/pilot.ts',direct='tests/unit/direct.test.ts',other='tests/unit/other.test.ts';
// Minimal real Git fixtures isolate binding mechanics; no business test execution is claimed.
function repository(){
 const root=mkdtempSync(join(tmpdir(),'dx-shadow-binding-'));
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const put=(file,body)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),body);};
 const commit=message=>{git('add','.');git('commit','-qm',message);return git('rev-parse','HEAD');};
 git('init','-q');git('config','user.name','TEST fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
 for(const [file,body]of [[rootFile,'export const value=1;\n'],['apps/api/src/dependency.ts','export const value=1;\n'],[direct,'// independent direct obligation\n'],[other,'// unrelated declaration\n']])put(file,body);
 const anchor=commit('TEST reviewed initial source');git('branch','TEST-trunk');git('checkout','-qb','TEST-policy');
 const expectedCases=[{file:direct,ancestors:[],title:'original case',rowKey:null,parameterHash:null}];
 const policy={version:1,root:rootFile,rootImports:[],pinnedSources:{},requiredEdges:[[direct,rootFile]],expectedCases,toolchain:{nodeMajor:22,vitest:'4.1.10',typescript:'5.9.3'}};
 const read=()=>JSON.parse(readFileSync(join(root,SHADOW_POLICY_PATH),'utf8'));
 const stamp=at=>{const before=read(),after=stampShadowPolicy(root,before,at);assert.equal(policyRulesHash(before),policyRulesHash(after));put(SHADOW_POLICY_PATH,JSON.stringify(after,null,2)+'\n');return after;};
 put(SHADOW_POLICY_PATH,JSON.stringify(policy));git('add','.');stamp(anchor);commit('TEST deploy policy');git('checkout','-q','TEST-trunk');git('merge','--no-ff','-qm','TEST merge policy','TEST-policy');
 const deployed=git('rev-parse','HEAD');
 const next=()=>{const base=git('rev-parse','HEAD');put(rootFile,'export const value=2;\n');const head=commit('TEST future root-only source change');return {base,head};};
 const evaluate=identity=>{
  const p=read(),binding=verifyShadowBinding(root,identity,p),changes=parseShadowChanges(execFileSync('git',['-C',root,'diff','--name-status','--no-renames','-z',identity.base,identity.head],{encoding:'utf8'})),inputs={nonDatabase:[direct,other],postgres:{status:'required',plan:[{path:'tests/integration/retained-postgres.test.ts'}]}};
  return {binding,result:proposeShadow({identity,inputs,changes,policy:p,binding,graph:{rootImports:[],edges:[[direct,rootFile]],conservativeConsumers:[],unsupported:[]},declarations:p.expectedCases,sourceHashes:{},toolchain:{node:'22.22.2',vitest:'4.1.10',typescript:'5.9.3'}})};
 };
 return {root,git,put,commit,anchor,deployed,read,stamp,next,evaluate,dispose:()=>rmSync(root,{recursive:true,force:true})};
}
function retained(r){assert.equal(r.result.decision,'fallback');assert.deepEqual(r.result.candidate,r.result.actualExecution);assert.equal(r.result.selectionApproved,false);}
test('real deployment merge and later policy-refresh merge both admit a natural root-only future PR',()=>{
 const f=repository();try{
  f.git('checkout','-qb','TEST-future-one');let pair=f.next(),r=f.evaluate(pair);assert.equal(r.binding.status,'matched');assert.equal(r.result.decision,'candidate');assert.deepEqual(r.result.candidate.postgres,r.result.actualExecution.postgres);assert.notEqual(pair.base,f.anchor);
  f.git('checkout','-qb','TEST-refresh',f.deployed);f.git('add','.');f.stamp(f.deployed);const refreshed=f.read();assert.deepEqual(f.stamp(f.deployed),refreshed);f.commit('TEST reviewed binding metadata refresh');
  f.git('checkout','-q','TEST-trunk');f.git('merge','--no-ff','-qm','TEST merge refreshed policy','TEST-refresh');const merged=f.git('rev-parse','HEAD');assert.notEqual(merged,f.deployed);assert.equal(f.read().binding.anchor,f.deployed);
  f.git('checkout','-qb','TEST-future-two');pair=f.next();r=f.evaluate(pair);assert.equal(r.binding.status,'matched');assert.equal(r.result.decision,'candidate');assert.equal(r.result.executionChanged,false);
 }finally{f.dispose();}
});
for(const file of ['apps/api/src/dependency.ts','packages/contracts/src/shared.ts','tests/unit/new-consumer.test.ts','vitest.config.ts','docs/requirements/business.md'])test('base-side drift remains rejected for '+file,()=>{
 const f=repository();try{f.put(file,'// TEST unreviewed shared input\n');f.commit('TEST advance base with shared input');const r=f.evaluate(f.next());assert.equal(r.binding.reason,'reviewed-input-drift');retained(r);}finally{f.dispose();}
});
test('policy body participates in the fingerprint even though its raw self-binding file is excluded',()=>{
 const f=repository();try{const p=f.read();p.requiredEdges=[];f.put(SHADOW_POLICY_PATH,JSON.stringify(p));f.commit('TEST unreviewed policy body');const r=f.evaluate(f.next());assert.equal(r.binding.reason,'reviewed-input-drift');retained(r);}finally{f.dispose();}
});
test('semantic key order and construction metadata do not create another merge-SHA fixed point',()=>{
 const f=repository();try{const p=f.read();f.put(SHADOW_POLICY_PATH,JSON.stringify(Object.fromEntries(Object.entries(p).reverse())));f.put('docs/engineering/construction-evidence.json','{"TEST":"metadata only"}\n');f.commit('TEST metadata update');const r=f.evaluate(f.next());assert.equal(r.binding.status,'matched');assert.equal(r.result.decision,'candidate');}finally{f.dispose();}
});
test('identical source on an unrelated history cannot replace the reviewed ancestor',()=>{
 const f=repository();try{f.git('checkout','--orphan','TEST-unrelated');f.git('rm','-r','--cached','.');f.commit('TEST unrelated source copy');const r=f.evaluate(f.next());assert.equal(r.binding.reason,'unreviewed-ancestry');retained(r);}finally{f.dispose();}
});
test('tracked, staged and untracked worktree drift cannot masquerade as the bound head',()=>{
 const f=repository();try{const pair=f.next();f.put('apps/api/src/dependency.ts','// dirty\n');let r=f.evaluate(pair);assert.equal(r.binding.reason,'uncommitted-inputs');retained(r);f.git('add','.');r=f.evaluate(pair);assert.equal(r.binding.reason,'uncommitted-inputs');retained(r);f.git('reset','--hard','-q',pair.head);f.put('untracked-source.ts','// untracked\n');r=f.evaluate(pair);assert.equal(r.binding.reason,'uncommitted-inputs');retained(r);}finally{f.dispose();}
});
for(const operation of ['delete','rename'])test('real Git '+operation+' diff retains the complete original plan',()=>{
 const f=repository();try{const base=f.deployed;if(operation==='delete')rmSync(join(f.root,rootFile));else renameSync(join(f.root,rootFile),join(f.root,'apps/api/src/renamed.ts'));const head=f.commit('TEST '+operation);retained(f.evaluate({base,head}));}finally{f.dispose();}
});
test('generator preserves reviewed rules, rejects unstaged/untracked inputs, and produces a stable nonrecursive digest',()=>{
 const f=repository();try{const p=f.read();assert.deepEqual(f.stamp(f.anchor),p);assert.equal(shadowInputsHash(f.root,p,':index'),p.binding.inputsHash);f.put('apps/api/src/dependency.ts','// unstaged dependency\n');assert.throws(()=>f.stamp(f.anchor),/stage reviewed inputs/);f.git('add','.');const changed=f.stamp(f.anchor);assert.notEqual(changed.binding.inputsHash,p.binding.inputsHash);assert.equal(policyRulesHash(changed),policyRulesHash(p));f.put('new-untracked.ts','// unknown\n');assert.throws(()=>f.stamp(f.anchor),/stage reviewed inputs/);}finally{f.dispose();}
});
test('symlink inputs, malformed identities and missing history fail closed',()=>{
 const f=repository();try{const pair=f.next();assert.equal(verifyShadowBinding(f.root,{...pair,head:'not-a-sha'},f.read()).reason,'invalid-reviewed-binding');const p=f.read();p.binding.anchor='f'.repeat(40);assert.equal(verifyShadowBinding(f.root,pair,p).reason,'unreviewed-ancestry');symlinkSync('pilot.ts',join(f.root,'apps/api/src/link.ts'));f.commit('TEST symlink');assert.throws(()=>shadowInputsHash(f.root,f.read()),/unsupported tracked input/);}finally{f.dispose();}
});
