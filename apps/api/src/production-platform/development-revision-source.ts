import {assembleQuotation} from './quotation-assembly.js';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {DevelopmentRevision} from '@dx-rework/contracts/digital-development-rounds';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import type {BusinessClock} from '@dx-rework/domain/business-clock';
import {ContextBusinessClock,registerAcceptanceCreated} from '../acceptance-clock/business-time.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {captureDevelopmentSla} from './development-sla-enrollment.js';
import {acceptsNewOrderTime} from './order-time-admission.js';
type DB=Pick<PoolClient,'query'>;
export async function developmentRevisionSource(db:DB,sourceId:string){
 if(!(await db.query("SELECT to_regclass('digital_development_revision_sources') AS relation")).rows[0]?.relation)return null;
 return (await db.query(`SELECT source_id AS "sourceId",parent_source_id AS "parentSourceId",root_source_id AS "rootSourceId",revision_number AS "revisionNumber",parent_round AS "parentRound",origin,customer_comment AS "customerComment",explanation,categories,affected_nodes AS "affectedNodes",output_kind AS "outputKind" FROM digital_development_revision_sources WHERE source_id=$1`,[sourceId])).rows[0]??null;
}
export async function inheritedDevelopmentFile(db:DB,sourceId:string,attachmentId:string){
 if(!(await db.query("SELECT to_regclass('digital_development_inherited_files') AS relation")).rows[0]?.relation)return false;
 return Boolean((await db.query(`SELECT 1 FROM digital_development_inherited_files f JOIN attachments a USING(attachment_id)
  WHERE f.source_id=$1 AND f.attachment_id=$2 AND a.entity_type='digital_development' AND a.entity_id=f.original_source_id::text`,[sourceId,attachmentId])).rowCount);
}
/** Caller has validated the source scope, current revision and files inside the lifecycle transaction. */
export async function createIndependentDevelopmentRevision(db:PoolClient,actor:TrustedActorContext,parentId:string,input:DevelopmentRevision,clock:BusinessClock=new ContextBusinessClock(),directPublication=false){
 if(input.origin==='内部发现')throw new Error('Internal correction must keep its existing route');
 const parent=(await db.query('SELECT * FROM digital_production_sources WHERE source_id=$1 FOR UPDATE',[parentId])).rows[0];
 const prior=await developmentRevisionSource(db,parentId),rootId=prior?.rootSourceId??parentId;
 const root=(await db.query('SELECT * FROM digital_production_sources WHERE source_id=$1 FOR UPDATE',[rootId])).rows[0];
 const number=Number((await db.query('SELECT coalesce(max(revision_number),0)+1 AS n FROM digital_development_revision_sources WHERE root_source_id=$1',[rootId])).rows[0].n);
 const sourceId=randomUUID(),suffix=` · 复版${number}`,style=`${root.design_style_no.slice(0,100-suffix.length)}${suffix}`;
 const managed=await acceptsNewOrderTime(db);
 const hasCommercialPolicy=Object.hasOwn(root,'workbench_commercial_policy');
 const numbered=root.workbench_generated_number===true;
 const reserved=directPublication&&managed&&Object.hasOwn(root,'draft_reserved');
 await db.query(`INSERT INTO digital_production_sources(source_id,created_by,development_type,design_style_no,temporary_style_no,customer_code${managed?',order_time_managed':''}${reserved?',draft_reserved':''}${hasCommercialPolicy?',workbench_commercial_policy':''}${numbered?',workbench_number_root_id':''})
  VALUES($1,$2,$3,$4,$5,$6${managed?',true':''}${reserved?',true':''}${hasCommercialPolicy?',$7':''}${numbered?(hasCommercialPolicy?',$8':',$7'):''})`,
 [sourceId,parent.created_by,parent.development_type,style,parent.temporary_style_no,parent.customer_code,
  ...(hasCommercialPolicy?[root.workbench_commercial_policy]:[]),...(numbered?[rootId]:[])]);
 await db.query(`INSERT INTO digital_development_revision_sources(source_id,parent_source_id,root_source_id,revision_number,parent_round,origin,customer_comment,explanation,categories,affected_nodes,output_kind,created_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[sourceId,parentId,rootId,number,input.basedOnRound,input.origin,input.customerComment,input.explanation,input.categories,input.affectedNodes,input.outputKind,actor.actorId]);
 const eventId=randomUUID();
 await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_production',$5,$6)",
  [eventId,actor.requestId,actor.actorId,reserved?'digital_source_draft_reserved':'digital_source_created',sourceId,
   JSON.stringify({parentId,rootId,revisionNumber:number,origin:input.origin})]);
 await registerAcceptanceCreated(db,{kind:'source',id:sourceId},actor.actorId,eventId);
 const document=structuredClone(input.document),time=await clock.read({kind:'source',id:sourceId});
 // Copy only specifications and referenced design files. Actual work, arrivals, shipping and PO counts stay on the original.
 delete document.customerOrderDraft;
 document.orderDate=beijingCalendarDate(new Date(time.now));
 document.materials=document.materials.map(material=>({...material,materialId:randomUUID(),available:false,expectedDate:material.category==='辅料'&&material.requiredThisRound&&material.designerHasMaterial===false
  ?material.expectedDate:null}));
 for(const file of document.files){
  const original=(await db.query(`SELECT a.entity_id FROM attachments a WHERE a.attachment_id=$1 AND a.status='ready' AND a.entity_type='digital_development'
   AND (EXISTS(SELECT 1 FROM digital_development_attachment_bindings b WHERE b.attachment_id=a.attachment_id AND b.source_id=$2)
     OR EXISTS(SELECT 1 FROM digital_development_inherited_files f WHERE f.attachment_id=a.attachment_id AND f.source_id=$2 AND f.original_source_id::text=a.entity_id))`,[file.attachmentId,parentId])).rows[0];
  if(!original)throw new ApplicationError('FORBIDDEN','复版附件不属于原开发资料',403);
  await db.query('INSERT INTO digital_development_inherited_files(source_id,attachment_id,original_source_id,inherited_by) VALUES($1,$2,$3,$4)',[sourceId,file.attachmentId,original.entity_id,actor.actorId]);
 }
 await db.query("INSERT INTO digital_development_documents(source_id,version,status,document,updated_by) VALUES($1,1,'draft',$2,$3)",[sourceId,JSON.stringify(document),actor.actorId]);
 if(managed&&!reserved)await db.query("INSERT INTO digital_order_time_subjects(resource_kind,source_id,created_by,created_business_time,creation_event_ref) VALUES('source',$1,$2,$3,$4)",[sourceId,parent.created_by,JSON.stringify(time),'audit_events:'+eventId]);
 else if(!managed)await captureDevelopmentSla(db,actor,sourceId,null,time,eventId);
 await assembleQuotation(db,sourceId,actor.actorId);
 return {sourceId,roundNumber:1,revisionNumber:number,status:'draft' as const};
}
