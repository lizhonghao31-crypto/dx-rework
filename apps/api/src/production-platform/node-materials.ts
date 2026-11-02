import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {NodeMaterial,NodeMaterials,JourneyNode,JourneyRecord,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {technicalArtifactIssues} from '@dx-rework/contracts/digital-development-technical';
import {preparationMaterialLabels,type PreparationMaterialKind} from '@dx-rework/contracts/production-readiness';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ProductionReadinessService} from './production-readiness-service.js';
import {productionReadiness,instructionTechnicalCurrent,styleLabelCuttingReason} from './production-readiness-repository.js';
import {DevelopmentTechnicalService} from './development-technical-service.js';
import {ProductionInstructionService} from './production-instruction-service.js';
import {DigitalBudgetService} from './budget-service.js';
import {QcProductionProgressService} from './qc-production-progress-service.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {OrderClosureService} from './order-closure-service.js';
import {BulkPreparationService} from './bulk-preparation-service.js';

const labels:Record<string,string>={development:'开发单及本轮资料',instruction:'大货制单',preparation:'产前物料及技术原单',task:'本节点办理记录',budget:'预算原单',quotation:'客户报价原单',sourcing:'外发申请与合同',cutting:'裁床及实裁记录',production:'生产原单',receiving:'真实回货与装箱原单',rework:'返工或本厂做尾原单','series-plan':'本单采用计划'};
const technicallyRelevant=new Set(['development_pattern','development_size_review','customer_sample','production_instruction','bulk_pattern','bulk_marker','cutting_gate','bulk_cutting']);
const preparationRelevant=new Set(['design_handover','material_investment','fabric_receipt','color_confirmation','accessories_ready','style_label_ready','production_instruction','bulk_pattern','bulk_marker','warehouse_preshrink','cutting_gate','bulk_cutting']);
const historical=(node:JourneyNode)=>!node.current||node.state==='inherited'||node.state==='completed'&&node.records.some(r=>r.domain==='task');
const record=(domain:string,id:string,url:string,version:number|null=null,lineId:string|null=null):JourneyRecord=>({domain,id,url,version,lineId,mode:'read'});

/** Bind only an already authorized Journey instance. No commands, adoption or source fallback writes. */
export async function readNodeMaterials(pool:Pool,db:PoolClient,actor:TrustedActorContext,order:OrderJourney,node:JourneyNode,asOf:string):Promise<NodeMaterials>{
 const rows:NodeMaterial[]=[],notices:string[]=[],old=historical(node),key=node.key.replace(/^series_/,'');
 let productionBasis:Awaited<ReturnType<typeof productionReadiness>>|null=null;
 const scope=node.subject??(node.round?`第 ${node.round} 轮`:'本节点范围');
 const add=(input:Partial<NodeMaterial>&Pick<NodeMaterial,'id'|'label'|'state'|'reason'>)=>{
  const owner=input.owner===undefined?node.owner:input.owner;
  const row:NodeMaterial={purpose:'reference',applicability:'optional',versionLabel:null,scope,role:node.responsibilityRole??'责任岗位待核',owner,mine:owner?.id===actor.actorId,
   when:['uncreated','pending'].includes(node.state)&&!node.enteredAt?'later':owner&&owner.id!==actor.actorId?'waiting_other':'now',expectedAt:node.expectedAt,expectedPrecision:node.expectedPrecision,effect:'information',records:[],...input};
  rows.push(row);return row;
 };
 const sourceRecords=(records:JourneyRecord[])=>records.filter(r=>r.url).map(r=>({...r,mode:'read' as const}));
 if(node.state==='not_applicable'){
  add({id:'not-applicable',label:node.label,state:'not_applicable',applicability:'not_applicable',reason:'原流程已判定本节点不适用；不产生补资料要求。'});
 }else if(old){
  notices.push('这里只显示当时留存的原记录；历史版本未留存的项目标为待核实。');
  for(const [i,r]of sourceRecords(node.records).entries())add({id:'history-'+i,label:labels[r.domain]??node.label,state:r.version===null?'unknown':'present',reason:r.version===null?'历史采用版本未完整留存，请查看原记录。':'查看本节点留存的原版本；不以当前上传版本替代。',versionLabel:r.version===null?null:`历史原单 v${r.version}`,records:[r]});
 }else{
  // These are the original action's constraints, not a second list of gates.
  for(const [i,b]of node.blockers.entries())add({id:'constraint-'+i,label:b.label,state:'missing',purpose:'input',applicability:'required',reason:'该事项来自原流程的前置要求，请由对应岗位在原页面处理。',role:b.key==='pattern_ready'?'技术部纸样师':b.key==='preshrink_ready'?'仓管':'前置责任岗位待核',owner:b.ownerId?{id:b.ownerId,name:node.owner?.id===b.ownerId?node.owner.name:null}:null,effect:'original_gate',records:b.record?sourceRecords([b.record]):[]});
  if(preparationRelevant.has(key)&&(order.orderId||order.sourceId)){
   const resource=order.orderId?{kind:'order' as const,id:order.orderId}:{kind:'source' as const,id:order.sourceId!};
   const readiness=await new ProductionReadinessService(pool).read(actor,resource,db);
   const url=order.orderId?`/ui/digital-production?bulk=${order.orderId}`:`/ui/digital-production?development=${order.sourceId}`;
   const wanted:PreparationMaterialKind[]=key==='style_label_ready'?[]:key in preparationMaterialLabels?[key as PreparationMaterialKind]:key==='production_instruction'?['fabric_receipt']:['bulk_pattern','bulk_marker'].includes(key)?['fabric_receipt','accessories_ready']:key==='warehouse_preshrink'?['fabric_receipt']:['fabric_receipt','accessories_ready'];
   for(const kind of wanted){
    const fact=readiness.facts.find(f=>f.kind===kind&&f.scopeRef==='whole'),warehouse=['fabric_receipt','accessories_ready','style_label_ready'].includes(kind);
    const ownerId=warehouse?readiness.responsibility.warehouseWorkerId:kind==='color_confirmation'?readiness.responsibility.colorConfirmationWorkerId:kind==='material_investment'?order.merchandisers[0]?.id??null:null;
    add({id:'material-'+kind,label:preparationMaterialLabels[kind],purpose:'input',applicability:readiness.enrolled?'required':'optional',state:!readiness.enrolled&&!fact?'unknown':!fact?'missing':!fact.valid?'stale':fact.state==='ready'?'effective':fact.state==='partial'?'partial':'unknown',
     reason:fact?fact.invalidReasons.length?fact.invalidReasons.join('；'):['unknown','withdrawn'].includes(fact.state)?'当前记录已改为未知或撤回；旧凭证仍可在历史中查看。':fact.state==='partial'?'本次只部分具备；可先做的范围仍沿原办理规则。':fact.note:readiness.enrolled?'尚无本节点范围的实际记录。':'历史单未自动采用新资料规则，现有依据待核。',
     expectedAt:order.stages.flatMap(s=>s.nodes).find(n=>n.current&&n.key==='series_'+kind)?.expectedAt??null,expectedPrecision:order.stages.flatMap(s=>s.nodes).find(n=>n.current&&n.key==='series_'+kind)?.expectedPrecision??'missing',role:warehouse?'仓管':kind==='design_handover'?'设计师':kind==='material_investment'?'订单跟单':node.responsibilityRole??'对色确认岗位',owner:ownerId?{id:ownerId,name:node.owner?.id===ownerId?node.owner.name:null}:kind==='design_handover'?node.owner:null,
     versionLabel:fact?`物料记录 v${fact.version}`:null,records:[record('preparation',resource.id,url+`&materialKind=${kind}`,fact?.version??null)]});
   }
   if(order.orderId){
    const current=productionBasis=await productionReadiness(db,order.orderId);
    if(['production_instruction','warehouse_preshrink','cutting_gate','bulk_cutting'].includes(key))add({id:'fabric-quality',label:'验布及有效使用依据',purpose:'input',applicability:readiness.enrolled?'required':'optional',state:current.fabric.usable?'effective':current.fabric.report?'present':'unknown',reason:current.fabric.usable?'沿原验布/使用决定核验；不合格仍继续计时。':'尚无有效允许使用依据；历史报告存在不等于当前主料可用。',role:'仓管（验布资料）',owner:readiness.responsibility.warehouseWorkerId?{id:readiness.responsibility.warehouseWorkerId,name:null}:null,expectedAt:null,expectedPrecision:'missing',records:[record('preparation',order.orderId,url)]});
    if(key==='production_instruction'){
     const sheet=await new ProductionInstructionService(pool,false).read(actor,order.orderId,db);
     const published=sheet.publishedVersion,currentBasis=published?await instructionTechnicalCurrent(db,order.orderId,published,readiness.technicalRevision):false;
     add({id:'instruction-prerequisites',label:'本次正式制单发布依据',purpose:'input',applicability:readiness.enrolled?'required':'optional',state:!readiness.enrolled?'unknown':current.finalReasons.length?current.technical?.artifactRef?'stale':'missing':'effective',reason:readiness.enrolled?current.finalReasons.join('；')||'原发布前提已具备；预算不是制单发布前置。':'历史单保留原采用规则，不自动套新前置。',role:'订单跟单',owner:order.merchandisers[0]??null,expectedAt:readiness.finalWindow.dueAt,expectedPrecision:readiness.finalWindow.dueAt?'instant':'missing',versionLabel:current.technical?.artifactRef?`技术成果 v${current.technical.artifactRef.version}`:null,records:[record('instruction',order.orderId,`/ui/digital-production?instruction=${order.orderId}`)]});
     add({id:'instruction-output',label:'大货制单原件',purpose:'output',applicability:'required',state:published?currentBasis?'effective':'stale':sheet.version?'present':'missing',reason:published?currentBasis?'原发布版可查看；交付按原记录核实。':'已有发布原件，当前技术依据已变化，请在原制单页复核。':sheet.version?'已存草稿，尚未发布；不把草稿当最终制单。':'尚未保存制单草稿。',role:'订单跟单',owner:order.merchandisers[0]??null,versionLabel:published?`已发布 v${published}`:sheet.version?`草稿 v${sheet.version}`:null,records:[record('instruction',order.orderId,`/ui/digital-production?instruction=${order.orderId}${published?`&instructionVersion=${published}`:''}`,published??null)]});
     const delivery=readiness.instructionDeliveries.filter(d=>d.instructionVersion===published).at(-1);
     add({id:'instruction-delivery',label:'对外厂交付记录',purpose:'output',applicability:'required',state:delivery?'present':'missing',reason:delivery?'已有对应该发布版的真实交付记录；从原制单/产前资料页查看。':published?'本次发布版尚无交付记录，请订单跟单按实际交付补录。':'先准备制单；最终发布后按实际交付登记，不提前造交付时间。',role:'订单跟单',owner:order.merchandisers[0]??null,when:published?'now':'later',expectedAt:null,expectedPrecision:'missing',versionLabel:delivery?`已交付制单 v${delivery.instructionVersion}`:null,records:[record('preparation',order.orderId,url,published??null)]});
    }
    if(['bulk_pattern','bulk_marker'].includes(key)){
     const prep=await new BulkPreparationService(pool).read(actor,order.orderId,db),visible=new Set(order.lines.map(l=>l.id));
     for(const range of readiness.ranges.filter(r=>r.preparationId===prep.preparationId&&r.kind===(key==='bulk_marker'?'唛架完成':'纸样完成')&&r.lineIds.every(id=>visible.has(id))))add({id:'range-'+range.rangeId,label:range.complete?'本次完整范围成果':'已做的局部范围',purpose:'output',state:range.complete?'present':'partial',reason:range.note+(range.complete?'；有效性仍沿原范围核验。':`；仍待 ${range.pendingMaterialIds.length} 项物料，不表示整单已齐套。`),versionLabel:`范围 v${range.version}`,scope:order.lines.filter(l=>range.lineIds.includes(l.id)).map(l=>l.color).join('／')||scope,records:[record('preparation',order.orderId,url,range.version)]});
    }
    if(['style_label_ready','cutting_gate','bulk_cutting'].includes(key))for(const line of order.lines){const why=await styleLabelCuttingReason(db,order.orderId,[line.id]),labelFact=readiness.facts.find(f=>f.kind==='style_label_ready'&&f.scopeRef==='whole');add({id:'style-label-'+line.id,label:'款号唛实物',purpose:'input',applicability:readiness.enrolled?'required':'optional',state:!readiness.enrolled?'unknown':why?'missing':'effective',reason:why??'本款色的整单准备量已具备；实际开裁仍按原单具体范围核验。',versionLabel:labelFact?`款号唛记录 v${labelFact.version}`:null,scope:`${line.po??'未补 PO'} · ${line.color}`,role:'仓管',owner:readiness.responsibility.warehouseWorkerId?{id:readiness.responsibility.warehouseWorkerId,name:null}:null,records:[record('preparation',order.orderId,url+'&materialKind=style_label_ready',null,line.id)]});}
   }
  }
  if(technicallyRelevant.has(key)&&order.sourceId&&await new DigitalProductionAccessPolicy(db).allowed(actor,'source',order.sourceId,'technical')){
   const reviewTask=key==='development_size_review'?node.records.find(r=>r.domain==='task'):undefined;
   const reviewScope=reviewTask?(await db.query('SELECT scope_ref FROM digital_development_size_review_requests WHERE task_id=$1 AND source_id=$2 AND round_number=$3',[reviewTask.id,order.sourceId,node.round])).rows[0]?.scope_ref as string|undefined:undefined;
   if(key==='development_size_review'&&!reviewScope)add({id:'technical-basis',label:'本次客户最终评语与尺寸复核范围',purpose:'input',state:'unknown',reason:'尚无可核实的本次复核范围，不用整款结果代替。',role:'技术部纸样师',owner:node.owner,records:sourceRecords(node.records)});
   else{
   // Current bulk input truth follows the same current document as the native publish guard.
   // A historical developer view or the last instruction's old round is not a new adoption.
   const currentDocument=key.startsWith('development_')?null:order.orderId?(productionBasis??await productionReadiness(db,order.orderId)).document:await developmentDocumentRow(db,order.sourceId);
   const round=key.startsWith('development_')?node.round??order.selectedRound??1:currentDocument?.round_number??1;
   const technical=await new DevelopmentTechnicalService(pool,false).read(actor,order.sourceId,round,reviewScope??'整款',db),basis=technical.effective;
   const ref=basis?.artifactRef,artifact=ref?technical.artifacts.find(a=>a.artifactSetId===ref.id&&a.version===ref.version):undefined;
   const reviewer=technical.reviews.find(r=>r.reviewId===basis?.reviewRef?.id)?.assigneeId??null;
   const technicalUrl=`/ui/digital-production?development=${order.sourceId}&round=${round}`;
   const technicalRefs=reviewTask?sourceRecords([reviewTask]):[record('development',order.sourceId,technicalUrl,artifact?.version??null)],reviewLine=reviewScope?.startsWith('po:')?order.lines.find(l=>l.id===reviewScope.slice(3)):undefined;
   const finalNeeded=key!=='development_pattern';
   const state=technical.enrolled?artifact?finalNeeded?basis?.state==='effective'?'effective':['pending_review','superseded'].includes(basis?.state??'')?'stale':'present':'present':'missing':'unknown';
   add({id:'technical-basis',label:finalNeeded?'客户最终评语与大货尺寸复核':'纸样三件套：PLT、结构用量、基码尺寸表',purpose:'input',applicability:technical.enrolled?'required':'optional',state,
    reason:!technical.enrolled?'历史技术采用依据未完整留存，请查看原单。':!artifact?'该范围尚无已发布技术成果，请从本次原任务核对客户评语及复核。':basis?.state==='effective'?'客户最终评语、本次尺寸复核和采用的技术版本一致。':finalNeeded&&['pending_review','superseded'].includes(basis?.state??'')?'原技术成果仍在；客户最终评语或技术依据已变化，旧版待本次复核。':finalNeeded?'已有技术成果，仍待原客户/技术流程确认。':'已有发布成果；纸样完成按原三件套校验，不以客户最终批复阻止先做纸样。',role:'技术部纸样师',owner:reviewer?{id:reviewer,name:null}:['development_pattern','development_size_review'].includes(key)?node.owner:null,versionLabel:artifact?`成果 v${artifact.version}${basis?.finalCommentRef?`／最终评语 v${basis.finalCommentRef.version}`:''}`:basis?.finalCommentRef?`最终评语 v${basis.finalCommentRef.version}（该范围成果待核）`:null,scope:reviewScope?.startsWith('po:')?reviewLine?`${reviewLine.po??'未补 PO'} · ${reviewLine.color}`:'本次 PO 复核范围（款色信息按原权限查看）':scope,records:technicalRefs});
   if(key==='development_pattern'){
    const issues=artifact?technicalArtifactIssues(artifact.body):[];
    for(const [part,label,present] of [['plt','PLT纸样原件',Boolean(artifact?.body.pltAttachmentIds.length)],['consumption','结构单件用量',Boolean(artifact?.body.consumptionRows.length)],['sizes','本轮基码尺寸表',Boolean(artifact?.body.baseSizeTable.measurements.length)]] as const)add({id:'paper-'+part,label,purpose:'output',applicability:'required',state:!technical.enrolled?'unknown':!present?'missing':artifact?.status==='published'&&!issues.length?'present':'partial',reason:artifact?issues.join('；')||'已发布本轮三件套；实际完成与附件下载仍按原入口校验。':'创建开发单尺码可选填；纸样完成时由技术形成本轮三件套。',role:'技术部纸样师',owner:node.owner,versionLabel:artifact?`成果 v${artifact.version}`:null,records:[record('development',order.sourceId,technicalUrl,artifact?.version??null)]});
   }
   }
  }
  if(key==='budget'&&order.orderId){const budget=await new DigitalBudgetService(pool,false).read(actor,order.orderId,db);add({id:'budget',label:'跟单预算及已采用报价版本',purpose:'output',applicability:'required',state:budget.status==='published'?!budget.sourcingCaseId&&budget.comparison?.state==='review_required'?'stale':'effective':budget.document?'present':'missing',reason:budget.comparison?.state==='review_required'?budget.comparison?.reason??'客户报价已有新确认版，请沿原预算入口复核。':budget.status==='published'?'原预算发布版可查看；预算用于选厂参考，执行价格以老板批准的合同为准。':'请在原预算页核对客户已确认报价与预算总额，再按原规则发布。',role:'订单跟单',owner:order.merchandisers[0]??null,versionLabel:budget.version?`预算 v${budget.version}`:null,records:[record('budget',order.orderId,`/ui/digital-production?budget=${order.orderId}${budget.status==='published'?`&budgetVersion=${budget.version}`:''}`,budget.version||null)]});}
  if(key==='production_reporting'&&order.orderId){
   const qc=await new QcProductionProgressService(pool).read(actor,order.orderId,db);
   for(const execution of qc.executions)for(const line of execution.lines.filter(l=>order.lines.some(o=>o.id===l.lineId))){
    const progress=execution.records.find(r=>r.kind==='progress'&&r.observations.some(o=>o.lineId===line.lineId));
    const clock=execution.lineClocks.find(l=>l.lineId===line.lineId)?.clock;
    const photos=progress?new Set(execution.records.filter(r=>r.recordId===progress.recordId||r.relatedProgressRecordId===progress.recordId).flatMap(r=>r.attachmentIds)).size:0;
    add({id:`qc-${execution.productionId}-${execution.factoryDecisionId??'original'}-${line.lineId}`,label:'QC生产进度、适用产量与现场照片',purpose:'output',applicability:'required',state:progress?'present':clock?.state==='unknown'?'unknown':'missing',
     reason:(progress?`已有本款色进度及关联现场照片 ${photos} 张。`:'尚无本款色的有效进度，请由 QC 在原入口录入。')+(['due','escalated'].includes(clock?.state??'')?'原进度窗口已到更新时点。':'')+'照片不代替进度，进度与产量不代表成衣质检合格。',
     role:'QC',owner:qc.qcUserId?{id:qc.qcUserId,name:qc.qcName}:null,scope:`${execution.supplierName} · 厂单范围 ${qc.executions.indexOf(execution)+1} · ${line.quantity} 件 · ${line.poNumber??'未补 PO'} · ${line.color}`,expectedAt:clock?.remindAt??null,expectedPrecision:clock?.remindAt?'instant':'missing',versionLabel:progress?`进度记录 v${progress.revision}`:null,
     records:sourceRecords(node.records).map(r=>({...r,lineId:line.lineId,url:r.domain==='factory'&&r.url?r.url+'&line='+line.lineId+(execution.factoryDecisionId?'&factoryDecisionId='+execution.factoryDecisionId:''):r.url}))});
   }
  }
  if(['receipts','receiving_inspection','packing','quantity_difference'].includes(key)&&order.orderId){
   const closure=await new OrderClosureService(pool).read(actor,order.orderId,db),url=`/ui/digital-production?closure=${order.orderId}`;
   for(const line of closure.lines.filter(l=>order.lines.some(o=>o.id===l.lineId))){
    const lineScope=`${line.poNumber??'未补 PO'} · ${line.color}`,refs=[record('closure',order.orderId,url,null,line.lineId)];
    add({id:'receipts-'+line.lineId,label:'仓库真实回货数量',purpose:'input',applicability:'required',state:line.receiptCount?'present':'missing',reason:line.receiptCount?`原实收 ${line.actualQuantity} 件，单据 ${line.documentQuantity} 件；数量订正与差异沿原仓库规则。`:'尚无真实回货记录，不用工厂到料清点或进度照片代替。',role:'仓管',owner:null,scope:lineScope,records:refs,expectedAt:null,expectedPrecision:'missing'});
    if(key!=='receipts'){
     const checks=(closure.quality??[]).filter(q=>q.lineId===line.lineId),allChecked=checks.length>0&&checks.every(q=>q.inspected);
     add({id:'quality-'+line.lineId,label:'原成衣质检记录',purpose:'input',applicability:'required',state:allChecked?'present':checks.some(q=>q.priorInspection)?'stale':line.receiptCount?'missing':'unknown',reason:allChecked?'已有对应实收数量版本的原质检；可装数量及处理依据仍沿原规则，不把进度照片当合格。':'当前实收数量版本尚无完整原质检依据；原办理保留质量与数量校验。',role:'QC',owner:null,scope:lineScope,records:refs,expectedAt:null,expectedPrecision:'missing'});
    }
    if(key==='packing')add({id:'packing-'+line.lineId,label:'装箱及数量差异原记录',purpose:'output',applicability:'required',state:line.packingRevisionId?'present':'missing',reason:line.packingRevisionId?`原装箱 ${line.packingQuantity} 件。`+'责任判定、老板责任签字及财务不新增为装箱前提。':'尚无装箱实绩，请从原仓库入口办理；不等待责任签字或财务结算。',role:'仓管',owner:null,scope:lineScope,records:refs,expectedAt:null,expectedPrecision:'missing'});
   }
  }
  if(!rows.length)for(const [i,r]of sourceRecords(node.records).entries())add({id:'original-'+i,label:labels[r.domain]??node.label,state:node.state==='completed'?'present':'unknown',reason:node.state==='completed'?'原节点已有完成记录；资料内容和附件仍从原单查看，不以链接存在推断全部资料齐全。':'可进入原页面核对；链接本身不证明原件已存在、完整或有效。',versionLabel:r.version===null?null:`原记录 v${r.version}`,records:[r]});
 }
 if(!rows.length)notices.push('当前还没有可核实的资料，请打开本节点原单查看或补充。');
 const unique=[...new Map(rows.map(r=>[r.id,r])).values()];
 const unnamed=[...new Set(unique.flatMap(r=>r.owner&&!r.owner.name?[r.owner.id]:[]))];
 if(unnamed.length){const people=new Map<string,string>((await db.query('SELECT id,display_name FROM app_users WHERE id=ANY($1::uuid[])',[unnamed])).rows.map(r=>[r.id,r.display_name]));for(const row of unique)if(row.owner&&!row.owner.name)row.owner={...row.owner,name:people.get(row.owner.id)??null};}
 const revision=createHash('sha256').update(JSON.stringify({instance:node.instanceId,round:node.round,rows:unique})).digest('hex');
 return {ruleVersion:'node-materials-v1',journeyId:order.id,instanceId:node.instanceId,round:node.round,asOf,revision,historical:old,coverage:notices.length?'limited':'available',notice:notices.join('；')||'本页仅供核对资料；请从原办理入口补充和确认，是否能办理以原流程为准。',rows:unique};
}
