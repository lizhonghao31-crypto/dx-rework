import {createHash} from 'node:crypto';
import {isStyleLabelPieceUnit,type PreparationMaterialFact,type StyleLabelOccurrence,type StyleLabelRecordRef} from '@dx-rework/contracts/production-readiness';

export const STYLE_LABEL_RULE_VERSION=1;
export const styleLabelScope=(lineId:string|null)=>lineId===null?'whole':`po:${lineId}`;
type Requirement={lineId:string;quantity:number};
type LabelRecord=Pick<PreparationMaterialFact,'kind'|'valid'|'state'|'quantities'|'styleLabelOccurrences'> & StyleLabelRecordRef;
type LabelCheck={lineId:string;requiredQuantity:number;quantity:number|null;shortfall:number|null;status:'sufficient'|'insufficient'|'unknown';
 startedAt:string|null;completedAt:string|null;reason:string|null;record:StyleLabelRecordRef|null;completionRecord:StyleLabelRecordRef|null};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref=({recordId,version,resource,scopeRef,occurredAt}:StyleLabelRecordRef):StyleLabelRecordRef=>({recordId,version,resource,scopeRef,occurredAt});
const sameStream=(a:StyleLabelRecordRef,b:StyleLabelRecordRef)=>a.recordId===b.recordId&&a.scopeRef===b.scopeRef&&a.resource.kind===b.resource.kind&&a.resource.id===b.resource.id;
const recordVersion=(record:StyleLabelRecordRef)=>record.recordId+':'+record.version;
const trustTime=(at:string|null|undefined)=>at&&Number.isFinite(Date.parse(at))?new Date(at).toISOString():null;
const covers=(scopeRef:string,lineId:string)=>scopeRef===lineId||scopeRef===styleLabelScope(lineId);
const requirementFingerprint=(orderId:string,{lineId,quantity}:Requirement)=>hash([orderId,lineId,quantity]);
const requirementsFingerprint=(orderId:string,requirements:readonly Requirement[])=>hash([orderId,requirements.map(r=>[r.lineId,r.quantity]).sort()]);

/** Eligibility and sums are evaluated per current native record, never across versions or scopes. */
function indexedRecord(record:LabelRecord){
 const byLine=new Map<string,{sum:number;rows:string[]}>();
 for(const row of record.quantities){
  if(!row.lineId||!Number.isSafeInteger(row.quantity)||!isStyleLabelPieceUnit(row.unit))continue;
  const line=byLine.get(row.lineId)??{sum:0,rows:[]};
  line.sum+=row.quantity;
  line.rows.push(JSON.stringify([row.materialId,row.name,row.quantity,'枚']));
  byLine.set(row.lineId,line);
 }
 return {record,byLine};
}

function verifiedOccurrence(record:LabelRecord,orderId:string,requirement:Requirement,quantityFingerprint:string){
 const value=record.styleLabelOccurrences?.[requirement.lineId];
 if(value?.ruleVersion!==STYLE_LABEL_RULE_VERSION||value.orderId!==orderId||value.lineId!==requirement.lineId
  ||value.requiredQuantity!==requirement.quantity||value.requirementFingerprint!==requirementFingerprint(orderId,requirement)
  ||value.quantityFingerprint!==quantityFingerprint||!value.record||!sameStream(value.record,record)||value.record.version!==record.version
  ||trustTime(value.record.occurredAt)!==trustTime(record.occurredAt)||value.precision!=='instant'||!value.source
  ||!sameStream(value.source,record)||value.source.version>record.version||!trustTime(value.completedAt)
  ||trustTime(value.source.occurredAt)!==trustTime(value.completedAt))return null;
 return {completedAt:trustTime(value.completedAt)!,source:value.source};
}

/** Persist the proof on the new original record. An unchanged sufficient row from
 * an older record without server evidence cannot acquire a date from its sibling. */
export function deriveStyleLabelOccurrences(orderId:string,requirements:readonly Requirement[],next:LabelRecord,prior:LabelRecord|undefined){
 const current=indexedRecord(next),previous=prior?indexedRecord(prior):null;
 const occurrences:Record<string,StyleLabelOccurrence>={};
 const onlyTimeChanged=prior&&prior.state===next.state&&trustTime(prior.occurredAt)!==trustTime(next.occurredAt)
  &&hash([...current.byLine].map(([id,row])=>[id,row.rows.slice().sort()]).sort())===hash([...previous!.byLine].map(([id,row])=>[id,row.rows.slice().sort()]).sort());
 for(const requirement of requirements){
  const {lineId,quantity}=requirement,row=current.byLine.get(lineId);
  if(!next.valid||next.state!=='ready'||!row||row.sum<quantity)continue;
  const quantityFingerprint=hash(row.rows.slice().sort()),requirementHash=requirementFingerprint(orderId,requirement);
  const oldRow=previous?.byLine.get(lineId),oldHash=oldRow?hash(oldRow.rows.slice().sort()):null;
  const continuous=prior?.valid&&prior.state==='ready'&&sameStream(prior,next);
  const retained=continuous&&oldHash===quantityFingerprint?verifiedOccurrence(prior,orderId,requirement,quantityFingerprint):null;
  const scopedCorrection=onlyTimeChanged&&(requirements.length===1||covers(next.scopeRef,lineId));
  const provesNew=!continuous||oldHash!==quantityFingerprint&&(!oldRow||oldRow.sum<quantity)||scopedCorrection;
  const newTime=provesNew?trustTime(next.occurredAt):null;
  const oldTime=onlyTimeChanged?null:retained;
  const completedAt=newTime??oldTime?.completedAt??null;
  occurrences[lineId]={ruleVersion:STYLE_LABEL_RULE_VERSION,orderId,lineId,requiredQuantity:quantity,requirementFingerprint:requirementHash,quantityFingerprint,
   record:ref(next),completedAt,precision:completedAt?'instant':'unknown',source:newTime?ref(next):oldTime?.source??null,
   reason:completedAt?null:'本款色缺可核实的齐套时间，保留原登记与历史'};
 }
 return {styleLabelOccurrences:occurrences,styleLabelRequirementsBasis:{orderId,fingerprint:requirementsFingerprint(orderId,requirements)}};
}

export type StyleLabelRequest={kind:'po_preparation';lineId:string}|{kind:'whole_order_preparation'}|{kind:'actual_cut';lineId:string;requiredQuantity?:number};

export function evaluateStyleLabels(orderId:string,requirements:readonly Requirement[],materials:readonly LabelRecord[],requests:readonly StyleLabelRequest[],history:readonly LabelRecord[]=materials){
 const indexed=materials.filter(fact=>fact.kind==='style_label_ready').map(indexedRecord);
 const validOrigins=new Map(history.filter(row=>row.kind==='style_label_ready'&&row.valid&&row.state==='ready').map(row=>[recordVersion(row),row]));
 const firstTime=(values:(string|null)[])=>values.filter((value):value is string=>value!==null).sort()[0]??null;
 const byLine=new Map(requirements.map(row=>[row.lineId,row]));
 const check=(lineId:string,requiredQuantity:number,preparation:boolean):LabelCheck=>{
  const candidates=indexed.filter(({record,byLine})=>record.valid&&record.state==='ready'&&byLine.has(lineId))
   .map(({record,byLine})=>{
    const row=byLine.get(lineId)!;
    const proof=preparation&&row.sum>=requiredQuantity
     ?verifiedOccurrence(record,orderId,{lineId,quantity:requiredQuantity},hash(row.rows.slice().sort())):null;
    const origin=proof&&validOrigins.get(recordVersion(proof.source));
    return {record,quantity:row.sum,proof:proof&&origin&&sameStream(origin,proof.source)&&trustTime(origin.occurredAt)===proof.completedAt?proof:null};
   });
  const best=candidates.sort((a,b)=>Number(b.quantity>=requiredQuantity)-Number(a.quantity>=requiredQuantity)
   ||Number(Boolean(b.proof))-Number(Boolean(a.proof))||(a.proof?.completedAt??'').localeCompare(b.proof?.completedAt??'')||b.quantity-a.quantity)[0];
  const startedAt=firstTime(indexed.filter(({record,byLine})=>record.valid&&['ready','partial'].includes(record.state)
   &&(byLine.has(lineId)||covers(record.scopeRef,lineId))).map(({record})=>trustTime(record.occurredAt)));
  const original=best?.record??indexed.find(({record,byLine})=>byLine.has(lineId)||covers(record.scopeRef,lineId))?.record;
  const status=!best?'unknown':best.quantity>=requiredQuantity?'sufficient':'insufficient';
  return {lineId,requiredQuantity,quantity:best?.quantity??null,shortfall:best?Math.max(0,requiredQuantity-best.quantity):null,status,startedAt,
   completedAt:best?.proof?.completedAt??null,record:original?ref(original):null,completionRecord:best?.proof?.source??null,
   reason:status==='unknown'?'本款色没有有效的款号唛数量依据':status==='insufficient'?`款号唛还缺 ${requiredQuantity-best!.quantity} 枚`:!best?.proof?'本款色缺可核实的齐套时间，保留原登记与历史':null};
 };
 const lines=new Map(requirements.map(row=>[row.lineId,check(row.lineId,row.quantity,true)]));
 const rows=[...lines.values()],sufficient=rows.length>0&&rows.every(row=>row.status==='sufficient');
 const completedAt=sufficient&&rows.every(row=>row.completedAt)?rows.map(row=>row.completedAt!).sort().at(-1)!:null;
 const whole={sufficient,completedAt,startedAt:firstTime([...rows.map(row=>row.startedAt),...indexed.filter(({record})=>record.scopeRef==='whole'&&record.valid&&['ready','partial'].includes(record.state)).map(({record})=>trustTime(record.occurredAt))]),
  reason:sufficient?completedAt?null:'有款色缺可核实的齐套时间':'尚未证实当前全部 PO 的款号唛齐套',
  records:rows.flatMap(row=>row.record?[row.record]:[]),completionRecords:rows.flatMap(row=>row.completionRecord?[row.completionRecord]:[])};
 const result=requests.map(request=>request.kind==='whole_order_preparation'?whole:request.kind==='po_preparation'?lines.get(request.lineId)??null
  :check(request.lineId,request.requiredQuantity??byLine.get(request.lineId)?.quantity??1,false));
 return {orderId,ruleVersion:STYLE_LABEL_RULE_VERSION,requirementsRevision:requirementsFingerprint(orderId,requirements),
  evidenceRevision:hash({
   current:indexed.map(({record,byLine})=>[ref(record),record.state,record.valid,[...byLine].map(([id,row])=>[id,row.rows.slice().sort()]).sort()]).sort(),
   completions:rows.map(row=>[row.lineId,row.completedAt,row.completionRecord]).sort(),
  }),lines,whole,result};
}
