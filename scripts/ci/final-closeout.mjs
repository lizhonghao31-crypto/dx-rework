import {createHash} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {REPOSITORY,REVIEW_BOT} from './pr-gate-protocol.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const detail=value=>typeof value==='string'&&value.trim().length>=20&&value.length<=4000;
async function bytes(path,max=32*1024*1024){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw Error('regular bounded report required');return readFile(path);}
function logTotals(body){
 const clean=body.replace(new RegExp(String.fromCharCode(27)+'\\[[0-?]*[ -/]*[@-~]','g'),'');
 if(/^# pass \d+$/m.test(clean))return closeoutReport(clean,'node-tap');
 if(clean.trimStart().startsWith('{')){
  // A command may print complete JSON metadata lines before Vitest's text
  // summaries. Only a whole JSON document is a JSON test report. Never turn
  // a failed or truncated report into passing evidence via a later summary.
  let document;
  try{document=JSON.parse(clean);}catch{
   let first;try{first=JSON.parse(clean.trimStart().split('\n',1)[0]);}catch{throw Error('malformed JSON command log');}
   if(!first||Array.isArray(first)||typeof first!=='object'||['testResults','numPassedTests','numFailedTests','numPendingTests'].some(key=>Object.hasOwn(first,key)))throw Error('malformed JSON test report');
  }
  if(document!==undefined)return closeoutReport(clean,'vitest-json');
 }
 const summaries=[...clean.matchAll(/^\s*Tests\s+([^\n]+)$/gm)].map(m=>m[1]);
 if(!summaries.length||/^\s*Test Files\s+[^\n]*\d+ failed/m.test(clean))throw Error('actual command log has no successful test result');
 const total=word=>summaries.reduce((sum,line)=>sum+Number(line.match(new RegExp('(\\d+) '+word))?.[1]??0),0);
 const result={passed:total('passed'),failed:total('failed'),skipped:total('skipped')+total('todo')};if(!result.passed||result.failed)throw Error('actual command log failed or ran no tests');return result;
}
export function closeoutReport(body,format){
 if(format==='vitest-json'){
  const r=JSON.parse(body);if(r.success!==true||!Array.isArray(r.testResults))throw Error('Vitest did not succeed');
  const assertions=r.testResults.flatMap(file=>file.assertionResults??[]);
  if(assertions.some(a=>!['passed','pending','skipped','todo','disabled'].includes(a.status)))throw Error('failed/unreadable assertion');
  const names=assertions.filter(a=>a.status==='passed').map(a=>a.fullName);
  if(!names.length||names.some(name=>typeof name!=='string'||!name.trim())||r.numFailedTests!==0||r.numPassedTests!==names.length)throw Error('empty/inconsistent Vitest report');
  return {passed:names.length,failed:0,skipped:r.numPendingTests??0,names};
 }
 if(format==='node-tap'){
  const passed=Number(body.match(/^# pass (\d+)$/m)?.[1]),failed=Number(body.match(/^# fail (\d+)$/m)?.[1]);
  if(!Number.isSafeInteger(passed)||passed<1||failed!==0||/^\s*not ok\b/m.test(body))throw Error('empty/failed TAP report');
  const names=[...body.matchAll(/^\s*ok \d+ - (.+?)(?: # (?:SKIP|TODO).*)?$/gm)].filter(m=>!m[0].includes(' # SKIP')&&!m[0].includes(' # TODO')).map(m=>m[1]);
  if(!names.length)throw Error('TAP has no real passed cases');
  return {passed,failed,skipped:Number(body.match(/^# skipped (\d+)$/m)?.[1]??0),names};
 }
 if(format==='command-record'){
  const r=JSON.parse(body);if(r.exitCode!==0||r.status!=='passed'||typeof r.command!=='string'||!r.command.trim())throw Error('command did not succeed');
  return {command:r.command,names:[]};
 }
 throw Error('unsupported report format');
}

/** Operator-path guard, not proof of author identity or all unknown defects.
 * The already verified exact-head light validates construction-evidence against
 * source. Read its pinned bytes again; do not trust a local replacement record.
 */
export async function verifyFinalCloseout(api,plan,path,review){
 const errors=[],reports=new Map();let pack,evidence,packageBytes;
 try{if(!path)throw Error('missing --closeout package');packageBytes=await bytes(path,1024*1024);pack=JSON.parse(packageBytes);}catch(e){errors.push('package: '+e.message);}
 if(pack){
  if(pack.version!==1)errors.push('package version');
  for(const field of ['repository','pr','head','base','baseRef','kind'])if(pack[field]!==plan[field])errors.push('stale/mismatched '+field);
  if(!detail(pack.decision))errors.push('bounded point-check decision required');
  try{
   const original=await api.request(`/repos/${REPOSITORY}/contents/docs/engineering/construction-evidence.json?ref=${plan.head}`);
   if(original.encoding!=='base64'||typeof original.content!=='string')throw Error('pinned construction record unreadable');
   const content=Buffer.from(original.content,'base64');if(content.length>2*1024*1024||sha(content)!==pack.constructionEvidenceSha256)throw Error('pinned construction evidence digest differs');
   const candidate=JSON.parse(content);if(candidate.version!==1||candidate.base!==plan.base||candidate.sourceFingerprint!==pack.sourceFingerprint||!/^[0-9a-f]{64}$/.test(pack.sourceFingerprint??''))throw Error('construction source/base differs');
   if(!Array.isArray(candidate.rules)||!candidate.rules.length||!Array.isArray(candidate.checks))throw Error('construction checks missing');evidence=candidate;
  }catch(e){errors.push('construction: '+e.message);}
 }
 if(pack&&evidence){
  if(pack.review?.required!==review.required)errors.push('review decision differs');
  if(review.required){if(pack.review?.reviewedHead!==review.commit_sha)errors.push('reviewed head differs');}
  else if(plan.kind!=='quick'||!detail(review.reason)||!detail(review.authorization)||pack.review?.reason!==review.reason||pack.review?.authorization!==review.authorization)errors.push('no-review reason/authority missing, unbounded or differs');
  const definitions=new Map(evidence.checks.map(c=>[c.id,c]));
  if(!Array.isArray(pack.reports)||!pack.reports.length)errors.push('actual reports required');
  for(const report of Array.isArray(pack.reports)?pack.reports:[]){try{
   if(reports.has(report.checkId))throw Error('duplicate check report');const check=definitions.get(report.checkId);
   if(!check||check.status!=='passed'||check.exitCode!==0)throw Error('no passing construction check');
   const log=await bytes(check.log);if(sha(log)!==check.logSha256)throw Error('actual command log digest differs');
   const files=report.files??[report];if(!Array.isArray(files)||!files.length||files.length>20)throw Error('bounded actual result reports required');
   const parsedFiles=[],seen=new Set();for(const file of files){const content=await bytes(file.path),digest=sha(content);if(digest!==file.sha256||seen.has(digest))throw Error('actual result report digest differs or is duplicated');seen.add(digest);parsedFiles.push(closeoutReport(content.toString('utf8'),file.format));}
   const parsed=check.kind==='command'?parsedFiles[0]:{passed:parsedFiles.reduce((n,r)=>n+r.passed,0),failed:parsedFiles.reduce((n,r)=>n+r.failed,0),skipped:parsedFiles.reduce((n,r)=>n+r.skipped,0),names:parsedFiles.flatMap(r=>r.names)};
   if(check.kind==='command'){
    if(files.length!==1||files[0].format!=='command-record'||plan.kind!=='quick'||!detail(evidence.automaticTestsNotApplicable)||parsed.command!==check.command)throw Error('command-only proof is not an authorized static Quick alternative');
   }else{
    const actual=logTotals(log.toString('utf8'));
    if(files.some(f=>f.format==='command-record')||['passed','failed','skipped'].some(key=>parsed[key]!==check[key]||actual[key]!==check[key]))throw Error('actual test/log counts differ from construction record');
    if(actual.names){
     if(JSON.stringify([...actual.names].sort())!==JSON.stringify([...parsed.names].sort()))throw Error('test case identities differ from original command log');
    }else{
     // Human summaries omit case names: only structured report bytes recorded
     // with this exact committed command can supply them, never a later file.
     const pinned=check.resultReports;
     if(!Array.isArray(pinned)||!pinned.length||pinned.some(f=>!['node-tap','vitest-json'].includes(f.format)||!/^[0-9a-f]{64}$/.test(f.sha256??''))||JSON.stringify(pinned.map(f=>f.format+':'+f.sha256).sort())!==JSON.stringify(files.map(f=>f.format+':'+f.sha256).sort()))throw Error('structured report digest is not bound to the pinned command resultReports');
    }
   }
   reports.set(report.checkId,{...parsed,check});
  }catch(e){errors.push('report '+String(report.checkId)+': '+e.message);}}
  const items=[...(Array.isArray(pack.findings)?pack.findings:[]),...(Array.isArray(pack.scopeChecks)?pack.scopeChecks:[])];
  if(!Array.isArray(pack.findings)||!Array.isArray(pack.scopeChecks)||!pack.scopeChecks.length)errors.push('fixed findings and bounded scope checks required');
  const ids=new Set(),covered=new Set();
  for(const item of items){
   if(typeof item.id!=='string'||!item.id||ids.has(item.id))errors.push('missing/duplicate closeout item id');ids.add(item.id);
   if(item.status!=='closed'||!detail(item.conclusion)||typeof item.source!=='string'||!item.source.trim())errors.push('unclosed/unexplained '+String(item.id));
   const proof=reports.get(item.checkId);
   if(!proof||proof.check.kind!=='command'&&(!Array.isArray(item.testNames)||!item.testNames.length||item.testNames.some(name=>!proof.names.includes(name))))errors.push('unproven real case '+String(item.id));
   if(Array.isArray(pack.scopeChecks)&&pack.scopeChecks.includes(item)){
    const rule=evidence.rules[item.ruleIndex];if(!Number.isSafeInteger(item.ruleIndex)||!rule||!rule.checks?.includes(item.checkId))errors.push('scope rule/check differs '+String(item.id));else covered.add(item.ruleIndex);
   }
  }
  for(let i=0;i<evidence.rules.length;i++)if(!covered.has(i))errors.push('unclosed construction rule '+i);
  try{
   const inline=await api.pages(`/repos/${REPOSITORY}/pulls/${plan.pr}/comments`);
   const known=inline.filter(c=>c.user?.login===REVIEW_BOT&&!c.in_reply_to_id&&(/codex-code-review-finding:v1|\bP[0-3]\b/.test(c.body??'')));
   for(const finding of known)if(!pack.findings.some(f=>f.reviewCommentId===finding.id))errors.push('known Review finding omitted '+finding.id);
   if(!known.length&&!pack.findings.length&&!detail(pack.noFindingsReason))errors.push('explicit bounded no-findings conclusion required');
  }catch(e){errors.push('known findings unreadable: '+e.message);}
 }
 if(packageBytes)try{if(sha(await bytes(path,1024*1024))!==sha(packageBytes))errors.push('closeout package changed during verification');}catch(e){errors.push('closeout package changed/unreadable during verification: '+e.message);}
 if(errors.length)throw Error('FINAL_CLOSEOUT_REJECTED:\n'+errors.map(e=>'- '+e).join('\n'));
 return {sourceFingerprint:pack.sourceFingerprint,constructionEvidenceSha256:pack.constructionEvidenceSha256,packageSha256:sha(packageBytes),findings:pack.findings.map(f=>f.id),scopeChecks:pack.scopeChecks.map(f=>f.id),boundary:'Actual report/digest/tuple consistency; not authenticated parent identity, complete unknown-defect discovery, or server branch protection.'};
}
