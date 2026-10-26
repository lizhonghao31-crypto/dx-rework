import {PoCustomerDateService} from '../../apps/api/src/production-platform/po-customer-date-service.js';
import {AuthService} from '../../apps/api/src/auth/service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {AcceptanceDingTalkProvider} from '../../apps/api/src/auth/acceptance-provider.js';
import {mintAcceptanceControlCode} from '../../apps/api/src/auth/acceptance-control.js';
import {businessActor} from '../../apps/api/src/access/business-authority.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import type {Pool} from 'pg';
import {expect,vi} from 'vitest';
import {SlaPlanRepository} from '../../apps/api/src/production-platform/sla-plan-repository.js';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {BudgetDocumentSchema} from '@dx-rework/contracts/digital-budget';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import {DigitalPoDateRepository} from '../../apps/api/src/production-platform/po-date-repository.js';
import {SourcingService} from '../../apps/api/src/sourcing/sourcing-service.js';
import {SourcingContractService} from '../../apps/api/src/sourcing/sourcing-contract-service.js';
import {AccessMasterDataService} from '../../apps/api/src/access/service.js';
import {AttachmentService} from '../../apps/api/src/tools/attachments.js';
import {FakeObjectStorage} from '../../apps/api/src/tools/storage.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {businessNow,ContextBusinessClock} from '../../apps/api/src/acceptance-clock/business-time.js';
import type {AcceptanceClockRuntime} from '../../apps/api/src/acceptance-clock/runtime.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';

const fixturePeople=new WeakMap<Pool,Record<string,TrustedActorContext>>();
export async function exerciseAcceptanceSourcingApproval(db:Pool,runtime:AcceptanceClockRuntime,root:TrustedActorContext,corp:string,mode:'scene-change'|'scene-same'|'scene-rollback'|'ordinary'){
 const suffix=randomUUID().slice(0,8),people=fixturePeople.get(db)??{};
 if(!fixturePeople.has(db)){
 for(const [name,role,capability] of [['merch','order_merchandiser','sourcing:inquiry:create'],['ie','ie_reviewer','sourcing:price:quote'],['manager','production_management','sourcing:decision:record'],['owner','owner_group','sourcing:owner:approve'],['finance','factory_payables','sourcing:finance:reconcile']]){
  const id=randomUUID();await db.query('INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)',[id,`TEST ${name} ${suffix}`]);
  await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,corp,`uat-${name}-${suffix}`,`uat-union-${name}-${suffix}`]);
  await db.query('ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation');
  try{await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST isolated approval fixture')",[randomUUID(),id,role,root.actorId]);}finally{await db.query('ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation');}
  people[name!]={actorId:id,actorRoles:[role!],authorizationCapability:capability!,authorizationCapabilities:[capability!,'sourcing:view','digital_production:view','pattern_room:orders:create'],requestId:randomUUID()};
 }
 fixturePeople.set(db,people);
 }
 const auth=new AuthService(new AcceptanceDingTalkProvider(db,corp,runtime.secret),new PostgresAuthStore(db,corp,'uat-root'),corp,3600000,runtime.secret);
 const control=await auth.beginAcceptanceControl(mintAcceptanceControlCode(runtime.secret));
 const ownerAlias=(await db.query('SELECT provider_user_id FROM identity_mappings WHERE user_id=$1',[people.owner!.actorId])).rows[0].provider_user_id.slice(4);
 const login=await auth.switchAcceptanceIdentity(control,ownerAlias);
 people.owner=await businessActor(new RootAuthority(db,corp,'uat-root'),await auth.authenticate(login.token),randomUUID(),'sourcing:owner:approve');
 expect(people.owner.actorRoles).toEqual(['owner_group']);
 const outboxBefore=Number((await db.query("SELECT count(*)::int n FROM message_outbox WHERE topic='todo.delivery'")).rows[0].n);
 const access=new AccessMasterDataService(db,corp),factory=await access.createSupplier(root,CreateSupplierSchema.parse({supplierCode:`TEST-UAT-${suffix.toUpperCase()}-FACTORY2`,supplierType:'factory',supplierName:`TEST factory2 ${suffix}`,address:'TEST address',contractEntityName:'TEST factory2',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0001',bankName:'TEST bank',changeReason:'TEST isolated approval'}));
 const crafts=await access.ensureCrafts(people.manager!,{craftNames:['TEST车缝']});
 const storage=new FakeObjectStorage(),attachments=new AttachmentService(db,storage,{prefix:'TEST',ttlSeconds:60,maxUploadBytes:1000000});
 const service=new SourcingService(db,undefined,undefined,new TodoProjectionService(new TodoService(db)),new SourcingContractService(db,attachments));
 const scene=mode==='ordinary'?null:await runtime.create(root,{name:`TEST-owner-${mode}`,requestKey:randomUUID()});
 if(scene)for(let step=0;step<5;step++)await runtime.run(scene.scenarioId,root,()=>runtime.repository.change(scene.scenarioId,root.actorId,{expectedVersion:scene.version+step,requestKey:randomUUID(),at:new Date(Date.parse('2026-11-01T09:57:06.915Z')-4+step).toISOString()}));
 const run=<T>(action:()=>Promise<T>)=>scene?runtime.run(scene.scenarioId,root,action):action();
 return run(async()=>{
  const identity=new DigitalProductionIdentityService(db,true),forms=new DigitalDevelopmentService(db,true),source=scene?{sourceId:scene.sourceIds[0]!}:await identity.createSource(root,{developmentType:'头版',designStyleNo:`TEST-owner-${suffix}`,temporaryStyleNo:null,customerCode:null},randomUUID());
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer(),imageId=randomUUID(),objectKey=`TEST-owner/${imageId}`,sha256=createHash('sha256').update(bytes).digest('hex');
  await storage.writeImmutable(objectKey,bytes,{mimeType:'image/png',sha256});
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',$3,$4,$5,'ready',CURRENT_TIMESTAMP)",[imageId,objectKey,bytes.length,sha256,root.actorId]);
  const document={...initialDevelopmentDocument(),quantity:1,sizeQuantities:[1,0],sampleSize:'M',materials:[{materialId:randomUUID(),category:'主布' as const,label:'TEST主布',name:'TEST棉',specification:'40支',quantity:'1',color:'黑',width:'',weight:'',composition:'',supplier:'',consumption:'',requiredThisRound:true,available:true,expectedDate:null}],files:[{attachmentId:imageId,kind:'款图' as const}]};
  const saved=await forms.save(root,source.sourceId,{expectedVersion:0,document},randomUUID());await forms.publish(root,source.sourceId,saved.version,randomUUID());
  const sourceRow=await forms.read(root,source.sourceId),order=await identity.createOrder(root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:sourceRow.designStyleNo,orderDate:beijingCalendarDate(businessNow()),primaryMerchandiserId:people.merch!.actorId,lines:[{color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}]}),randomUUID(),source.sourceId),id=order.productionOrderId;
  const budgetImageId=randomUUID(),budgetObjectKey=`TEST-owner-budget/${budgetImageId}`;
  await storage.writeImmutable(budgetObjectKey,bytes,{mimeType:'image/png',sha256});
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-budget.png','image/png',$3,$4,$5,'ready',CURRENT_TIMESTAMP)",[budgetImageId,budgetObjectKey,bytes.length,sha256,root.actorId]);
  const budget=new DigitalBudgetService(db,true),budgetDoc=BudgetDocumentSchema.parse({fabricType:'梭织',productCategory:'上衣',date:beijingCalendarDate(businessNow()),currency:'人民币',monthSeries:'',rows:[],freight:'0',cm:'5',salePrice:'20',outsourcingScope:'车缝',outsourcingUnitPrice:'5',imageAttachmentIds:[budgetImageId]});
  await budget.save(root,id,{expectedVersion:0,document:budgetDoc},randomUUID());await budget.save(people.merch!,id,{expectedVersion:1,document:budgetDoc},randomUUID());await budget.publish(people.merch!,id,2,randomUUID());
  const prepared=await budget.prepareSourcing(people.merch!,id,2,attachments);
  const created=await service.createCase(people.merch!,{gender:prepared.gender,styleName:prepared.styleName,deliveryDate:'2026-12-10',estimatedCutPieceSendDate:'2026-11-01',daxingUnitPrice:prepared.daxingUnitPrice,attachmentIds:prepared.images.map(i=>i.attachmentId),lineItems:prepared.lineItems.map(({lineId,styleNo,alternateStyleNo,color,quantity})=>({lineId,styleNo,alternateStyleNo,color,quantity,factoryDeliveryDate:'2026-12-10'})),digitalBudget:{productionOrderId:id,budgetVersion:prepared.budgetVersion,orderVersion:prepared.orderVersion}},randomUUID());
  const caseId=created.value.sourcingCaseId,prices=[{position:1,unitPrice:'5'}];
  await service.quoteIePrice(people.ie!,caseId,{linePrices:prices},randomUUID());await service.recordManagementDecision(people.manager!,caseId,{supplierId:factory.supplierId,craftIds:[crafts[0]!.craftId],linePrices:prices,cuttingProcess:'in_house'},randomUUID());
  if(mode==='scene-same'){
   const client=await db.connect();try{await client.query('BEGIN');const auditId=randomUUID(),lineId=prepared.lineItems[0]!.lineId;
    await client.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'digital_po_factory_dates_approved','digital_production',$4,$5)",[auditId,root.requestId,root.actorId,id,JSON.stringify({reason:'TEST existing approved factory date',dateChanges:[{lineId,date:'2026-12-10',dateKind:'factory',oldDate:null,expectedVersion:0}]})]);
    await new DigitalPoDateRepository(client,new ContextBusinessClock(db)).applyWithClient(root,id,'approved_factory_change',[{lineId,date:'2026-12-10',expectedVersion:0}],auditId);await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  const key=randomUUID();
  const snapshot=async()=> (await db.query(`SELECT
   (SELECT max(sequence) FROM sourcing_case_transitions WHERE sourcing_case_id=$1)::int seq,
   (SELECT count(*) FROM sourcing_owner_decisions WHERE sourcing_case_id=$1)::int owners,
   (SELECT count(*) FROM sourcing_approval_snapshots WHERE sourcing_case_id=$1)::int snapshots,
   (SELECT count(*) FROM digital_po_date_changes WHERE production_order_id=$2 AND date_kind='factory')::int dates,
   (SELECT count(*) FROM digital_sla_plans WHERE production_order_id=$2)::int plans,
   (SELECT count(*) FROM sourcing_approval_snapshot_lines l JOIN sourcing_approval_snapshots s USING(sourcing_approval_snapshot_id) WHERE s.sourcing_case_id=$1)::int lines,
   (SELECT count(*) FROM idempotency_records WHERE scope='sourcing.owner.approved' AND actor_key=$3 AND idempotency_key=$4)::int receipts,
   (SELECT count(*) FROM operation_events WHERE entity_id=$1::text AND action='sourcing.owner.approve')::int approval_events`,[caseId,id,people.owner!.actorId,key])).rows[0];
  const before=await snapshot();expect(before).toMatchObject({seq:3,owners:0,snapshots:0,lines:0,receipts:0,approval_events:0});
  if(mode==='scene-rollback'){
   const append=SlaPlanRepository.prototype.appendPlan;
   const fault=vi.spyOn(SlaPlanRepository.prototype,'appendPlan').mockImplementationOnce(async function(this:SlaPlanRepository,...args){await append.apply(this,args);throw new Error('TEST failure after persisted SLA date revision');});
   try{await expect(service.decideOwner(people.owner!,caseId,{decision:'approved'},key)).rejects.toThrow('TEST failure after persisted SLA date revision');}finally{fault.mockRestore();}
   expect(await snapshot()).toEqual(before);
  }
  const outcome=await service.decideOwner(people.owner!,caseId,{decision:'approved'},key);
  expect(outcome.value.status).toBe('pending_finance_reconciliation');
  const retry=await service.decideOwner(people.owner!,caseId,{decision:'approved'},key);expect(retry.value).toEqual(outcome.value);expect(retry.reused).toBe(true);
  const after=await snapshot();expect(after).toMatchObject({seq:4,owners:1,snapshots:1,dates:1,lines:1,receipts:1,approval_events:1});
  let plan=(await db.query('SELECT business_time FROM digital_sla_plans WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0].business_time;
  expect(plan.scenarioId).toBe(scene?.scenarioId??null);if(scene){expect(plan.now).toBe('2026-11-01T09:57:06.915Z');expect(plan.revision).toBe(6);}
  const frozenBefore=(await db.query('SELECT snapshot_id FROM digital_sla_plans WHERE production_order_id=$1 ORDER BY revision LIMIT 1',[id])).rows[0].snapshot_id;
  const customerDates=new PoCustomerDateService(db),currentOrder=await identity.read(people.merch!,id);
  const customer=await customerDates.read(people.merch!,id),line=customer.customerPoDates[0]!;
  const request=await customerDates.request(people.merch!,id,{orderVersion:currentOrder.version,reason:'TEST approved customer-date clock',changes:[{lineId:line.lineId,expectedVersion:line.version,date:'2027-04-01'}]},randomUUID()) as {requestId:string};
  await customerDates.decide(people.owner!,id,request.requestId,true,randomUUID());
  const latest=(await db.query('SELECT business_time,snapshot_id FROM digital_sla_plans WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0];
  expect(latest.snapshot_id).toBe(frozenBefore);plan=latest.business_time;
  expect(plan.scenarioId).toBe(scene?.scenarioId??null);if(scene){expect(plan.now).toBe('2026-11-01T09:57:06.915Z');expect(plan.revision).toBe(6);}
  expect((await customerDates.read(people.owner!,id)).customerPoDates[0]!.date).toBe('2027-04-01');
  if(scene)expect((await db.query("SELECT count(*)::int n FROM message_outbox WHERE topic='todo.delivery'")).rows[0].n).toBe(outboxBefore);

 });
}
