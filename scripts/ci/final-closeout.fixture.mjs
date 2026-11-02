import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const roots=[];
export const closeoutSha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function closeoutFixture(plan){
 const dir=mkdtempSync(join(tmpdir(),'TEST-final-closeout-'));roots.push(dir);
 const name='TEST direct regression is actually verified',log=join(dir,'native.log'),body=`TAP version 13\n# Subtest: ${name}\nok 1 - ${name}\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
 writeFileSync(log,body);
 const evidence={version:1,base:plan.base,sourceFingerprint:'c'.repeat(64),rules:[{rule:'TEST real changed-source invariant',checks:['unit']}],checks:[{id:'unit',kind:'tests',status:'passed',exitCode:0,passed:1,failed:0,skipped:0,command:'node --test TEST-fixture',log,logSha256:closeoutSha(body)}]};
 const pack={version:1,...plan,constructionEvidenceSha256:closeoutSha(JSON.stringify(evidence)),sourceFingerprint:evidence.sourceFingerprint,decision:'TEST independent point-check batch explicitly closed on the exact frozen candidate.',review:{required:true,reviewedHead:plan.head},findings:[],noFindingsReason:'TEST completed independent Review has no findings; concrete source scope regression remains verified.',scopeChecks:[{id:'scope-1',ruleIndex:0,status:'closed',conclusion:'TEST actual directly affected invariant and original entry were verified.',source:'TEST approved implementation scope',checkId:'unit',testNames:[name]}],reports:[{checkId:'unit',path:log,sha256:closeoutSha(body),format:'node-tap'}]};
 const path=join(dir,'closeout.json');const save=()=>writeFileSync(path,JSON.stringify(pack));save();return {dir,path,log,name,evidence,pack,save,encoded:()=>({encoding:'base64',content:Buffer.from(JSON.stringify(evidence)).toString('base64')})};
}
export function disposeCloseoutFixtures(){for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});}
