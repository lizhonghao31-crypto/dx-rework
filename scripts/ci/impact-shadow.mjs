import {createHash} from 'node:crypto';
export const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value??null)).digest('hex');
export const caseKey=c=>JSON.stringify([c.file,c.ancestors,c.title]);
const validPath=p=>typeof p==='string'&&p.length>0&&!p.includes('\\')&&![...p].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)&&!p.startsWith('/')&&p.split('/').every(s=>s&&s!=='.'&&s!=='..');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function parseShadowChanges(raw){
 if(typeof raw!=='string'||!raw.endsWith('\0'))return null;
 const parts=raw.slice(0,-1).split('\0');if(parts.length%2)return null;
 return Array.from({length:parts.length/2},(_,i)=>({status:parts[i*2],path:parts[i*2+1]}));
}
export function proposeShadow({identity,inputs,changes,policy,graph,declarations,sourceHashes,toolchain}){
 const full=inputs?.nonDatabase??[],pg=inputs?.postgres;
 const result={version:1,mode:'shadow-only',selectionApproved:false,executionChanged:false,identity,fullInputsHash:hash(inputs),policyHash:hash(policy),graphHash:hash(graph),toolchain,actualExecution:{nonDatabase:full,postgres:pg},expectedCases:policy?.expectedCases??[],proofBoundary:'Reviewed pilot declarations only; no global E/D/R or safe-selection claim.'};
 const fallback=(reason,details=[])=>({...result,decision:'fallback',reason,details,candidate:{nonDatabase:full,postgres:pg},proposedExclusions:[]});
 if(policy?.version!==1||!validPath(policy.root)||!Array.isArray(full)||!full.length||full.some(p=>!validPath(p))||new Set(full).size!==full.length||!pg)return fallback('invalid-policy-or-full-plan');
 if(identity?.base!==policy.reviewedBase)return fallback('unreviewed-base');
 if(!Array.isArray(changes)||!changes.length||changes.some(c=>!c||c.status!=='M'||!validPath(c.path))||new Set(changes.map(c=>c.path)).size!==changes.length)return fallback('unknown-or-non-modification-diff');
 if(changes.some(c=>c.path!==policy.root))return fallback('outside-reviewed-pilot-or-shared-input');
 if(toolchain?.node?.split('.')[0]!==String(policy.toolchain?.nodeMajor)||toolchain?.vitest!==policy.toolchain?.vitest||toolchain?.typescript!==policy.toolchain?.typescript)return fallback('unsupported-toolchain');
 if(!same(graph?.rootImports,policy.rootImports)||graph?.unsupported?.length)return fallback('unknown-dependency',graph?.unsupported??[]);
 for(const [path,expected]of Object.entries(policy.pinnedSources??{}))if(sourceHashes[path]!==expected)return fallback('reviewed-input-drift',[path]);
 const edges=new Set((graph?.edges??[]).map(e=>JSON.stringify(e)));
 const missing=(policy.requiredEdges??[]).filter(e=>!edges.has(JSON.stringify(e)));if(missing.length)return fallback('missing-reviewed-consumer-edge',missing);
 const expected=policy.expectedCases??[];
 if(!expected.length||new Set(expected.map(caseKey)).size!==expected.length)return fallback('ambiguous-expected-cases');
 const order=(a,b)=>caseKey(a)<caseKey(b)?-1:caseKey(a)>caseKey(b)?1:0;
 if(!same([...expected].sort(order),[...declarations].sort(order)))return fallback('declared-case-or-parameter-drift');
 const affected=new Set([policy.root,...(graph.conservativeConsumers??[])]);let changed=true;
 while(changed){changed=false;for(const [consumer,dependency]of graph.edges)if(affected.has(dependency)&&!affected.has(consumer)){affected.add(consumer);changed=true;}}
 const selected=full.filter(p=>affected.has(p));
 if(expected.some(c=>!selected.includes(c.file)))return fallback('missing-independent-obligation');
 if(!selected.length)return fallback('empty-candidate');
 const knownPlanGaps=(policy.requiredPostgresFiles??[]).filter(file=>!pg.plan?.some(s=>s.path===file));
 return {...result,decision:'candidate',reason:'single-reviewed-entry-with-consumer-closure',knownPlanGaps,affected:[...affected].sort(),candidate:{nonDatabase:selected,postgres:pg},proposedExclusions:full.filter(p=>!selected.includes(p)).map(file=>({file,reason:'outside-pilot-static-consumer-closure; unproven proposal only'}))};
}
export function observeShadow(manifest,{identity,inputs,policy,report,testOutcome}){
 const base={version:1,mode:'shadow-only',selectionApproved:false,executionChanged:false,identity,manifestHash:hash(manifest)};
 const invalid=reason=>({...base,status:'unverified',reason});
 if(manifest?.version!==1||!same(manifest.identity,identity)||manifest.fullInputsHash!==hash(inputs))return invalid('context-or-full-plan-drift');
 if(manifest.policyHash!==hash(policy)||!same(manifest.expectedCases,policy.expectedCases))return invalid('independent-policy-differs');
 if(manifest.decision!=='candidate')return {...base,status:'fallback',reason:manifest.reason};
 if(!Array.isArray(report?.testResults))return invalid('native-report-unavailable');
 if(manifest.mode!=='shadow-only'||manifest.selectionApproved!==false||manifest.executionChanged!==false||!same(manifest.actualExecution,{nonDatabase:inputs.nonDatabase,postgres:inputs.postgres})||!same(manifest.candidate?.postgres,inputs.postgres)||!Array.isArray(manifest.candidate?.nonDatabase)||new Set(manifest.candidate.nonDatabase).size!==manifest.candidate.nonDatabase.length||manifest.candidate.nonDatabase.some(p=>!inputs.nonDatabase.includes(p))||manifest.expectedCases.some(c=>!manifest.candidate.nonDatabase.includes(c.file)))return invalid('shadow-candidate-invalid');
 const rows=report.testResults,failures=[],missedFailures=[],seenFiles=new Set(),actual=new Map(),fileTimings=[];
 for(const row of rows){
  const file=inputs.nonDatabase.find(p=>row.name?.endsWith('/'+p));if(!file||seenFiles.has(file)||!Array.isArray(row.assertionResults))return invalid('native-file-set-differs');seenFiles.add(file);
  const durationMs=Number.isFinite(row.startTime)&&Number.isFinite(row.endTime)&&row.endTime>=row.startTime?row.endTime-row.startTime:null;
  fileTimings.push({file,proposed:manifest.candidate.nonDatabase.includes(file)?'affected':'excluded',durationMs,passed:row.assertionResults.filter(c=>c.status==='passed').length,failed:row.assertionResults.filter(c=>c.status==='failed').length,skipped:row.assertionResults.filter(c=>['pending','skipped','todo','disabled'].includes(c.status)).length});
  for(const c of row.assertionResults){const key=caseKey({file,ancestors:c.ancestorTitles,title:c.title});const list=actual.get(key)??[];list.push(c);actual.set(key,list);
   if(c.status==='failed'){failures.push(key);if(!manifest.candidate.nonDatabase.includes(file))missedFailures.push(key);}
   if(!['passed','failed','pending','skipped','todo','disabled'].includes(c.status))return invalid('unknown-native-state');
  }
 }
 const gaps=[];for(const expected of manifest.expectedCases){const found=actual.get(caseKey(expected));if(found?.length!==1||found[0].status!=='passed')gaps.push(caseKey(expected));}
 const knownPlanGaps=(policy.requiredPostgresFiles??[]).filter(file=>!inputs.postgres.plan?.some(s=>s.path===file));
 const nativeFilesComplete=rows.every(r=>r.status==='passed'&&r.assertionResults.length&&r.assertionResults.every(c=>['passed','skipped','pending'].includes(c.status)))&&fileTimings.every(f=>f.passed>0||f.file==='tests/acceptance/v2-pr06-postgres.test.ts'&&f.skipped>0);
 const complete=seenFiles.size===inputs.nonDatabase.length&&testOutcome==='success'&&report.success===true&&report.numFailedTests===0&&report.numFailedTestSuites===0&&nativeFilesComplete&&!failures.length;
 return {...base,status:missedFailures.length||gaps.length||knownPlanGaps.length?'gap':complete?'observed':'unverified',fullRunComplete:complete,knownPlanGaps,missedFailures,missingOrNonPassingObligations:gaps,reviewedCases:manifest.expectedCases.length,fileTimings,timingBoundary:'Native per-file duration; overlapping files cannot be summed into a wall-clock saving.',boundary:'Non-DB observation and PG plan presence only, not PG case execution. A green Full is not evidence that future defects cannot be missed; this diagnostic never changes Gate approval.'};
}
export async function captureShadow(factory){try{return await factory();}catch(error){return{version:1,mode:'shadow-only',selectionApproved:false,executionChanged:false,decision:'unverified',status:'unverified',reason:'observer-error',detail:String(error.message).slice(0,500)};}}
