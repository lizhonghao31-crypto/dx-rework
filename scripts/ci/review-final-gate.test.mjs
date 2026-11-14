import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {finalRef, FINAL_CHECK, LIGHT_CHECK, REPOSITORY} from './pr-gate-protocol.mjs';
const ci=readFileSync('.github/workflows/ci.yml','utf8');
const full=readFileSync('.github/workflows/full-gate.yml','utf8');
const head='a'.repeat(40),base='b'.repeat(40),baseRef='release/digital-production-v1';
const job=(source,id)=>source.split(`\n  ${id}:\n`)[1]?.split(/\n {2}[a-zA-Z][\w-]*:\n/)[0];
const expression=(source,key,indent=4)=>source.match(new RegExp(`^ {${indent}}${key}: (.*)$`,'m'))?.[1];
const evaluate=(value,c)=>{
 const env={...c,always:()=>true,success:()=>true,startsWith:(s,p)=>String(s??'').toLowerCase().startsWith(p.toLowerCase()),format:(s,...a)=>s.replace(/\{(\d+)\}/g,(_,i)=>a[Number(i)])};
 if(value?.startsWith('${{ '))return runInNewContext(value.slice(4,-3),env);
 return value?.replace(/\$\{\{ (.*?) \}\}/g,(_,e)=>runInNewContext(e,env));
};
const context=(title='[FULL] change',action='opened',changes={})=>({github:{event_name:'pull_request',run_attempt:1,sha:'c'.repeat(40),ref:'refs/pull/901/merge',event:{action,changes,pull_request:{number:901,title,head:{sha:head},base:{sha:base,ref:baseRef}}}},needs:{request:{result:'skipped',outputs:{}}}});
const created=(kind='full')=>{
 const ref=finalRef({kind,head,base,baseRef,pr:901});
 return {github:{event_name:'create',sha:head,ref:`refs/heads/${ref}`,event:{ref,ref_type:'branch',pull_request:{}}},needs:{request:{result:'success',outputs:{kind,pr:'901'}}}};
};
const selected=(id,c)=>Boolean(evaluate(expression(job(ci,id),'if'),c));
const name=(id,c)=>evaluate(expression(job(ci,id),'name'),c);
for(const kind of ['FULL','QUICK'])for(const action of ['opened','synchronize','reopened'])test(`${kind} ${action}: only light checks, no expensive worker or final approval`,()=>{
 const c=context(`[${kind}] change`,action);
 assert.equal(selected('request',c),false);assert.equal(selected('validate',c),action==='opened');
 assert.equal(selected('full',c),false);assert.equal(selected('approval',c),false);
 assert.equal(name('validate',c)===LIGHT_CHECK,action==='opened');assert.notEqual(name('approval',c),FINAL_CHECK);
});
for(const changes of [{body:{from:'old'}},{title:{from:'[FULL] old'}},{title:{from:'[FULL] old'},body:{from:'old'}},{}])test(`unrelated metadata ${JSON.stringify(changes)} allocates no runner or required name`,()=>{
 const c=context('[FULL] change','edited',changes);
 for(const id of ['request','validate','full','approval'])assert.equal(selected(id,c),false,id);
 assert.notEqual(name('validate',c),LIGHT_CHECK);assert.notEqual(name('approval',c),FINAL_CHECK);
});
for(const [ref,ref_type]of [['feature/ordinary','branch'],['v1','tag']])test(`ordinary create ${ref}: no runner`,()=>{
 const c=created();Object.assign(c.github.event,{ref,ref_type});c.needs.request={result:'skipped',outputs:{}};
 for(const id of ['request','validate','full','approval'])assert.equal(selected(id,c),false,id);
 assert.notEqual(name('approval',c),FINAL_CHECK);
});
for(const kind of ['quick','full'])test(`canonical ${kind} create selects one worker and real final certification`,()=>{
 const c=created(kind);assert.equal(selected('request',c),true);
 assert.equal(selected('validate',c),kind==='quick');assert.equal(selected('full',c),kind==='full');
 assert.equal(selected('approval',c),true);assert.equal(name('approval',c),FINAL_CHECK);
 c.needs.request.result='failure';assert.equal(selected('validate',c),false);assert.equal(selected('full',c),false);
 assert.equal(selected('approval',c),true); // The certifier must fail, not become a green skipped approval.
});
for(const changes of [{base:{ref:{from:'main'}}},{title:{from:'[QUICK] old'}}])test('base or risk-mode edits run no additional Light; final binding remains exact',()=>{
 const c=context('[FULL] change','edited',changes);assert.equal(selected('validate',c),false);
 assert.equal(selected('full',c),false);assert.equal(selected('approval',c),false);
});
test('initial Light and final requests queue without cancelling either',()=>{
 const light=context(),fin=created();
 const group=c=>evaluate(expression(job(ci,'validate'),'group',6),c);
 assert.equal(`pr-gate-${light.github.event.pull_request.number}`,evaluate(expression(job(ci,'full'),'group',6),{needs:{request:{outputs:{pr:901}}}}));
 assert.equal(group(light),group(fin));
 assert.equal(evaluate(expression(job(ci,'validate'),'cancel-in-progress',6),light),'false');
 assert.equal(evaluate(expression(job(ci,'validate'),'cancel-in-progress',6),fin),'false');
 assert.match(job(ci,'full'),/cancel-in-progress: false/);
 assert.doesNotMatch(full,/^ {4}concurrency:/m);
 assert.doesNotMatch(ci,/^concurrency:/m);assert.doesNotMatch(full,/^concurrency:/m);
});
test('manual Quick cannot claim final approval',()=>{
 const c=context();c.github.event_name='workflow_dispatch';
 assert.equal(selected('validate',c),true);assert.equal(selected('approval',c),false);
 assert.equal(name('validate',c),'Manual Quick checks');
});
test('workflow wiring preserves least privilege, actual receipts, exact Head and the existing heavy worker',()=>{
 assert.match(full,/^ {2}workflow_call:/m);assert.doesNotMatch(full,/^ {2}pull_request:/m);
 for(const source of [ci,full]){assert.match(source,/permissions:\n {2}contents: read/);assert.doesNotMatch(source,/actions: write|pull-requests:|contents: write|secrets\./);assert.match(source,/ci-gate-runtime\.mjs emit/);}
 assert.match(job(ci,'approval'),/WORKER_RESULT:.*needs\.full\.result/);
 assert.match(job(ci,'approval'),/WORKER_RECEIPT:.*needs\.full\.outputs\.receipt/);
 assert.match(job(ci,'approval'),/ci-gate-runtime\.mjs certify/);
 assert.match(job(ci,'full'),/uses: \.\/\.github\/workflows\/full-gate.yml/);
 assert.match(job(ci,'full'),/head_sha: \$\{\{ needs.request.outputs.head \}\}/);
 assert.equal(REPOSITORY,'lizhonghao31-crypto/dx-rework');
});

test('only opened triggers PR Light and reruns never allocate another Light worker',()=>{
 const triggers=ci.split('  pull_request:')[1].split('  workflow_dispatch:')[0];
 assert.match(triggers,/- opened/);assert.doesNotMatch(triggers,/- synchronize|- reopened|- edited/);
 for(const attempt of [2,3]){const c=context();c.github.run_attempt=attempt;assert.equal(selected('validate',c),false);assert.notEqual(name('validate',c),LIGHT_CHECK);}
});
test('Full still executes lint, types and build when same-Head Light evidence is unavailable',()=>{
 for(const [id,command] of [['lint','npm run lint'],['types','npm run typecheck'],['build','npm run build --workspaces --if-present'],['migration_lint','npm run db:migrate:lint']])assert.ok(full.includes(`light-reuse.mjs run ${id} ${command}`));
});
