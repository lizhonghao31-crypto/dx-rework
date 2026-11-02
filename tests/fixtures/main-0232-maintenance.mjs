// A dedicated, marked loopback database only. The real controller and original
// SQL run under a restricted role; service/nginx probes are local fixture stubs.
// The canonical parent owns the public-schema receipt and its final cleanup.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {chmodSync,cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {applyMigrations} from '../../scripts/migration-lib.mjs';
import {assertTestDatabaseTarget} from '../../scripts/test-database-safety.mjs';

const VERSION='0232_pmc_readonly_role';
const CHECKSUM='31d01d06ce698735c21b2e8b9ab5f2f1da29d2ceb0838a130320e32e2bbe6547';
const TABLES=['public.business_roles','public.capability_catalog','public.role_capabilities'];
const FUNCTIONS=[
 'public.access_authorized_actor_roles(uuid,text)',
 'public.pattern_room_authorized_order_roles(uuid,text)',
 'public.pattern_room_authorized_price_roles(uuid,text)',
 'public.cutting_authorized_roles(uuid,text)',
 'public.finance_authorized_wage_roles(uuid,text)',
 'public.external_responsibility_can_view_all(uuid)',
 'public.own_factory_approval_can_view(uuid,uuid)',
 'public.supplier_onboarding_authorized_roles(uuid,text)',
];
const INSERT_GUARDS=['business_roles_no_insert','capability_catalog_no_insert','role_capabilities_no_insert'];
const PMC_CAPABILITIES=[
 'cutting:orders:view','dashboard:management:read','external_responsibility:view','own_factory:view',
 'pattern_room:catalog:read','pattern_room:misc:quote','pattern_room:orders:view','pattern_room:prices:read',
 'people:read','process_catalog:read','receiving:export','report:export','report:view','sourcing:view',
 'supplier_catalog:read','supplier_contract_data:read','supplier_profile:read','todo:view','wage:export','wage:view',
 'tools:read','supplier_onboarding:read','todo:routing_exception_read',
].sort();
const quoted=value=>'"'+value.replaceAll('"','""')+'"';
const shell=value=>"'"+value.replaceAll("'","'\\''")+"'";
const sorted=values=>[...values].sort();
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parseUrl=(value,label)=>{
 let result;try{result=new URL(value);}catch{throw Error(label+' must identify an explicit isolated PostgreSQL database');}
 assert(['postgres:','postgresql:'].includes(result.protocol),label+' must use PostgreSQL');
 assert(['127.0.0.1','localhost'].includes(result.hostname),label+' must be loopback');
 assert(result.username&&result.pathname!=='/',label+' must identify user and database');
 return result;
};

export async function runMain0232Maintenance({databaseUrl,adminDatabaseUrl,expectedPostgresMajor}) {
 const expected=Number(expectedPostgresMajor);
 assert([13,16].includes(expected),'MAIN_0232_EXPECTED_PG_MAJOR must be 13 or 16');
 const url=parseUrl(databaseUrl,'TEST_DATABASE_URL'),adminUrl=parseUrl(adminDatabaseUrl,'TEST_ADMIN_DATABASE_URL');
 assert.equal(adminUrl.hostname,url.hostname);assert.equal(adminUrl.port||'5432',url.port||'5432');assert.equal(adminUrl.pathname,url.pathname);
 const identity=await assertTestDatabaseTarget(url.toString());
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 const db=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000});
 const admin=new pg.Client({connectionString:adminUrl.toString(),connectionTimeoutMillis:5000});
 let scratch,languageState,user,adminUser;
 const checks=[];
 const rows=async(table)=> (await admin.query('SELECT to_jsonb(r) AS value FROM '+table+' r ORDER BY to_jsonb(r)::text')).rows.map(row=>row.value);
 const history=async()=> (await admin.query('SELECT version,btrim(checksum) AS checksum,applied_at::text FROM public.schema_migrations ORDER BY version')).rows;
 const snapshot=async()=>({
  history:await history(),
  roles:await rows('public.business_roles'),capabilities:await rows('public.capability_catalog'),roleCapabilities:await rows('public.role_capabilities'),
  users:await rows('public.app_users'),identities:await rows('public.identity_mappings'),assignments:await rows('public.user_role_assignments'),
  routines:(await admin.query("SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition,pg_get_userbyid(p.proowner) AS owner,p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1) ORDER BY p.oid::regprocedure::text",[FUNCTIONS.map(name=>name.split('.')[1].split('(')[0]).concat('guard_pmc_attachment_upload')])).rows,
  tables:(await admin.query("SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1) ORDER BY c.relname",[['business_roles','capability_catalog','role_capabilities','attachments']])).rows,
  triggers:(await admin.query("SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1) ORDER BY c.relname,t.tgname",[['business_roles','capability_catalog','role_capabilities','attachments']])).rows,
  schema:(await admin.query("SELECT pg_get_userbyid(nspowner) AS owner,nspacl::text AS acl FROM pg_namespace WHERE nspname='public'")).rows,
  languages:(await admin.query("SELECT lanname,pg_get_userbyid(lanowner) AS owner,lanacl::text AS acl FROM pg_language WHERE lanname IN ('sql','plpgsql') ORDER BY lanname")).rows,
 });
 const restoreLanguage=async(language,state)=>{
  await admin.query('REVOKE USAGE ON LANGUAGE '+language+' FROM PUBLIC,'+quoted(user));
  for(const grant of state)await admin.query('GRANT USAGE ON LANGUAGE '+language+' TO '+(grant.grantee==='0'?'PUBLIC':quoted(user))+(grant.is_grantable?' WITH GRANT OPTION':''));
 };
 const withMigrations=async(source,action)=>{
  const previous=[process.env.DX_REWORK_MIGRATIONS_DIR,process.env.DX_REWORK_MIGRATION_MANIFEST];
  process.env.DX_REWORK_MIGRATIONS_DIR=join(source,'apps/api/migrations');
  process.env.DX_REWORK_MIGRATION_MANIFEST=join(source,'apps/api/src/platform/migration-manifest.json');
  try{return await action();}finally{
   for(const [index,key]of ['DX_REWORK_MIGRATIONS_DIR','DX_REWORK_MIGRATION_MANIFEST'].entries()){
    if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];
   }
  }
 };
 try {
  await db.connect();await admin.connect();
  const actual=(await db.query("SELECT version() AS version,current_setting('server_version_num') AS number,current_schema() AS schema,current_user AS username")).rows[0];
  assert.equal(Math.floor(Number(actual.number)/10000),expected,'actual PostgreSQL major differs from requested coverage');
  assert.equal(actual.schema,'public');
  user=actual.username;
  const adminIdentity=(await admin.query("SELECT current_user AS username,current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_setting('server_version_num') AS number")).rows[0];
  adminUser=adminIdentity.username;assert.notEqual(adminUser,user,'ACL setup requires a separate test administrator');
  assert.equal(adminIdentity.username,decodeURIComponent(adminUrl.username));assert.equal(adminIdentity.database,identity.database);assert.equal(adminIdentity.oid,identity.databaseOid);assert.equal(adminIdentity.number,actual.number);
  assert.equal((await db.query("SELECT pg_has_role(current_user,$1,'USAGE') AS allowed",[adminUser])).rows[0].allowed,false,'restricted role must not inherit the test administrator');
  assert.equal((await db.query("SELECT to_regclass('public.schema_migrations') AS ledger")).rows[0].ledger,null,'fresh dedicated public schema required');
  assert.equal(Number((await db.query("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')")).rows[0].count),0,'dedicated public schema must be empty');
  languageState={};
  for(const language of ['sql','plpgsql'])languageState[language]=(await admin.query("SELECT a.grantee::text,a.is_grantable FROM pg_language l CROSS JOIN LATERAL aclexplode(coalesce(l.lanacl,acldefault('l',l.lanowner))) a WHERE l.lanname=$1 AND a.privilege_type='USAGE' AND a.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=$2)) ORDER BY a.grantee",[language,user])).rows;

  scratch=mkdtempSync(join(tmpdir(),'main-0232-maintenance-'));
  const oldSha='a'.repeat(40),newSha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  assert.match(newSha,/^[0-9a-f]{40}$/);assert.notEqual(newSha,oldSha);
  const prefix=join(scratch,'prefix'),candidate=join(scratch,'candidate'),tool=join(scratch,'tools',newSha),state=join(scratch,'state'),runtime=join(scratch,'runtime'),bin=join(scratch,'bin');
  const write=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,value);};
  const executable=(name,body)=>writeFileSync(join(bin,name),body,{mode:0o755});
  const manifest=JSON.parse(readFileSync(join(root,'apps/api/src/platform/migration-manifest.json'),'utf8'));
  const index=manifest.migrations.findIndex(row=>row.version===VERSION);
  assert.equal(index,231);assert.equal(manifest.migrations[index].checksum,CHECKSUM);
  assert.equal(createHash('sha256').update(readFileSync(join(root,'apps/api/migrations',VERSION+'.sql'))).digest('hex'),CHECKSUM,'original 0232 SQL must be unchanged');
  for(const [directory,migrations]of [[prefix,manifest.migrations.slice(0,index)],[candidate,manifest.migrations.slice(0,index+1)]]){
   write(join(directory,'apps/api/src/platform/migration-manifest.json'),JSON.stringify({migrations}));
   mkdirSync(join(directory,'apps/api/migrations'),{recursive:true});
   for(const row of migrations)cpSync(join(root,'apps/api/migrations',row.version+'.sql'),join(directory,'apps/api/migrations',row.version+'.sql'));
  }
  const plans=JSON.parse(readFileSync(join(root,'scripts/deploy/main-maintenance-plans.json'),'utf8')),plan=plans.find(row=>row.version===VERSION);
  assert(plan,'0232 maintenance plan is required');assert.equal(plan.checksum,CHECKSUM);
  assert.deepEqual(sorted(plan.tables),sorted(TABLES));assert.deepEqual(plan.triggerTables,['public.attachments']);
  assert.deepEqual(sorted(plan.functions),sorted(FUNCTIONS));assert.equal(plan.schema,'public');assert.deepEqual(sorted(plan.languages),['plpgsql','sql']);
  for(const name of ['deploy/check-main-maintenance-plan.mjs','migration-history-policy.mjs','migration-branches.json','migration-main-extensions.json']){
   const target=join(tool,'scripts',name);mkdirSync(dirname(target),{recursive:true});cpSync(join(root,'scripts',name),target);
  }
  symlinkSync(join(root,'node_modules'),join(tool,'node_modules'));
  const planFile=join(tool,'scripts/deploy/main-maintenance-plans.json');write(planFile,JSON.stringify(plans));
  const env={...process.env,NODE_ENV:'test',DATABASE_URL:url.toString(),DX_REWORK_MIGRATIONS_DIR:join(candidate,'apps/api/migrations'),DX_REWORK_MIGRATION_MANIFEST:join(candidate,'apps/api/src/platform/migration-manifest.json')};
  const checked=result=>{assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));return result.stdout;};
  const seeded=await withMigrations(prefix,()=>applyMigrations(url.toString()));
  assert.equal(seeded.applied.length,231);assert.equal(seeded.currentVersion,'0231_temporary_special_process_proxy_reporting');
  checked(spawnSync(process.execPath,['--import','tsx','scripts/acceptance/seed-role-users.ts'],{cwd:root,encoding:'utf8',env:{...env,DATABASE_URL:'',ACCEPTANCE_DATABASE_URL:url.toString(),ACCEPTANCE_LAB_ENABLED:'true',DINGTALK_CORP_ID:'main-0232-maintenance-test',ROOT_DINGTALK_USER_ID:'uat-root'}}));
  const before=await snapshot();
  assert(before.assignments.length>0&&before.identities.length>0,'nonempty genuine employee history is required');
  assert.equal(before.roles.some(role=>role.role_code==='pmc'),false);
  checked(spawnSync(process.execPath,[join(tool,'scripts/deploy/check-main-maintenance-plan.mjs'),candidate],{encoding:'utf8',env}));
  checks.push('restricted-role 0231 ledger admits only original 0232');

  for(const path of [state,bin,join(runtime,'locks'),join(scratch,'etc/nginx'),join(runtime,'frontend/releases',newSha)])mkdirSync(path,{recursive:true});
  chmodSync(state,0o700);
  write(join(runtime,'locks/release.lock'),'');write(join(state,'node-binary'),join(bin,'node22'));write(join(state,'nginx-config'),join(scratch,'etc/nginx/main.conf'));
  for(const name of ['active.json','previous-active.json'])write(join(state,name),JSON.stringify({sha:oldSha,port:3203}));
  for(const name of ['previous-active-nginx.conf','nginx-template.conf','maintenance.conf'])write(join(state,name),'fixture nginx');
  write(join(scratch,'etc/nginx/main.conf'),'fixture nginx');write(join(state,'candidate-sha'),newSha);write(join(state,'candidate-port'),'3203');
  write(join(state,'served-sha'),oldSha);write(join(state,'calls.jsonl'),'');write(join(state,'migration-results.jsonl'),'');
  const worker=join(scratch,'worker.mjs');
  write(worker,[
   "import {basename} from 'node:path';import {appendFileSync,existsSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';",
   'import {applyMigrations} from '+JSON.stringify(join(root,'scripts/migration-lib.mjs'))+';',
   'const [script,...args]=process.argv.slice(2),name=basename(script),state='+JSON.stringify(state)+';',
   "appendFileSync(state+'/calls.jsonl',JSON.stringify({name,args})+'\\n');",
   'const check=(source)=>{const p=spawnSync(process.execPath,['+JSON.stringify(join(tool,'scripts/deploy/check-main-maintenance-plan.mjs'))+",source],{env:process.env,encoding:'utf8'});process.stdout.write(p.stdout);process.stderr.write(p.stderr);if(p.status!==0)process.exit(p.status??1);};",
   "if(name==='prepare-online-candidate.sh'){check(args[1]==='recovery'?"+JSON.stringify(prefix)+':'+JSON.stringify(candidate)+");writeFileSync(args[0]+'/CANDIDATE_SHA',args[1]==='recovery'?args[2]:"+JSON.stringify(newSha)+');}',
   "if(name==='apply-main-maintenance.sh'){if(args[0]==='apply'){check("+JSON.stringify(candidate)+");try{const result=await applyMigrations(process.env.DATABASE_URL);appendFileSync(state+'/migration-results.jsonl',JSON.stringify(result)+'\\n');}catch(error){writeFileSync(state+'/migration-error.json',JSON.stringify({code:error.code,message:error.message}));process.stderr.write(String(error.code)+': '+error.message+'\\n');process.exit(1);}}",
   "else{const p=spawnSync(process.execPath,["+JSON.stringify(join(root,'scripts/deploy/database-state.mjs'))+",'verify-current',args[1]==="+JSON.stringify(oldSha)+'?'+JSON.stringify(join(prefix,'apps/api/src/platform/migration-manifest.json'))+':'+JSON.stringify(join(candidate,'apps/api/src/platform/migration-manifest.json'))+"],{env:process.env,encoding:'utf8'});process.stdout.write(p.stdout);process.stderr.write(p.stderr);process.exit(p.status??1);}}",
   "if(name==='start-online-slot.sh'&&args[0]==='start'){if(args[1]==="+JSON.stringify(newSha)+"&&existsSync(state+'/fail-start'))process.exit(42);writeFileSync(state+'/served-sha',args[1]);}",
  ].join('\n'));
  executable('id','#!/bin/sh\necho 0\n');executable('chown','#!/bin/sh\nexit 0\n');executable('sleep','#!/bin/sh\nexit 0\n');executable('python3','#!/bin/sh\nexit 0\n');
  executable('stat','#!/bin/sh\nif [ "$2" = "%U" ]; then echo root; else exec /usr/bin/stat "$@"; fi\n');
  executable('runuser','#!'+process.execPath+"\nimport {spawnSync} from 'node:child_process';const a=process.argv.slice(2),i=a.indexOf('bash');const p=spawnSync("+JSON.stringify(process.execPath)+',['+JSON.stringify(worker)+",...a.slice(i+1)],{env:process.env,stdio:'inherit'});process.exit(p.status??1);\n");
  executable('curl','#!'+process.execPath+"\nimport {readFileSync} from 'node:fs';const sha=readFileSync("+JSON.stringify(join(state,'served-sha'))+",'utf8');console.log(process.argv.at(-1).endsWith('/version')?JSON.stringify({gitSha:sha}):'X-Dx-Release-Protocol: 2');\n");
  executable('nginx','#!/bin/sh\necho nginx >> '+shell(join(state,'traffic.log'))+'\nexit 0\n');
  executable('node','#!'+process.execPath+"\nimport {writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';const a=process.argv.slice(2);if(a[0].endsWith('/render-online-nginx.mjs')||a[0].endsWith('/render-main-maintenance.mjs'))writeFileSync(a[2],'fixture rendered nginx');else if(a[0].endsWith('/nginx-workers.mjs'))console.log('[]');else if(!a[0].endsWith('/drain-nginx-workers.mjs')){const p=spawnSync("+JSON.stringify(process.execPath)+",a,{env:process.env,stdio:'inherit'});process.exit(p.status??1);}\n");
  executable('node22','#!/bin/sh\nexec '+shell(process.execPath)+' "$@"\n');
  write(join(tool,'scripts/deploy/lib.sh'),'DX_ROOT="$DX_REWORK_ROOT"\ndie(){ echo "$*" >&2; exit 1; }; require_sha(){ [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }; assert_root_node(){ :; }; safe_log(){ echo "$*"; }\n');
  const controller=join(tool,'scripts/deploy/update-main-maintenance.sh');
  write(controller,readFileSync(join(root,'scripts/deploy/update-main-maintenance.sh'),'utf8').replaceAll('/opt/dx-rework-release-tools',join(scratch,'tools')).replaceAll('/opt/dx-rework-release-state',state).replaceAll('/opt/dx-rework',runtime).replaceAll('/etc/nginx/',join(scratch,'etc/nginx')+'/'));
  const control=(phase)=>{write(join(state,'phase'),phase);return spawnSync('bash',[controller],{encoding:'utf8',env:{...env,PATH:bin+':'+process.env.PATH,DX_REWORK_EXPECTED_MAIN_SHA:newSha}});};
  const calls=()=>readFileSync(join(state,'calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const refused=async(message)=>{
   write(join(state,'calls.jsonl'),'');
   const injected=await snapshot(),result=control('completed');
   assert.notEqual(result.status,0);assert(result.stderr.includes(message),result.stderr);
   assert.equal(digest(await snapshot()),digest(injected),'read-only admission changed the injected database snapshot');
   assert.equal(readFileSync(join(state,'phase'),'utf8').trim(),'completed');
   assert.equal(readFileSync(join(scratch,'etc/nginx/main.conf'),'utf8'),'fixture nginx');
   assert.equal(existsSync(join(state,'traffic.log')),false);
   assert(calls().every(call=>call.name==='prepare-online-candidate.sh'),'admission must precede routing, stop, backup and migration');
  };
  write(planFile,JSON.stringify(plans.filter(row=>row.version!==VERSION)));
  try{await refused('MIGRATION_PLAN_REQUIRED');}finally{write(planFile,JSON.stringify(plans));}
  checks.push('missing installed plan refuses before stop and all database changes');
  for(const table of TABLES){
   await admin.query('ALTER TABLE '+table+' OWNER TO '+quoted(adminUser));
   try{await refused('MIGRATION_PERMISSION_REQUIRED: '+table);}finally{await admin.query('ALTER TABLE '+table+' OWNER TO '+quoted(user));}
   checks.push(table+' owner refusal is read-only and precedes stop');
  }
  await admin.query('REVOKE TRIGGER ON public.attachments FROM PUBLIC,'+quoted(user));
  try{
   assert.equal((await db.query("SELECT has_table_privilege(current_user,'public.attachments','TRIGGER') AS allowed")).rows[0].allowed,false);
   await refused('table public.attachments TRIGGER');
  }finally{await admin.query('GRANT TRIGGER ON public.attachments TO '+quoted(user));}
  checks.push('attachments TRIGGER privilege refusal is read-only and precedes stop');
  for(const routine of FUNCTIONS){
   await admin.query('ALTER FUNCTION '+routine+' OWNER TO '+quoted(adminUser));
   try{await refused('function '+routine+' owner');}finally{await admin.query('ALTER FUNCTION '+routine+' OWNER TO '+quoted(user));}
   checks.push(routine+' owner refusal is read-only and precedes stop');
  }
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC,'+quoted(user));
  try{
   assert.equal((await db.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).rows[0].allowed,false);
   await refused('schema public USAGE/CREATE/current_schema');
  }finally{await admin.query('GRANT CREATE ON SCHEMA public TO '+quoted(user));}
  checks.push('schema CREATE refusal is read-only and precedes stop');
  for(const language of ['sql','plpgsql']){
   await admin.query('REVOKE USAGE ON LANGUAGE '+language+' FROM PUBLIC,'+quoted(user));
   try{
    assert.equal((await db.query("SELECT has_language_privilege(current_user,$1,'USAGE') AS allowed",[language])).rows[0].allowed,false);
    await refused('language '+language+' USAGE');
   }finally{await restoreLanguage(language,languageState[language]);}
   checks.push(language+' USAGE refusal is read-only and precedes stop');
  }

  const beforeFailure=await snapshot();
  await admin.query('CREATE FUNCTION public.guard_pmc_attachment_upload() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$');
  try{
   const injected=await snapshot(),failed=control('maintenance-migrating');
   assert.notEqual(failed.status,0);assert.equal(JSON.parse(readFileSync(join(state,'migration-error.json'),'utf8')).code,'42723');
   assert.equal(digest(await snapshot()),digest(injected),'last-function collision must roll back all 0232 changes, retaining the injection');
   assert.equal(readFileSync(join(state,'phase'),'utf8').trim(),'maintenance-reverted');
  }finally{await admin.query('DROP FUNCTION public.guard_pmc_attachment_upload()');}
  assert.equal(digest(await snapshot()),digest(beforeFailure),'removing the injected collision must restore the complete prior snapshot');
  checks.push('late duplicate-function 42723 rolls back all catalogs, eight routines, triggers and ledger; injection is included in the snapshot');

  write(join(state,'calls.jsonl'),'');write(join(state,'fail-start'),'1');
  const committed=control('maintenance-migrating');
  assert.equal(committed.status,42,committed.stderr);
  const after=await snapshot();
  assert.deepEqual(after.history.slice(0,-1),before.history);assert.equal(after.history.length,232);
  assert.equal(after.history.at(-1).version,VERSION);assert.equal(after.history.at(-1).checksum,CHECKSUM);
  for(const key of ['users','identities','assignments'])assert.deepEqual(after[key],before[key],'existing employee '+key+' must be unchanged');
  assert.deepEqual(after.roles.filter(role=>role.role_code!=='pmc'),before.roles);
  assert.deepEqual(after.roleCapabilities.filter(row=>row.role_code!=='pmc'),before.roleCapabilities);
  assert.deepEqual(after.roleCapabilities.filter(row=>row.role_code==='pmc').map(row=>row.capability).sort(),PMC_CAPABILITIES);
  assert.deepEqual(after.triggers.filter(row=>INSERT_GUARDS.includes(row.tgname)).map(row=>({name:row.tgname,enabled:row.tgenabled})).sort((a,b)=>a.name.localeCompare(b.name)),INSERT_GUARDS.map(name=>({name,enabled:'O'})).sort((a,b)=>a.name.localeCompare(b.name)));
  assert.equal(after.triggers.find(row=>row.tgname==='attachments_pmc_readonly_guard')?.tgenabled,'O');
  const results=readFileSync(join(state,'migration-results.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.deepEqual(results,[{applied:[VERSION],currentVersion:VERSION}]);
  assert.equal(readFileSync(join(state,'phase'),'utf8').trim(),'maintenance-migrated');
  assert.equal(calls().some(call=>call.name==='start-online-slot.sh'&&call.args[1]===oldSha),false,'committed migration must never restart old code');
  checks.push('exactly one original 0232 receipt; all 231 checksum/applied_at and employees unchanged; PMC capabilities and guards exact');
  checks.push('candidate start stub failure after COMMIT retains maintenance-migrated without old restart');
  rmSync(join(state,'fail-start'));write(join(state,'calls.jsonl'),'');
  checked(control('maintenance-migrated'));
  assert.deepEqual(JSON.parse(readFileSync(join(state,'active.json'),'utf8')),{sha:newSha,port:3203});
  assert.equal(readFileSync(join(state,'candidate-sha'),'utf8'),newSha);
  assert.equal(calls().some(call=>['prepare-online-candidate.sh','apply-main-maintenance.sh'].includes(call.name)),false);
  assert.equal(digest(await snapshot()),digest(after));
  const repeated=await withMigrations(candidate,()=>applyMigrations(url.toString()));
  assert.deepEqual(repeated.applied,[]);assert.equal(digest(await snapshot()),digest(after));
  checks.push('same frozen candidate resumes without fetch/reapply; repeated original migration applies zero');
  return {postgres:actual.version,serverVersionNumber:actual.number,expectedPostgresMajor:expected,sourceHead:newSha,restrictedRole:user,preservedMigrationReceipts:231,preservedEmployeeAssignments:before.assignments.length,migration:{version:VERSION,checksum:CHECKSUM,applied:1},repeatedApplied:0,controller:'actual Bash controller; local service/nginx stubs; original restricted-role SQL',checks};
 } finally {
  try{for(const language of ['sql','plpgsql'])if(languageState?.[language])await restoreLanguage(language,languageState[language]);}
  finally{await Promise.allSettled([db.end(),admin.end()]);if(scratch)rmSync(scratch,{recursive:true,force:true});}
 }
}
