import type {Pool} from 'pg';
import {describe, expect, it, vi} from 'vitest';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import {canReadExactOriginalQualityPhoto, type OriginalQualityPhotoReference} from '../../apps/api/src/production-platform/original-quality-photo.js';

const id=(suffix:number)=>`00000000-0000-4000-8000-${String(suffix).padStart(12,'0')}`;
const actor=(...actorRoles:string[]):TrustedActorContext=>({actorId:id(1),actorRoles,authorizationCapability:'digital_production:view',requestId:'exact-original-quality-photo'});
const craft={kind:'craft-return',orderId:id(2),checkId:id(3),returnFactId:id(4),lineId:id(5),stepRef:id(6),attachmentId:id(7)} as const;
const factory={kind:'factory-progress',orderId:id(2),productionId:id(8),factoryDecisionId:id(9),recordId:id(10),revision:2,scopeRevision:'a'.repeat(64),attachmentId:id(11)} as const;
const garment={kind:'garment-receipt',orderId:id(2),eventId:id(14),receiptId:id(15),quantityVersion:id(16),attachmentId:id(17)} as const;
const factoryInspection={kind:'factory-inspection',orderId:id(2),eventId:id(20),productionId:id(8),factoryDecisionId:id(9),lineId:id(21),attachmentId:id(22)} as const;
const tuples=(ref:OriginalQualityPhotoReference)=>ref.kind==='craft-return'
  ?[ref.orderId,ref.checkId,ref.returnFactId,ref.lineId,ref.stepRef,ref.attachmentId]
  :ref.kind==='garment-receipt'?[ref.orderId,ref.eventId,ref.receiptId,ref.quantityVersion,ref.attachmentId,'digital_garment_receipt_qc']
  :ref.kind==='factory-inspection'?[ref.orderId,ref.eventId,ref.productionId,ref.factoryDecisionId,ref.lineId,ref.attachmentId,'digital_factory_garment_qc']
  :[ref.orderId,ref.productionId,ref.factoryDecisionId,ref.recordId,ref.revision,ref.scopeRevision,ref.attachmentId];
const result=(rows:Record<string,unknown>[])=>({rows,rowCount:rows.length});

function fixture(stored:OriginalQualityPhotoReference, attachment:'bound-ready'|'pending'|'unbound'|'elsewhere'='bound-ready') {
  let qcActive=true;
  const lookup=vi.fn((sql:string,input:unknown[])=>{
    expect(sql).toContain("a.status='ready'");
    if(stored.kind==='craft-return') {
      for(const clause of ["fact.kind='工艺回仓'",'fact.preparation_id=q.preparation_id','po.production_order_id=route.production_order_id',
        "a.entity_type='digital_factory_qc'",'a.entity_id=q.check_id::text','a.attachment_id=ANY(q.attachment_ids)',
        'route.production_order_id=$1','q.check_id=$2','q.return_fact_id=$3','q.line_id=$4',"fact.payload->>'stepRef' IS NOT DISTINCT FROM $5::text",'a.attachment_id=$6']) expect(sql).toContain(clause);
    } else if(stored.kind==='garment-receipt'){
      for(const clause of ["link.module='receiving'",'q.resource_id=$1','q.event_id=$2',"q.event_kind='garment_receipt_qc'", "q.payload->>'receiptId'=$3", "q.payload->>'quantityVersion'=$4",'a.attachment_id=$5','a.entity_type=$6','a.entity_id=q.event_id::text'])expect(sql).toContain(clause);
    } else if(stored.kind==='factory-inspection'){
      for(const clause of ["link.module='production'",'q.resource_id=$1','q.event_id=$2',"q.event_kind='factory_garment_qc'", "q.payload->>'productionId'=$3", "q.payload->>'factoryDecisionId' IS NOT DISTINCT FROM $4::text",'po.line_id=$5','a.attachment_id=$6',"c.value->>'lineId'=po.line_id::text"])expect(sql).toContain(clause);
    } else {
      for(const clause of ["a.entity_type='digital_qc_progress'",'a.entity_id=r.record_id::text','a.attachment_id=ANY(r.attachment_ids)',
        't.production_order_id=$1','t.native_production_id=$2','t.factory_decision_id IS NOT DISTINCT FROM $3::uuid',
        'r.record_id=$4','r.revision=$5','r.scope_revision=$6','a.attachment_id=$7']) expect(sql).toContain(clause);
    }
    const expected=tuples(stored);
    return result(attachment==='bound-ready'&&input.length===expected.length&&expected.every((value,i)=>value===input[i])?[{found:1}]:[]);
  });
  const query=vi.fn(async (sql:string, values:unknown[]=[])=>{
    const text=sql.replace(/\s+/g,' ').trim();
    if(text.startsWith('SELECT to_regclass(')) {
      if(text.includes('digital_bulk_preparations')) return result([{relation:'digital_bulk_preparations'}]);
      if(text.includes('digital_whole_order_deleted_objects')||text.includes('digital_preparation_responsibilities')||text.includes('digital_qc_supervision_settings')) return result([{relation:null}]);
    }
    if(text.startsWith('SELECT * FROM digital_production_orders ')) return result(values[0]===stored.orderId?[{production_order_id:stored.orderId}]:[]);
    if(text.startsWith('SELECT 1 FROM app_users u JOIN user_role_assignments')) return result(qcActive&&values[0]===id(1)&&values[1]==='quality_control'?[{active:1}]:[]);
    if(text.startsWith('SELECT a.task_id,a.assignee_id,a.required_role FROM digital_production_task_access')) return result([{assignee_id:id(1),required_role:'quality_control'}]);
    if(text.startsWith('SELECT 1 FROM digital_factory_qc ')||text.startsWith('SELECT 1 FROM digital_qc_progress_records ')||text.startsWith('SELECT 1 FROM digital_production_task_events ')) return lookup(text,values);
    throw Error(`Unexpected query: ${text}`);
  });
  return {db:{query} as unknown as Pool,lookup,revoke:()=>{qcActive=false;}};
}

describe('exact original quality evidence photos',()=>{
  it('requires the specific original craft check, return batch, PO and step',async()=>{
    const {db}=fixture(craft),read=actor('pmc');
    await expect(canReadExactOriginalQualityPhoto(db,read,craft)).resolves.toBe(true);
    for(const field of ['checkId','returnFactId','lineId','stepRef','attachmentId'] as const) {
      await expect(canReadExactOriginalQualityPhoto(db,read,{...craft,[field]:id(12)})).resolves.toBe(false);
    }
    await expect(canReadExactOriginalQualityPhoto(db,read,{...craft,stepRef:null})).resolves.toBe(false);
  });

  it('reads legacy craft photos without fabricating a step for the original record',async()=>{
    const legacy={...craft,stepRef:null}, {db}=fixture(legacy),read=actor('production_management');
    await expect(canReadExactOriginalQualityPhoto(db,read,legacy)).resolves.toBe(true);
    await expect(canReadExactOriginalQualityPhoto(db,read,{...legacy,stepRef:id(6)})).resolves.toBe(false);
    const {stepRef:_omitted,...incomplete}=legacy;
    await expect(canReadExactOriginalQualityPhoto(db,read,incomplete as typeof legacy)).resolves.toBe(false);
  });

  it('preserves an original factory history photo only for the exact native execution and stored revisions',async()=>{
    const archived={...factory,factoryDecisionId:null}, {db}=fixture(archived),read=actor('root_superuser');
    await expect(canReadExactOriginalQualityPhoto(db,read,archived)).resolves.toBe(true);
    await expect(canReadExactOriginalQualityPhoto(fixture(factory).db,read,factory)).resolves.toBe(true);
    for(const wrong of [factory,{...archived,productionId:id(12)},{...archived,recordId:id(12)},
      {...archived,revision:3},{...archived,scopeRevision:'b'.repeat(64)}]) {
      await expect(canReadExactOriginalQualityPhoto(db,read,wrong)).resolves.toBe(false);
    }
    const {factoryDecisionId:_omitted,...incomplete}=archived;
    await expect(canReadExactOriginalQualityPhoto(db,read,incomplete as typeof archived)).resolves.toBe(false);
  });

  it('cannot select an unfinished, unbound or differently bound upload as the original photo',async()=>{
    for(const binding of ['pending','unbound','elsewhere'] as const) {
      await expect(canReadExactOriginalQualityPhoto(fixture(craft,binding).db,actor('root_superuser'),craft)).resolves.toBe(false);
    }
  });

  it('requires the exact original garment inspection, receipt, and saved quantity version to open a report',async()=>{
    const {db}=fixture(garment),root=actor('root_superuser');
    await expect(canReadExactOriginalQualityPhoto(db,root,garment)).resolves.toBe(true);
    for(const field of ['eventId','receiptId','quantityVersion','attachmentId'] as const)
      await expect(canReadExactOriginalQualityPhoto(db,root,{...garment,[field]:id(18)})).resolves.toBe(false);
  });

  it('retains factory inspection photos under their native execution and PO but does not confuse them with progress photos',async()=>{
    const {db}=fixture(factoryInspection),root=actor('root_superuser');
    await expect(canReadExactOriginalQualityPhoto(db,root,factoryInspection)).resolves.toBe(true);
    for(const field of ['eventId','productionId','factoryDecisionId','lineId','attachmentId'] as const)
      await expect(canReadExactOriginalQualityPhoto(db,root,{...factoryInspection,[field]:id(18)})).resolves.toBe(false);
  });

  it('rechecks original authorization each time and makes no photo lookup for scopes it denies',async()=>{
    const f=fixture(craft),qc=actor('quality_control');
    await expect(canReadExactOriginalQualityPhoto(f.db,qc,craft)).resolves.toBe(true);
    f.revoke();
    await expect(canReadExactOriginalQualityPhoto(f.db,qc,craft)).resolves.toBe(false);
    await expect(canReadExactOriginalQualityPhoto(f.db,actor('warehouse_receiver'),craft)).resolves.toBe(false);
    await expect(canReadExactOriginalQualityPhoto(f.db,actor('root_superuser'),{...craft,orderId:id(12)})).resolves.toBe(false);
    expect(f.lookup).toHaveBeenCalledTimes(1);
  });
});
