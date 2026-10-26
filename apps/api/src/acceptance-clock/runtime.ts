import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import type {BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {assertAcceptanceServerProof,type AcceptanceServerProof} from './guard.js';
import {DigitalProductionIdentityService} from '../production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../production-platform/development-service.js';
import {acceptanceBusinessContext,installAcceptanceClockReader,withAcceptanceBusinessTime,type AcceptanceBusinessContext} from './business-time.js';
import {clockRoots} from './scope.js';
import {AcceptanceClockRepository,clockConflict,type ClockRow} from './repository.js';

type DB=Pick<Pool|PoolClient,'query'>;
export class AcceptanceClockRuntime{
 readonly repository:AcceptanceClockRepository;
 constructor(readonly database:Pool,private readonly proof:AcceptanceServerProof,readonly secret:string,readonly creationEnabled:boolean){
  assertAcceptanceServerProof(database,proof);if(secret.length<32)throw new Error('Acceptance clock requires the existing control secret');
  this.repository=new AcceptanceClockRepository(database);
  installAcceptanceClockReader(database,{
   read:async scope=>{this.assertEnabled();const result=(await database.query(`SELECT s.* FROM acceptance_sla_clock_resources r JOIN acceptance_sla_clock_scenarios s USING(scenario_id) WHERE r.resource_kind=$1 AND r.resource_id=$2`,[scope.kind,scope.id])).rows[0] as ClockRow|undefined;return result?{now:result.business_now.toISOString(),scenarioId:result.scenario_id,revision:result.version}:null;},
   nativeScenario:async id=>{this.assertEnabled();const ids=[...new Set((await clockRoots(database,id)).map(r=>r.scenarioId).filter((v):v is string=>Boolean(v)))];if(ids.length>1)clockConflict('原业务关联跨测试场景，不能使用测试时间');return ids[0]??null;}
  });
 }
 assertEnabled(){assertAcceptanceServerProof(this.database,this.proof);}
 async isUat(actorId:string,db:DB=this.database){
  return Boolean((await db.query(`SELECT 1 FROM identity_mappings i JOIN app_users u ON u.id=i.user_id
   WHERE i.user_id=$1 AND u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND i.provider='dingtalk' AND i.corp_id=$2 AND i.provider_user_id LIKE 'uat-%'
   AND i.union_id LIKE 'uat-union-%' AND i.active AND i.employed`,[actorId,this.proof.corporationId])).rowCount);
 }
 async assertActor(actor:TrustedActorContext){this.assertEnabled();if(!await this.isUat(actor.actorId))throw new ApplicationError('ACCEPTANCE_ISOLATION','请在原验收控制台切换有效UAT身份',403);}
 async context(row:ClockRow):Promise<AcceptanceBusinessContext>{
  this.assertEnabled();if(row.corporation_id!==this.proof.corporationId)clockConflict('场景不属于当前验收环境');
  const roots=new Set((await this.database.query('SELECT resource_kind,resource_id FROM acceptance_sla_clock_resources WHERE scenario_id=$1',[row.scenario_id])).rows.map(r=>`${r.resource_kind}:${r.resource_id}`));
  const uatUsers=new Set((await this.database.query(`SELECT DISTINCT i.user_id FROM identity_mappings i JOIN app_users u ON u.id=i.user_id
   WHERE u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND i.provider='dingtalk' AND i.corp_id=$1 AND i.provider_user_id LIKE 'uat-%' AND i.union_id LIKE 'uat-union-%' AND i.active AND i.employed`,[this.proof.corporationId])).rows.map(r=>r.user_id as string));
  const assertScope=async(scope:BusinessTimeScope)=>{
   const key=`${scope.kind}:${scope.id}`;if(roots.has(key))return;
   if(!(await this.database.query('SELECT 1 FROM acceptance_sla_clock_resources WHERE resource_kind=$1 AND resource_id=$2 AND scenario_id=$3',[scope.kind,scope.id,row.scenario_id])).rowCount)clockConflict('测试时间不能用于其他场景或非测试订单');roots.add(key);
  };
  return {scenarioId:row.scenario_id,configurationId:row.configuration_id,time:{now:row.business_now.toISOString(),scenarioId:row.scenario_id,revision:row.version},assertScope,
   acceptsActor:async id=>uatUsers.has(id),
   registerCreated:async(db,scope,actorId,auditEventId)=>{
    if(!uatUsers.has(actorId))throw new ApplicationError('ACCEPTANCE_ISOLATION','创建测试单必须沿原UAT业务身份',403);
    const prior=(await db.query('SELECT scenario_id FROM acceptance_sla_clock_resources WHERE resource_kind=$1 AND resource_id=$2',[scope.kind,scope.id])).rows[0];
    if(prior){if(prior.scenario_id!==row.scenario_id)clockConflict('测试业务关联不能重绑');roots.add(`${scope.kind}:${scope.id}`);return;}
    await db.query('INSERT INTO acceptance_sla_clock_resources(resource_kind,resource_id,scenario_id,audit_event_id) VALUES($1,$2,$3,$4)',[scope.kind,scope.id,row.scenario_id,auditEventId]);
    roots.add(`${scope.kind}:${scope.id}`);
   }};
 }
 async run<T>(id:string,actor:TrustedActorContext,action:()=>Promise<T>):Promise<T>{
  await this.assertActor(actor);const current=acceptanceBusinessContext();
  if(current){if(current.scenarioId!==id)clockConflict('不能跨测试场景办理');return action();}
  return this.repository.withLock(id,async()=>withAcceptanceBusinessTime(await this.context(await this.repository.row(id)),action));
 }
 async withObservation<T>(id:string,action:()=>Promise<T>):Promise<T>{
  const current=acceptanceBusinessContext();if(current?.scenarioId!==id)clockConflict('测试时钟操作缺少已验证场景锁');
  return withAcceptanceBusinessTime(await this.context(await this.repository.row(id)),action);
 }
 async create(actor:TrustedActorContext,input:{name:string;requestKey:string;copyScenarioId?:string|undefined}){
  await this.assertActor(actor);
  let original:Awaited<ReturnType<DigitalDevelopmentService['read']>>|undefined;
  if(input.copyScenarioId){
   const root=(await this.database.query("SELECT resource_id FROM acceptance_sla_clock_resources WHERE scenario_id=$1 AND resource_kind='source' ORDER BY created_at,resource_id LIMIT 1",[input.copyScenarioId])).rows[0];
   if(!root)clockConflict('原测试场景没有可复制的开发输入');
   original=await this.run(input.copyScenarioId,actor,()=>new DigitalDevelopmentService(this.database,this.creationEnabled).read(actor,root.resource_id));
  }
  const row=await this.repository.create(actor.actorId,this.proof.corporationId,input);
  await this.run(row.scenario_id,actor,async()=>{
   if((await this.repository.view(row.scenario_id)).sourceIds.length)return;
   const style=`TEST-SLA-${row.scenario_id.slice(0,8)}`;
   const source=await new DigitalProductionIdentityService(this.database,this.creationEnabled).createSource(actor,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:original?.customerCode??null},row.scenario_id);
   if(original?.document){
    const document=structuredClone(original.document);document.files=[];delete document.customerOrderDraft;
    document.materials=document.materials.map(m=>({...m,materialId:randomUUID(),available:false,expectedDate:null}));
    await new DigitalDevelopmentService(this.database,this.creationEnabled).save(actor,source.sourceId,{expectedVersion:0,document},row.scenario_id);
   }
  });
  return this.repository.view(row.scenario_id);
 }
}
