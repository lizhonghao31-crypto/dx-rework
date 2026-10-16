import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { ContractContent, CorrectSourcingCase, CreateSourcingCase, SaveContractContent } from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalPoDateRepository } from "./po-date-repository.js";

type Db = Pick<PoolClient,"query">;
function conflict(message:string):never {throw new ApplicationError("DIGITAL_PRODUCTION_CONFLICT",message,409);}
export async function factoryPoLines(db:Db,caseId:string,at:string|null=null,snapshotId:string|null=null) {
  const source=(await db.query("SELECT COALESCE(to_jsonb(sourcing_cases)->>'workflow_generation','legacy') AS workflow_generation FROM sourcing_cases WHERE sourcing_case_id=$1",[caseId])).rows[0];
  if(source?.workflow_generation!=="digital_production_v1")return null;
  const rows=(await db.query(`SELECT link.production_order_id,line.line_id,child.child_line_key::integer AS position,
    line.formal_style_no,line.color,line.factory_date_version,line.customer_warehouse_arrival_date::text AS customer,
    CASE WHEN $2::timestamptz IS NULL AND $3::uuid IS NULL THEN line.factory_delivery_date
      ELSE (SELECT fact.new_date FROM digital_po_date_changes fact WHERE fact.line_id=line.line_id AND fact.date_kind='factory'
        AND fact.created_at<=COALESCE((SELECT approved_at FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=$3),$2::timestamptz)
        ORDER BY fact.version DESC LIMIT 1) END::text AS factory,
    (SELECT sum(size.quantity)::integer FROM digital_production_po_sizes size WHERE size.line_id=line.line_id) AS quantity
    FROM digital_production_child_links link JOIN digital_production_child_lines child
      ON child.module=link.module AND child.child_id=link.child_id AND child.production_order_id=link.production_order_id
    JOIN digital_production_po_lines line ON line.production_order_id=child.production_order_id AND line.line_id=child.line_id
    WHERE link.module='sourcing' AND link.child_id=$1 ORDER BY child.child_line_key::integer`,[caseId,at,snapshotId])).rows;
  if(!rows.length)conflict("数字外发缺少原 PO 关联，请核对来源");
  return rows;
}
export async function factoryProposals(db:Db,caseId:string,at:string|null=null):Promise<Array<{factoryDeliveryDate?:string}>> {
  const row=(await db.query(`SELECT COALESCE((SELECT correction.lines FROM sourcing_case_corrections correction
      WHERE correction.sourcing_case_id=source.sourcing_case_id AND ($2::timestamptz IS NULL OR correction.corrected_at<=$2)
      ORDER BY correction.correction_version DESC LIMIT 1),event.after_state->'lineItems') AS lines
    FROM sourcing_cases source JOIN operation_events event ON event.event_id=source.operation_event_id WHERE source.sourcing_case_id=$1`,[caseId,at])).rows[0];
  return row?.lines ?? [];
}
export function validateFactoryInputs(lines:readonly {line_id:string;color:string;quantity:number;customer:string|null;position:number}[],
  input:Pick<CreateSourcingCase|CorrectSourcingCase,"lineItems"|"estimatedCutPieceSendDate">,correcting=false) {
  if(lines.length!==input.lineItems.length)conflict("补号不能增加或删除 PO");
  for(const row of lines){
    const entered=input.lineItems[row.position-1];
    if(!entered || entered.lineId!==row.line_id || entered.color!==row.color || entered.quantity!==Number(row.quantity))
      conflict("补号不能改变原 PO 身份、颜色或数量");
    if(!entered.factoryDeliveryDate || !z.iso.date().safeParse(entered.factoryDeliveryDate).success
      || entered.factoryDeliveryDate<input.estimatedCutPieceSendDate || row.customer && entered.factoryDeliveryDate>row.customer)
      conflict("请逐 PO 填写合法加工厂交货日，不能早于裁片发出或晚于出货日期");
    if(correcting && !entered.styleNo && !entered.alternateStyleNo)conflict("正式号与代用号不能同时为空");
  }
}
// Only called from the original audited sourcing creation/correction transaction.
export async function syncFactoryPoNumbers(db:Db,caseId:string,input:Pick<CreateSourcingCase|CorrectSourcingCase,"lineItems"|"estimatedCutPieceSendDate">) {
  const lines=await factoryPoLines(db,caseId);if(!lines)return;
  await db.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE",[lines[0]!.production_order_id]);
  validateFactoryInputs(lines,input,true);
  const changedIds=lines.filter(row=>(input.lineItems[row.position-1]!.styleNo?.trim() || null)!==row.formal_style_no).map(row=>row.line_id);
  if(changedIds.length)await db.query("UPDATE digital_production_po_lines SET po_number=NULL,formal_style_no=NULL WHERE line_id=ANY($1::uuid[])",[changedIds]);
  let changed=false;
  for(const row of lines){const entered=input.lineItems[row.position-1]!;
    const formal=entered.styleNo?.trim() || null;
    if(formal!==row.formal_style_no){
      await db.query("UPDATE digital_production_po_lines SET po_number=$2,formal_style_no=$2 WHERE line_id=$1",[row.line_id,formal]);changed=true;
    }
  }
  if(changed)await db.query("UPDATE digital_production_orders SET version=version+1 WHERE production_order_id=$1",[lines[0]!.production_order_id]);
}
async function activate(db:Db,actor:TrustedActorContext,caseId:string,sourceEventId:string,reason:string,changes:Array<{lineId:string;date:string;expectedVersion:number;oldDate:string|null}>) {
  if(!changes.length)return;
  const lines=await factoryPoLines(db,caseId);if(!lines)return;
  const orderId=lines[0]!.production_order_id;
  const auditId=randomUUID();
  await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
    VALUES($1,$2,$3,'digital_po_factory_dates_approved','digital_production',$4,$5)`,[auditId,actor.requestId,actor.actorId,orderId,
    JSON.stringify({reason,sourceOperationEventId:sourceEventId,sourcingCaseId:caseId,dateChanges:changes.map(change=>({...change,dateKind:"factory"}))})]);
  await new DigitalPoDateRepository(db).applyWithClient(actor,orderId,"approved_factory_change",changes,auditId);
  await db.query("UPDATE digital_production_orders SET version=version+1 WHERE production_order_id=$1",[orderId]);
}
export async function approveFactoryPoDates(db:Db,actor:TrustedActorContext,caseId:string,eventId:string,reason:string,isFactoryChange:boolean) {
  const lines=await factoryPoLines(db,caseId);if(!lines || isFactoryChange)return;
  const proposals=await factoryProposals(db,caseId);
  const send=(await db.query("SELECT estimated_cut_piece_send_date::text AS send FROM sourcing_case_facts_at($1)",[caseId])).rows[0]?.send;
  const changes=[];
  for(const row of lines){const date=proposals[row.position-1]?.factoryDeliveryDate;
    if(!date || !z.iso.date().safeParse(date).success || send && date<send || row.customer && date>row.customer)
      conflict("逐 PO 工厂交期缺失或已与当前出货日期冲突，请按原退回改正流程处理");
    if(date!==row.factory)changes.push({lineId:row.line_id,date,expectedVersion:Number(row.factory_date_version),oldDate:row.factory});
  }
  await activate(db,actor,caseId,eventId,reason,changes);
}
async function contractPoLines(db:Db,caseId:string,documentId:string) {
  const lines=await factoryPoLines(db,caseId);if(!lines)return null;
  const snapshot=(await db.query("SELECT approval_snapshot FROM sourcing_contract_documents WHERE sourcing_case_id=$1 AND sourcing_contract_document_id=$2",[caseId,documentId])).rows[0]?.approval_snapshot;
  if(!snapshot || !Array.isArray(snapshot.lines))conflict("合同批准款色范围缺失，请核对原批准事实");
  const positions=new Set(snapshot.lines.map((line:{position:number})=>Number(line.position)));
  return lines.filter(line=>positions.has(line.position));
}
export async function contractFactoryState(db:Db,caseId:string,content:ContractContent,documentId:string) {
  const lines=await contractPoLines(db,caseId,documentId);if(!lines)return {content};
  // Older frozen documents may acquire a mapping in the editor only when their
  // original position and identity still match. Historic bytes are never changed.
  const identities=(await db.query("SELECT position,style_no,alternate_style_no,color FROM current_sourcing_case_lines WHERE sourcing_case_id=$1",[caseId])).rows;
  const mapped={...content,lines:content.lines.map(line=>{
    const row=lines.find(row=>row.line_id===line.lineId || !line.lineId && row.position===line.position
      && identities.some(identity=>identity.position===line.position && (identity.style_no===line.styleNo || identity.alternate_style_no===line.styleNo)
        && identity.color===line.color));
    return row?{...line,lineId:row.line_id,...(row.factory?{deliveryDate:row.factory}:{})}:line;
  })};
  return {content:mapped,poFactoryDates:lines.map(row=>({lineId:row.line_id,position:row.position,styleNo:row.formal_style_no??"",color:row.color,
    factoryDeliveryDate:row.factory,expectedVersion:Number(row.factory_date_version),customerWarehouseArrivalDate:row.customer}))};
}
export async function normalizeFactoryContract(db:Db,caseId:string,input:SaveContractContent) {
  const rows=await contractPoLines(db,caseId,input.sourcingContractDocumentId);if(!rows){if(input.poFactoryDates)conflict("旧式外发不能使用数字 PO 日期命令");return {content:input.content,changes:[]};}
  const frozen=await contractFactoryState(db,caseId,input.content,input.sourcingContractDocumentId);
  const requested=input.poFactoryDates;
  if(!requested || requested.length!==rows.length || new Set(requested.map(row=>row.lineId)).size!==rows.length)
    conflict("请重新打开合同，逐 PO 核对工厂交期");
  const changes=[];const dates=new Map<string,string|null>();
  const send=(await db.query("SELECT estimated_cut_piece_send_date::text AS send FROM sourcing_case_facts_at($1)",[caseId])).rows[0]?.send;
  for(const row of rows){const entered=requested.find(item=>item.lineId===row.line_id);
    if(!entered || entered.expectedVersion!==Number(row.factory_date_version) || entered.position!==row.position)conflict("PO 工厂交期已更新，请重新打开合同");
    const date=entered.factoryDeliveryDate;
    if(date!==row.factory){
      if(!date || !z.iso.date().safeParse(date).success || send && date<send || row.customer && date>row.customer)conflict("工厂交期不能早于原裁片发出或晚于出货日期");
      changes.push({lineId:row.line_id,date,expectedVersion:Number(row.factory_date_version),oldDate:row.factory});
    }
    dates.set(row.line_id,date);
  }
  for(const line of input.content.lines){
    if(line.lineId && !dates.has(line.lineId))conflict("合同 PO 不属于本外发单");
    if(line.lineId && line.deliveryDate && line.deliveryDate!==dates.get(line.lineId))conflict("合同货期须与对应 PO 工厂交期一致");
  }
  if(new Set(input.content.lines.filter(line=>line.lineId).map(line=>line.lineId)).size!==input.content.lines.filter(line=>line.lineId).length)
    conflict("合同不能重复映射同一 PO");
  const current=await loadOriginalHeader(db,input.sourcingContractDocumentId);
  if(input.content.deliveryDate!==current)conflict("数字合同请逐 PO 修改工厂交期，不能用整单货期覆盖");
  const known=[...dates.values()].filter((date):date is string=>!!date).sort();
  const content={...frozen.content,deliveryDate:known[0]??current,lines:frozen.content.lines.map(line=>{
    const date=line.lineId?dates.get(line.lineId):undefined;
    return date?{...line,deliveryDate:date}:line;
  })};
  return {content,changes};
}
async function loadOriginalHeader(db:Db,documentId:string):Promise<string> {
  const row=(await db.query(`SELECT COALESCE(content.content->>'deliveryDate',document.approval_snapshot->>'deliveryDate','未维护') AS date
    FROM sourcing_contract_documents document LEFT JOIN sourcing_contract_content_overrides content USING(sourcing_contract_document_id)
    WHERE document.sourcing_contract_document_id=$1`,[documentId])).rows[0];return row?.date??"未维护";
}
export async function editFactoryPoDates(db:Db,actor:TrustedActorContext,caseId:string,eventId:string,changes:Parameters<typeof activate>[5]) {
  await activate(db,actor,caseId,eventId,"Root通过原修改合同内容逐 PO 修订工厂交期",changes);
}

// Freeze only an explicitly requested transfer date. Omitted dates preserve each PO promise.
export async function prepareTransferPoDates(db:Db,caseId:string,date:string,positions:readonly number[]) {
  const lines=await factoryPoLines(db,caseId);if(!lines)return undefined;
  const selected=lines.filter(row=>positions.includes(row.position));
  const send=(await db.query("SELECT estimated_cut_piece_send_date::text AS send FROM sourcing_case_facts_at($1)",[caseId])).rows[0]?.send;
  if(!selected.length)conflict("转入款色缺少 PO 关联");
  for(const row of selected)if(!z.iso.date().safeParse(date).success || send && date<send || row.customer && date>row.customer)
    conflict("转厂工厂交期不能早于裁片发出或晚于对应出货日期");
  return selected.map(row=>({lineId:row.line_id,position:row.position,date,expectedVersion:Number(row.factory_date_version),oldDate:row.factory}));
}
export async function approveTransferPoDates(db:Db,actor:TrustedActorContext,caseId:string,requestId:string,eventId:string,reason:string) {
  const basis=(await db.query(`SELECT event.after_state FROM sourcing_factory_change_requests request
    JOIN operation_events event ON event.event_id=request.operation_event_id
    WHERE request.factory_change_request_id=$1 AND request.sourcing_case_id=$2`,[requestId,caseId])).rows[0]?.after_state;
  if(!basis?.transferPoDates)return;
  const lines=await factoryPoLines(db,caseId);if(!lines)conflict("转厂 PO 关联已变化");
  const positions=(await db.query(`SELECT line.position FROM sourcing_decision_lines line JOIN sourcing_decisions decision USING(sourcing_decision_id)
    WHERE decision.source_change_request_id=$1`,[requestId])).rows.map(row=>row.position);
  const changes=[];
  const send=(await db.query("SELECT estimated_cut_piece_send_date::text AS send FROM sourcing_case_facts_at($1)",[caseId])).rows[0]?.send;
  for(const row of lines.filter(row=>positions.includes(row.position))){
    const frozen=basis.transferPoDates.find((item:{lineId:string})=>item.lineId===row.line_id);
    if(!frozen || frozen.position!==row.position || frozen.expectedVersion!==Number(row.factory_date_version) || frozen.oldDate!==row.factory)
      conflict("PO 工厂交期已变化，请驳回后重新发起转厂");
    if(frozen.date!==basis.deliveryDate || !z.iso.date().safeParse(frozen.date).success || send && frozen.date<send || row.customer && frozen.date>row.customer)
      conflict("转厂交期已与当前裁片发出或出货日期冲突，请驳回后重新申请");
    if(frozen.date!==row.factory)changes.push({...frozen});
  }
  await activate(db,actor,caseId,eventId,reason,changes);
}
