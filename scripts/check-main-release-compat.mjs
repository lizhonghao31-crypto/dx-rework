import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const manifestPath='apps/api/src/platform/migration-manifest.json';
const policyPaths=['scripts/migration-history-policy.mjs','scripts/migration-branches.json','scripts/migration-main-extensions.json'];
const inventoryPath='scripts/deploy/acceptance-migration-requirements.json';
const sha256=value=>createHash('sha256').update(value).digest('hex');
const shaPattern=/^[0-9a-f]{40}$/;
const sqlPattern=/^apps\/api\/migrations\/\d{4}_[a-z0-9_]+\.sql$/;
const inventoryKeys=['tables','functions','references','insert','update','creates','execute','sequences'];
const preciseOwners={
  '0226_external_revision_preserve_handler':{tables:[],functions:['external_revision_can_seed_draft','guard_determination_insert']},
  '0227_qc_other_craft':{tables:['rework_orders','rework_process_configuration_items'],functions:['guard_rework_order_write','guard_rework_special_process','guard_rework_special_process_item']},
};
const git=(repo,args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});
const sameSet=(a,b)=>a.length===b.length&&new Set(a).size===a.length&&new Set(b).size===b.length&&a.every(x=>b.includes(x));

export function gitSnapshot(repo,sha) {
  if(!shaPattern.test(sha))throw Error('A full immutable Git SHA is required');
  return {sha,read:path=>git(repo,['show',`${sha}:${path}`]),paths:()=>git(repo,['ls-tree','-r','--name-only',sha,'--','apps/api/migrations']).trim().split('\n').filter(x=>sqlPattern.test(x))};
}
export function worktreeSnapshot(repo) {
  return {sha:git(repo,['rev-parse','HEAD']).trim(),mode:'WORKTREE_NOT_DELIVERY',read:path=>readFileSync(join(repo,path),'utf8'),paths:()=>readdirSync(join(repo,'apps/api/migrations')).map(x=>'apps/api/migrations/'+x).filter(x=>sqlPattern.test(x))};
}
export function resolveRemoteMain(repo,expected) {
  let result;
  try{result=git(repo,['ls-remote','--exit-code','origin','refs/heads/main']).trim();}catch{throw Error('Cannot resolve remote main; no compatibility approval produced');}
  const parts=result.split(/\s+/);
  if(parts.length!==2||parts[1]!=='refs/heads/main'||!shaPattern.test(parts[0]))throw Error('Remote main did not resolve to one exact commit');
  const sha=parts[0];
  if(expected&&expected!==sha)throw Error('Remote main advanced; freeze and compare the new main before delivery');
  try{git(repo,['cat-file','-e',`${sha}^{commit}`]);}catch{try{git(repo,['fetch','--no-tags','origin',sha]);}catch{throw Error('Cannot read exact remote main object; compatibility remains blocked');}}
  return sha;
}
function readCatalog(source,issues,label) {
  const rows=JSON.parse(source.read(manifestPath)).migrations;
  if(!Array.isArray(rows)||!rows.length)throw Error(`${label} manifest is empty or invalid`);
  const map=new Map();
  for(const row of rows){
    if(!/^\d{4}_[a-z0-9_]+$/.test(row.version)||!/^[0-9a-f]{64}$/.test(row.checksum)||map.has(row.version))throw Error(`${label} has an invalid/duplicate migration identity`);
    map.set(row.version,row.checksum);
  }
  const paths=source.paths();
  if(!sameSet(paths.map(x=>x.slice('apps/api/migrations/'.length,-4)),[...map.keys()]))issues.push({kind:'SQL_MANIFEST_SET_DRIFT',source:label});
  for(const path of paths){const version=path.slice('apps/api/migrations/'.length,-4);if(sha256(source.read(path))!==map.get(version))issues.push({kind:'SQL_CHECKSUM_DRIFT',source:label,version});}
  return {rows,map};
}
async function actualPolicy(source) {
  const dir=mkdtempSync(join(tmpdir(),'dx-source-policy-'));
  try{
    for(const path of policyPaths)writeFileSync(join(dir,path.split('/').at(-1)),source.read(path));
    return await import(pathToFileURL(join(dir,'migration-history-policy.mjs')).href);
  }finally{rmSync(dir,{recursive:true,force:true});}
}

export async function inspectCompatibility({main,candidate,tool=candidate,baseline}) {
  const issues=[];
  const m=readCatalog(main,issues,'main'),c=readCatalog(candidate,issues,'candidate'),t=readCatalog(tool,issues,'tool');
  if(tool.sha!==candidate.sha)issues.push({kind:'TOOL_CANDIDATE_SHA_MISMATCH'});
  if(JSON.stringify(c.rows)!==JSON.stringify(t.rows))issues.push({kind:'TOOL_CANDIDATE_MANIFEST_MISMATCH'});
  for(const row of m.rows){if(!c.map.has(row.version))issues.push({kind:'MISSING_MAIN_IDENTITY',...row});else if(c.map.get(row.version)!==row.checksum)issues.push({kind:'MAIN_CHECKSUM_DRIFT',...row,actual:c.map.get(row.version)});}
  const branches=JSON.parse(tool.read(policyPaths[1])),extensions=JSON.parse(tool.read(policyPaths[2]));
  const lane=[...branches.main,...extensions];
  const expectedMain=m.rows.filter(row=>Number(row.version.slice(0,4))>217);
  if(!sameSet(lane.map(row=>row.version),expectedMain.map(row=>row.version)))issues.push({kind:'MAIN_LANE_IDENTITY_SET_MISMATCH'});
  for(const row of lane)if(m.map.get(row.version)!==row.checksum||c.map.get(row.version)!==row.checksum)issues.push({kind:'MAIN_LANE_CHECKSUM_MISMATCH',version:row.version});
  for(const row of branches.digital)if(c.map.get(row.version)!==row.checksum)issues.push({kind:'DIGITAL_LANE_CHECKSUM_MISMATCH',version:row.version});
  const inventory=JSON.parse(tool.read(inventoryPath));
  const expectedInventory=c.rows.filter(row=>Number(row.version.slice(0,4))>217).map(row=>row.version);
  if(!sameSet(Object.keys(inventory),expectedInventory))issues.push({kind:'INVENTORY_IDENTITY_SET_MISMATCH'});
  for(const row of c.rows.filter(row=>Number(row.version.slice(0,4))>217)){
    const entry=inventory[row.version];
    if(!entry){issues.push({kind:'INVENTORY_MISSING',version:row.version});continue;}
    if(entry.checksum!==row.checksum)issues.push({kind:'INVENTORY_CHECKSUM_DRIFT',version:row.version});
    if(inventoryKeys.some(key=>!Array.isArray(entry[key])))issues.push({kind:'INVENTORY_SHAPE_INVALID',version:row.version});
    const owners=preciseOwners[row.version];
    if(owners&&(!sameSet(entry.tables??[],owners.tables)||!sameSet(entry.functions??[],owners.functions)||['references','insert','update','creates','execute','sequences'].some(key=>entry[key]?.length)))issues.push({kind:'OWNER_SCOPE_MISMATCH',version:row.version});
  }
  const policy=await actualPolicy(tool);
  for(const [name,fn] of [['candidate_sequence',()=>policy.assertMigrationSequence(c.rows)],['main_to_candidate',()=>policy.assertAppliedMigrationHistory(m.rows,c.rows)],['tool_sequence',()=>policy.assertMigrationSequence(t.rows)]]){
    try{fn();}catch(error){issues.push({kind:'POLICY_REJECTION',check:name,error:error.message});}
  }
  if(baseline){const b=readCatalog(baseline,issues,'baseline');try{policy.assertAppliedMigrationHistory(b.rows,c.rows);}catch(error){issues.push({kind:'POLICY_REJECTION',check:'existing_release_to_candidate',error:error.message});}}
  return {mainSha:main.sha,candidateSha:candidate.sha,toolSha:tool.sha,baselineSha:baseline?.sha??null,mode:candidate.mode??'IMMUTABLE_COMMIT',mainCount:m.rows.length,candidateCount:c.rows.length,toolCount:t.rows.length,commonCount:m.rows.filter(row=>c.map.get(row.version)===row.checksum).length,toolPolicySha256:sha256(policyPaths.concat(inventoryPath).map(path=>tool.read(path)).join('\n')),issues,passed:issues.length===0,limits:'Source identities, actual SQL/checksums, exact lane/inventory and actual policy checks. Runtime permissions and business semantics require isolated PostgreSQL and business regressions.'};
}

export async function runCompatibilityCheck(argv=process.argv.slice(2)) {
  const args=new Map();
  for(let i=0;i<argv.length;i++){const key=argv[i];if(key==='--worktree'){args.set(key,true);continue;}if(!['--repo','--candidate-ref','--tool-ref','--baseline-ref','--expected-main-sha','--output'].includes(key)||!argv[i+1])throw Error('Invalid compatibility checker arguments');args.set(key,argv[++i]);}
  if(args.has('--output'))writeFileSync(args.get('--output'),JSON.stringify({passed:false,status:'NOT_VERIFIED'})+'\n');
  const repo=resolve(args.get('--repo')??'.');
  const resolveCommit=ref=>{if(ref!=='HEAD'&&!shaPattern.test(ref))throw Error('Expected HEAD or a full SHA');const sha=git(repo,['rev-parse','--verify',`${ref}^{commit}`]).trim();if(!shaPattern.test(sha))throw Error('Invalid commit');return sha;};
  const mainSha=resolveRemoteMain(repo,args.get('--expected-main-sha'));
  const candidate=args.has('--worktree')?worktreeSnapshot(repo):gitSnapshot(repo,resolveCommit(args.get('--candidate-ref')??'HEAD'));
  const tool=args.has('--tool-ref')?gitSnapshot(repo,resolveCommit(args.get('--tool-ref'))):candidate;
  const baseline=args.has('--baseline-ref')?gitSnapshot(repo,resolveCommit(args.get('--baseline-ref'))):undefined;
  const report=await inspectCompatibility({main:gitSnapshot(repo,mainSha),candidate,tool,baseline});
  if(args.has('--output'))writeFileSync(args.get('--output'),JSON.stringify(report,null,2)+'\n');
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const report=await runCompatibilityCheck();process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=report.passed?0:1;}catch(error){process.stderr.write('MAIN_RELEASE_COMPAT_BLOCKED: '+error.message+'\n');process.exitCode=1;}
}
