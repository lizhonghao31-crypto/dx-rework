import {isDeepStrictEqual} from 'node:util';
import {assembleQuotation,quotationComplete,type AssembledQuotation} from './quotation-assembly.js';
import type {DevelopmentMaterial} from '@dx-rework/contracts/digital-development';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {z} from 'zod';
import {BudgetDocumentSchema,type BudgetDocument} from '@dx-rework/contracts/digital-budget';
import {QuotationConfirmationSchema,SaveQuotationSchema,QuotationRowInputSchema,type QuotationResource,type QuotationAssignment,type QuotationConsumptionSource,type QuotationSheet} from '@dx-rework/contracts/digital-quotation';
import {acceptanceBusinessContext,acceptanceIncludesNative,businessNow} from '../acceptance-clock/business-time.js';
import {publishedTechnicalArtifact,technicalDocumentFingerprint} from './development-technical-repository.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {isRootActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,digitalNotFound,digitalForbidden} from './access-policy.js';
import {ensureQuotationBudget} from './quotation-budget-basis.js';

type Database=Pick<Pool|PoolClient,'query'>;
type PriceSource={actorId:string;role:string;version:number;recordedAt:string;documentPriceHash?:string};
type QuoteRow=AssembledQuotation;
const conflict=(message:string,code='QUOTATION_CONFLICT'):never=>{throw new ApplicationError(code,message,409);};
const enabledRoles=['sample_designer','order_merchandiser','pattern_room_worker','ie_reviewer','embroidery_washing_merchandiser','owner_group','production_management'];
const readRoles=[...enabledRoles,'pmc'];
export class DigitalQuotationService{
 constructor(private readonly database:Pool,private readonly creationEnabled:boolean){}
 private async context(db:Database,actor:TrustedActorContext,resource:QuotationResource,readOnly=false){
  if(!await acceptanceIncludesNative(this.database,resource.id))digitalNotFound();
  await acceptanceBusinessContext()?.assertScope(resource);
  const row=(await db.query(resource.kind==='order'?'SELECT * FROM digital_production_orders WHERE production_order_id=$1':'SELECT * FROM digital_production_sources WHERE source_id=$1',[resource.id])).rows[0]??digitalNotFound();
  const order=resource.kind==='order'?row:(await db.query('SELECT * FROM digital_production_orders WHERE source_id=$1',[resource.id])).rows[0];
  const sourceId=resource.kind==='source'?resource.id:row.source_id??null,orderId=order?.production_order_id??null;
  const quote=(await db.query('SELECT * FROM digital_quotation_documents WHERE production_order_id=$1 OR ($2::uuid IS NOT NULL AND source_id=$2)',[orderId,sourceId])).rows[0] as QuoteRow|undefined;
  const roles=new Set<string>();
  if(!isRootActor(actor))for(const role of (readOnly?readRoles:enabledRoles))if(actor.actorRoles.includes(role)&&await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,role))roles.add(role);
  const sourceDesigner=sourceId?(await db.query('SELECT created_by FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0]?.created_by:row.created_by;
  const designer=roles.has('sample_designer')&&sourceDesigner===actor.actorId;
  const merch=roles.has('order_merchandiser')&&order?.primary_merchandiser_id===actor.actorId;
  const full=isRootActor(actor)||designer||merch||roles.has('owner_group')||roles.has('production_management')||roles.has('pmc');
  const ownRow=(quote?.assignments??[]).some(a=>a.technicalAssigneeId===actor.actorId&&roles.has('pattern_room_worker')||a.priceAssigneeId===actor.actorId&&roles.has(a.priceRole));
  if(!full&&!ownRow)digitalNotFound();
  return {row,designerId:sourceDesigner,orderId,sourceId,quote,roles,full,customerCode:order?.customer_code??row.customer_code??null,structure:isRootActor(actor)||designer,confirm:isRootActor(actor)||designer||merch};
 }
 async read(actor:TrustedActorContext,resource:QuotationResource,db:Database=this.database,version?:number):Promise<QuotationSheet>{
  const c=await this.context(db,actor,resource,true),q=c.quote;
  const snapshot=version===undefined?null:(await db.query('SELECT * FROM digital_quotation_versions WHERE quote_id=$1 AND version=$2',[q?.quote_id,version])).rows[0]??digitalNotFound();
  const doc=(snapshot?.document??q?.document) as BudgetDocument|undefined;
  const assignments=(snapshot?.assignments??q?.assignments??[]) as QuotationAssignment[];
  const assembly=(snapshot?.assembly??q?.assembly) as AssembledQuotation['assembly'];
  const sources=(snapshot?.consumption_sources??q?.consumption_sources??{}) as Record<string,QuotationConsumptionSource>;
  const userIds=[...new Set(assignments.flatMap(a=>[a.technicalAssigneeId,a.priceAssigneeId]).filter((v):v is string=>Boolean(v)))];
  const names=new Map<string,string>((userIds.length?(await db.query('SELECT id,display_name FROM app_users WHERE id=ANY($1::uuid[])',[userIds])).rows:[]).map(u=>[u.id,u.display_name]));
  const confirmation= snapshot?.confirmation??(q?.confirmed_version?(await db.query('SELECT confirmation FROM digital_quotation_versions WHERE quote_id=$1 AND version=$2',[q.quote_id,q.confirmed_version])).rows[0]?.confirmation:null);
  const budget=c.orderId?(await db.query('SELECT version,quote_id,quote_version,status FROM digital_budget_documents WHERE production_order_id=$1',[c.orderId])).rows[0]:null;
  const rows=(doc?.rows??[]).flatMap(row=>{
   const a=assignments.find(a=>a.rowId===row.rowId);if(!a)return [];
   // A historical assignment never grants current access after reassignment.
   const current=q?.assignments.find(x=>x.rowId===row.rowId);
   const technical=current?.technicalAssigneeId===actor.actorId&&c.roles.has('pattern_room_worker');
   const price=current?.priceAssigneeId===actor.actorId&&c.roles.has(current.priceRole);
   if(!c.full&&!technical&&!price)return [];
   const basis=assembly?.rows[row.rowId];
   return [{...row,...(basis?.craftRef?{craftBasis:{stage:basis.stage,...basis.craftRef}}:{}),unitPrice:c.full||price?row.unitPrice:null,consumption:row.consumption,assignment:a,
    technicalAssigneeName:a.technicalAssigneeId?names.get(a.technicalAssigneeId)??null:null,priceAssigneeName:a.priceAssigneeId?names.get(a.priceAssigneeId)??null:null,
    canEditConsumption:version===undefined&&(!q?.assembly||q.assembly.rows[row.rowId]?.kind==='material')&&(isRootActor(actor)||technical),canEditPrice:version===undefined&&(isRootActor(actor)||price),consumptionSource:sources[row.rowId]??null}];
  });
  const technicalConsumptionOptions:NonNullable<QuotationSheet['technicalConsumptionOptions']>=[];
  if(version===undefined&&c.sourceId&&rows.some(r=>r.canEditConsumption)){
   const source=await developmentDocumentRow(db,c.sourceId),artifact=source?await publishedTechnicalArtifact(db,c.sourceId,source.round_number??1):null;
   if(source?.document&&artifact&&artifact.row.document_fingerprint===technicalDocumentFingerprint(source.document))for(const r of artifact.artifact.body.consumptionRows){
    const material=source.document.materials.find((m:DevelopmentMaterial)=>m.materialId===r.materialId);
    if(material&&r.unit&&r.consumption!=='')technicalConsumptionOptions.push({artifactSetId:artifact.artifact.artifactSetId,artifactVersion:artifact.artifact.version,materialId:r.materialId,name:material.name,unit:r.unit,consumption:r.consumption});
   }
  }
  return {...(c.full&&assembly?.priorCraftRows?{priorCraftRows:Object.values(assembly.priorCraftRows).map(value=>({row:value.row,stage:value.ref.stage}))}:{}),...(q?.assembly?{automatic:true,complete:quotationComplete({...q,document:doc!,assignments,consumption_sources:sources,price_sources:snapshot?.price_sources??q.price_sources,assembly:snapshot?.assembly??q.assembly})}:{}),technicalConsumptionOptions,quoteId:q?.quote_id??null,resource,productionOrderId:c.orderId,sourceId:c.sourceId,designStyleNo:c.row.design_style_no,designerId:c.designerId,customerCode:c.customerCode,
   version:version??q?.version??0,status:(version!==undefined||Boolean(q)&&q?.version===q?.confirmed_version)?'confirmed':'draft',confirmedVersion:q?.confirmed_version??null,
   versions:c.full&&q?(await db.query('SELECT version FROM digital_quotation_versions WHERE quote_id=$1 ORDER BY version DESC',[q.quote_id])).rows.map(x=>x.version):[],
   document:c.full?doc??null:null,rows,assignments:c.full?assignments:rows.map(r=>r.assignment),confirmation:c.full?confirmation??null:null,
   canStructure:version===undefined&&c.structure&&this.creationEnabled,canConfirm:version===undefined&&c.confirm&&Boolean(c.customerCode)&&Boolean(q)&&q?.version!==q?.confirmed_version&&this.creationEnabled,fullCost:c.full,
   budget:{state:!c.orderId?'waiting_formal_order':!q?.confirmed_version?'waiting_confirmation':!budget?'waiting_confirmation':!budget.quote_id?'legacy_published':budget.quote_id===q.quote_id&&budget.quote_version===q.confirmed_version?'created':'review_required',version:budget?.version??null}};
 }
 async list(actor:TrustedActorContext){
  const active=new Set<string>();if(!isRootActor(actor))for(const role of readRoles)if(actor.actorRoles.includes(role)&&await new DigitalProductionAccessPolicy(this.database).activeRole(actor.actorId,role))active.add(role);
  // Resource names are projected only after scope checks; no all-order directory.
  const rows=(await this.database.query(`SELECT q.source_id,q.production_order_id FROM digital_quotation_documents q
   WHERE $1::boolean OR EXISTS(SELECT 1 FROM jsonb_array_elements(q.assignments) a WHERE ($5::boolean AND a->>'technicalAssigneeId'=$2::text) OR (a->>'priceAssigneeId'=$2::text AND a->>'priceRole'=ANY($6::text[])))
   OR EXISTS(SELECT 1 FROM digital_production_orders o WHERE o.production_order_id=q.production_order_id AND (($3::boolean AND o.created_by=$2::uuid) OR ($4::boolean AND o.primary_merchandiser_id=$2::uuid)))
   OR ($3::boolean AND EXISTS(SELECT 1 FROM digital_production_sources s WHERE s.source_id=q.source_id AND s.created_by=$2::uuid))
   ORDER BY q.updated_at DESC LIMIT 100`,[isRootActor(actor)||active.has('owner_group')||active.has('production_management')||active.has('pmc'),actor.actorId,active.has('sample_designer'),active.has('order_merchandiser'),active.has('pattern_room_worker'),[...active].filter(r=>['sample_designer','ie_reviewer','embroidery_washing_merchandiser','pattern_room_worker'].includes(r))])).rows;
  const items=[];
  for(const row of rows){const resource:QuotationResource=row.production_order_id?{kind:'order',id:row.production_order_id}:{kind:'source',id:row.source_id};if(!await acceptanceIncludesNative(this.database,resource.id))continue;try{const sheet=await this.read(actor,resource);items.push({resource,designStyleNo:sheet.designStyleNo,customerCode:sheet.customerCode,version:sheet.version,status:sheet.status});}catch(error){if(!(error instanceof ApplicationError&&error.statusCode===404))throw error;}}
  return {items};
 }
 async participants(actor:TrustedActorContext,resource:QuotationResource){
  const c=await this.context(this.database,actor,resource);if(!c.structure)digitalForbidden();
  const users=(await this.database.query(`SELECT DISTINCT u.id,u.display_name AS name,a.role_code AS role FROM app_users u JOIN user_role_assignments a ON a.user_id=u.id AND a.revoked_at IS NULL
   JOIN business_roles r ON r.role_code=a.role_code AND r.enabled WHERE u.enabled AND NOT coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)
   AND a.role_code=ANY($1::text[]) AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)
   ORDER BY u.display_name,u.id`,[['pattern_room_worker','ie_reviewer','embroidery_washing_merchandiser']])).rows;
  // Respect Acceptance actor isolation as well as employment/role state.
  const result=[];for(const user of users)if(await new DigitalProductionAccessPolicy(this.database).activeRole(user.id,user.role))result.push(user);
  return {items:result};
 }
 private async command(actor:TrustedActorContext,resource:QuotationResource,action:string,key:string,payload:unknown,work:(db:PoolClient,c:Awaited<ReturnType<DigitalQuotationService['context']>>)=>Promise<void>){
  if(!this.creationEnabled)throw new ApplicationError('FORBIDDEN','新报价维护尚未启用',403);
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))conflict('缺少有效操作标识');
  const db=await this.database.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const c=await this.context(db,actor,resource);
   for(const role of c.roles)if(!await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,role))digitalForbidden();
   const lifecycle=(await db.query('SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2',[c.orderId?'order':'source',c.orderId??c.sourceId])).rows[0];
   if(lifecycle&&lifecycle.state!=='active')conflict('原单已暂停或取消，报价暂不能修改；保留历史依据');
   const command=`quotation:${resource.kind}:${resource.id}:${action}`,hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior?.payload_hash!==undefined&&prior.payload_hash!==hash)conflict('同一操作标识不能用于不同内容');
   // Reauthorize each response. Do not replay a cached full-cost body after role revocation.
   if(!prior){if(c.quote?.assembly&&c.sourceId)c.quote=await assembleQuotation(db,c.sourceId,actor.actorId)??c.quote;await work(db,c);}
   const current=await this.read(actor,resource,db),receipt=prior?.response?.commandReceipt??{action,appliedVersion:current.version};
   if(!prior){await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify({resource,commandReceipt:receipt})]);
    await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'customer_quotation',$5,$6)",[randomUUID(),actor.requestId,actor.actorId,`quotation_${action}`,resource.id,JSON.stringify({resource,commandReceipt:receipt})]);}
   await db.query('COMMIT');return {...current,commandReceipt:receipt};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async save(actor:TrustedActorContext,resource:QuotationResource,input:z.infer<typeof SaveQuotationSchema>,key:string){
  input=SaveQuotationSchema.parse(input);
  return this.command(actor,resource,'save',key,input,async(db,c)=>{
   if(!c.structure)digitalForbidden();if((c.quote?.version??0)!==input.expectedVersion)conflict('报价版本已更新，请保留输入并读取最新版本');
   const current=c.quote;
   if(current?.assembly){
    if(!isDeepStrictEqual(input.document,current.document))conflict('自动报价明细来自本单资料；请在原资料修改材料，单价由对应岗位填写');
    for(const a of input.assignments){
     const old=current.assignments.find(value=>value.rowId===a.rowId)!,ref=current.assembly.rows[a.rowId]!;
     if(ref.kind==='ie'&&(a.priceRole!=='ie_reviewer'||a.technicalAssigneeId!==null)||ref.kind==='material'&&(a.priceRole!=='sample_designer'||a.priceAssigneeId!==c.designerId)||ref.kind==='craft'&&!(ref.stage==='bulk'&&ref.craftRef)&&!(ref.sourceRef.includes('内洗')||ref.sourceRef.includes('外洗'))&&!isDeepStrictEqual(a,old))conflict('工艺沿原实际派工；材料由设计定价，IE加工价由IE填写');
     if(ref.kind==='craft'&&(a.priceRole!==old.priceRole||a.technicalAssigneeId!==null))conflict('请保留原工艺报价岗位');
     if(a.technicalAssigneeId&&!(isRootActor(actor)&&a.technicalAssigneeId===actor.actorId)&&!await new DigitalProductionAccessPolicy(db).lockActiveRole(a.technicalAssigneeId,'pattern_room_worker'))conflict('用量负责人岗位已失效');
     if(a.priceAssigneeId&&!(isRootActor(actor)&&a.priceAssigneeId===actor.actorId)&&!await new DigitalProductionAccessPolicy(db).lockActiveRole(a.priceAssigneeId,a.priceRole))conflict('报价负责人岗位已失效');
    }
    const document=structuredClone(current.document),prices={...current.price_sources},sources={...current.consumption_sources};
    for(const a of input.assignments){const old=current.assignments.find(value=>value.rowId===a.rowId)!,row=document.rows.find(value=>value.rowId===a.rowId)!;
     if(a.priceAssigneeId!==old.priceAssigneeId){row.unitPrice='';delete prices[row.rowId];}
     if(a.technicalAssigneeId!==old.technicalAssigneeId){row.consumption='';delete sources[row.rowId];}
    }
    await db.query('UPDATE digital_quotation_documents SET version=version+1,document=$2,assignments=$3,price_sources=$4,consumption_sources=$5 WHERE quote_id=$1',[current.quote_id,JSON.stringify(document),JSON.stringify(input.assignments),JSON.stringify(prices),JSON.stringify(sources)]);
    const assembled=await assembleQuotation(db,c.sourceId!,actor.actorId,current.version+1);
    if(!isDeepStrictEqual(assembled?.assignments,input.assignments))conflict('人员已在原总委派中确定，请从原任务更改');
    return;
   }

   const sources:Record<string,QuotationConsumptionSource>={},priceSources:Record<string,PriceSource>={};
   for(const row of input.document.rows){
    const assignment=input.assignments.find(a=>a.rowId===row.rowId)!;
    if(row.section==='外发工序'&&assignment.priceRole==='sample_designer')conflict('外发工序价格须指定IE或工艺报价岗位');
    if(row.section!=='外发工序'&&(assignment.priceRole!=='sample_designer'||assignment.priceAssigneeId!==c.designerId))conflict('面辅料价格由本单设计填写');
    if(assignment.technicalAssigneeId&&!(isRootActor(actor)&&assignment.technicalAssigneeId===actor.actorId)&&!await new DigitalProductionAccessPolicy(db).lockActiveRole(assignment.technicalAssigneeId,'pattern_room_worker'))conflict('用量负责人须为有效技术纸样岗位');
    if(assignment.priceAssigneeId&&!(isRootActor(actor)&&assignment.priceAssigneeId===actor.actorId)&&!await new DigitalProductionAccessPolicy(db).lockActiveRole(assignment.priceAssigneeId,assignment.priceRole))conflict('报价负责人岗位无效或已停用');
    const old=current?.document.rows.find(r=>r.rowId===row.rowId),oldAssignment=current?.assignments.find(a=>a.rowId===row.rowId);
    const changedBasis=Boolean(old)&&(row.unit!==old!.unit||row.name!==old!.name||row.specification!==old!.specification||row.section!==old!.section||oldAssignment?.technicalAssigneeId!==assignment.technicalAssigneeId);
    if(changedBasis&&row.consumption!=='')conflict('物料、规格、单位或用量负责人改变后须清空原用量，由技术重新填写');
    if(!isRootActor(actor)&&(row.consumption!==''&&(!changedBasis&&row.consumption!==(old?.consumption??''))||row.section==='外发工序'&&row.unitPrice!==(old?.unitPrice??'')&&row.unitPrice!==''))digitalForbidden();
    if(row.section==='外发工序'&&oldAssignment?.priceAssigneeId!==assignment.priceAssigneeId&&row.unitPrice!=='')conflict('工艺报价改派后须清空原价，由新的报价负责人填写');
    if(changedBasis&&row.section==='外发工序'&&row.unitPrice!=='')conflict('工艺或计价单位变更后须由负责报价岗位重新填写价格');
    if(row.consumption!==''&&current?.consumption_sources[row.rowId])sources[row.rowId]=current.consumption_sources[row.rowId]!;
    if(row.unitPrice!=='')priceSources[row.rowId]=old?.unitPrice===row.unitPrice&&!changedBasis&&current?.price_sources[row.rowId]?current.price_sources[row.rowId]!:{actorId:actor.actorId,role:isRootActor(actor)?'root_superuser':'sample_designer',version:(current?.version??0)+1,recordedAt:businessNow().toISOString()};
   }
   // Removing a priced/consumption row is an explicit new draft, never an edit to the confirmed snapshot.
   const id=current?.quote_id??randomUUID(),version=(current?.version??0)+1;
   await db.query(`INSERT INTO digital_quotation_documents(quote_id,source_id,production_order_id,version,document,assignments,consumption_sources,price_sources,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(quote_id) DO UPDATE SET version=EXCLUDED.version,document=EXCLUDED.document,assignments=EXCLUDED.assignments,consumption_sources=EXCLUDED.consumption_sources,price_sources=EXCLUDED.price_sources,updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP`,[id,c.sourceId,c.orderId,version,JSON.stringify(input.document),JSON.stringify(input.assignments),JSON.stringify(sources),JSON.stringify(priceSources),actor.actorId]);
  });
 }
 async fillRow(actor:TrustedActorContext,resource:QuotationResource,rowId:string,input:z.infer<typeof QuotationRowInputSchema>,key:string){
  input=QuotationRowInputSchema.parse(input);
  return this.command(actor,resource,`row:${rowId}`,key,input,async(db,c)=>{
   const q=c.quote??digitalNotFound();if(q.version!==input.expectedVersion)conflict('报价版本已更新，请核对当前行后再提交');
   const row=q.document.rows.find(r=>r.rowId===rowId)??digitalNotFound(),a=q.assignments.find(a=>a.rowId===rowId)??digitalNotFound();
   const tech=a.technicalAssigneeId===actor.actorId&&c.roles.has('pattern_room_worker'),price=a.priceAssigneeId===actor.actorId&&c.roles.has(a.priceRole);
   if((input.consumption!==undefined||input.artifactConsumption)&&!isRootActor(actor)&&!tech||input.unitPrice!==undefined&&!isRootActor(actor)&&!price)digitalForbidden();
   const component=q.assembly?.rows[rowId];
   if(component&&component.kind!=='material'&&(input.consumption!==undefined||input.artifactConsumption))conflict('材料价格从原开发资料读取；IE与工艺均按每件单价计入，不重复填写用量');
   const version=q.version+1,sources={...q.consumption_sources},priceSources={...q.price_sources};
   let adoptedConsumption:string|undefined;
   if(input.artifactConsumption){
    if(!c.sourceId)conflict('本报价尚无开发技术来源，可继续按真实技术数据直接填写');
    const source=await developmentDocumentRow(db,c.sourceId!),artifact=source?await publishedTechnicalArtifact(db,c.sourceId!,source.round_number??1):null,ref=input.artifactConsumption;
    if(!source?.document||!artifact||artifact.artifact.artifactSetId!==ref.id||artifact.artifact.version!==ref.version||artifact.row.document_fingerprint!==technicalDocumentFingerprint(source.document))conflict('技术成果已变版，请重新读取后显式采用');
    const consumption=artifact!.artifact.body.consumptionRows.find(r=>r.materialId===ref.materialId);
    if(!consumption||!row.unit.trim()||consumption.unit!==row.unit.trim())conflict('该物料或单位与本报价行不符，请核对；不自动换算单位');
    if(component&&ref.materialId!==component.sourceRef)conflict('技术用量必须对应同一物料标识，不能按名称或相同单位替换');
    if(!['主料','辅料'].includes(row.section))conflict('物料用量成果仅用于对应材料行，工序用量仍按实际技术填写');
    adoptedConsumption=consumption!.consumption;sources[rowId]={kind:'technical_artifact',actorId:actor.actorId,version,recordedAt:businessNow().toISOString(),artifactRef:{id:ref.id,version:ref.version,materialId:ref.materialId}};
   }
   if(input.consumption!==undefined){if(!row.unit)conflict('请设计先填写物料单位');sources[rowId]={kind:'technical_manual',actorId:actor.actorId,version,recordedAt:businessNow().toISOString()};}
   if(input.unitPrice!==undefined)priceSources[rowId]={actorId:actor.actorId,role:isRootActor(actor)?'root_superuser':a.priceRole,version,recordedAt:businessNow().toISOString(),...(component?.kind==='material'?{documentPriceHash:component.priceBasis}:{} )};
   if(input.consumption===''&&!q.assembly)delete sources[rowId];if(input.unitPrice===''&&!q.assembly)delete priceSources[rowId];
   const document={...q.document,rows:q.document.rows.map(r=>r.rowId===rowId?{...r,...(adoptedConsumption!==undefined?{consumption:adoptedConsumption}:input.consumption!==undefined?{consumption:input.consumption}:{}),...(input.unitPrice!==undefined?{unitPrice:input.unitPrice}:{})}:r)};
   await db.query('UPDATE digital_quotation_documents SET version=$2,document=$3,consumption_sources=$4,price_sources=$5,updated_by=$6,updated_at=CURRENT_TIMESTAMP WHERE quote_id=$1',[q.quote_id,version,JSON.stringify(document),JSON.stringify(sources),JSON.stringify(priceSources),actor.actorId]);
   if(q.assembly&&c.sourceId)await assembleQuotation(db,c.sourceId,actor.actorId,version);
  });
 }
 async confirm(actor:TrustedActorContext,resource:QuotationResource,input:z.infer<typeof QuotationConfirmationSchema>,key:string){
  input=QuotationConfirmationSchema.parse(input);
  return this.command(actor,resource,'confirm',key,input,async(db,c)=>{
   if(!c.confirm)digitalForbidden();const q=c.quote??conflict('请先保存报价');
   if(!c.customerCode||input.customerCode!==c.customerCode)conflict('客户未明确或与原单不一致，先保留报价草稿，不能记录为客户已确认');
   if(q.version!==input.expectedVersion||q.version===q.confirmed_version)conflict('报价已更新或本版已确认，请读取当前版本');
   if(new Date(input.confirmedAt).getTime()>businessNow().getTime())conflict('客户确认时间不能晚于当前时间');
   const document=BudgetDocumentSchema.parse(q.document);
   if(!document.rows.length)conflict('报价须有实际明细');
   if(!quotationComplete(q))conflict('请各负责岗位补齐报价明细、单件用量、单价与填写依据');
   await db.query(`INSERT INTO digital_quotation_versions(quote_id,version,document,assignments,consumption_sources,price_sources,confirmation,customer_code,confirmed_quote_total,confirmed_by_internal${q.assembly?',assembly':''})
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10${q.assembly?',$11':''})`,[q.quote_id,q.version,JSON.stringify(document),JSON.stringify(q.assignments),JSON.stringify(q.consumption_sources),JSON.stringify(q.price_sources),JSON.stringify(input),c.customerCode,input.customerConfirmedTotal,actor.actorId,...(q.assembly?[JSON.stringify(q.assembly)]:[])]);
   await db.query('UPDATE digital_quotation_documents SET confirmed_version=$2 WHERE quote_id=$1',[q.quote_id,q.version]);
   if(c.orderId)await ensureQuotationBudget(db,c.orderId,actor.actorId);
  });
 }
}
