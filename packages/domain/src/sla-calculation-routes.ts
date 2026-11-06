import {DIGITAL_SLA_PARAMETERS,type DigitalSlaValues} from '@dx-rework/contracts/digital-sla';
import type {DevelopmentCycleValues} from '@dx-rework/contracts/digital-development-technical';
import type {CalculationAnchor,CalculationGraph,CalculationNode,SlaCalculationConditions,SlaCalculationSelection} from '@dx-rework/contracts/sla-calculation';

export type CalculationRouteInput={
 observationMode?:'example'|'instance';
 range:SlaCalculationSelection['range'];conditions:SlaCalculationConditions;
 values:DigitalSlaValues;unifiedSource:string;development:DevelopmentCycleValues;developmentSource:string;
 anchors:Record<string,CalculationAnchor>;
 preparationMinutes?:{draft:number;final:number;source:string};
 routeKinds?:string[];inheritedKinds?:string[];outputKind?:string;
 native?:Record<string,{startedAt?:string;completedAt?:string;minutes?:number|null;evidence:string;waitingFor?:string}>;
 requireContractReady?:boolean;
};
const catalog=new Map(DIGITAL_SLA_PARAMETERS.map(row=>[row.key,row]));
/** Code-owned route fragments. Selection never switches off native quality or execution guards. */
export function buildSlaCalculationRoute(input:CalculationRouteInput):CalculationGraph{
 if(input.range==='whole')return buildWholeCalculationRoute(input);
 const nodes:CalculationNode[]=[],anchors=structuredClone(input.anchors),c=input.conditions;
 const graph:CalculationGraph={observationMode:input.observationMode??'example',nodes,anchors,warningPercent:input.values.warning_ratio?.kind==='ratio'?input.values.warning_ratio.percent:70,stageBufferMinutes:input.values.stage_buffer?.kind==='buffer'?input.values.stage_buffer.minutes:0,endIds:[],rangeLabel:'',startLabel:'',endLabel:''};
 const add=(key:string,options:Partial<CalculationNode>={})=>{
  const row=catalog.get(key);if(!row)throw Error(`未定义的标准节点：${key}`);
  const value=input.values[key]!;
  if(value.kind==='ratio'||value.kind==='buffer')throw Error('比例和缓冲不是业务节点');
  const native=input.native?.[key];
  const node:CalculationNode={id:key,label:row.label,stage:row.stage,parameterKey:key,applicable:'yes',countsProgress:false,kind:value.kind,minutes:'minutes'in value?value.minutes:null,offsetDays:'days'in value?value.days:null,dependsOn:[],anchorKey:null,targetKey:null,includedIn:null,includedPosition:'start',calendar:'continuous',source:input.unifiedSource,binding:{group:'unified',key},...options};
  if(native){
   if(native.minutes!==undefined&&['duration','included','estimate'].includes(node.kind)){
    if(native.minutes===null){node.kind='unlimited';node.minutes=null;node.binding=null;}
    else node.minutes=native.minutes;
    node.source=native.evidence;
   }
   if(native.startedAt){const anchorKey=`native:${node.id}:start`;anchors[anchorKey]={precision:'instant',value:native.startedAt,source:native.evidence};node.anchorKey=anchorKey;}
   if(native.completedAt)node.completedAt={precision:'instant',value:native.completedAt,source:native.evidence};
   if(native.waitingFor)node.waitingFor=native.waitingFor;
  }
  nodes.push(node);return node;
 };
 const independent=(id:string,label:string,minutes:number,key:keyof DevelopmentCycleValues,anchorKey:string)=>{
  const node:CalculationNode={id,label,stage:2,parameterKey:id,applicable:'yes',countsProgress:false,kind:'duration',minutes,offsetDays:null,dependsOn:[],anchorKey,targetKey:null,includedIn:null,includedPosition:'start',calendar:'natural_days',source:input.developmentSource,binding:{group:'development',key},independent:true};nodes.push(node);return node;
 };
 const event=(id:string,label:string,stage:number,anchorKey:string)=>{
  const value=anchors[anchorKey];const node:CalculationNode={id,label,stage,parameterKey:id,applicable:'yes',countsProgress:false,kind:'unlimited',minutes:null,offsetDays:null,dependsOn:[],anchorKey,targetKey:null,includedIn:null,includedPosition:'start',calendar:'continuous',source:'原生就绪事件；无固定等待时长',binding:null,...(value?{completedAt:value}:{})};nodes.push(node);return node;
 };
 if(input.range==='development'){
  graph.rangeLabel='开发本轮标准窗口';graph.startLabel='本轮开发发布／实际适用节点起点';graph.endLabel=input.outputKind==='工艺布片'?'本次工艺成果':'本轮尾查';
  const allowed=input.routeKinds?new Set(input.routeKinds.map(k=>k==='development_material_recheck'?'development_materials':k)):null;
  let previous:string|null=null;
  const step=(key:string,options:Partial<CalculationNode>={})=>{
   if(allowed&&!allowed.has(key))return null;
   const n=add(key,{dependsOn:previous?[previous]:[],anchorKey:previous?null:'development_published',...options});previous=n.id;return n;
  };
  step('development_materials');step('development_pattern');step('development_cutting');
  if(c.pattern!=='internal')add('external_pattern',{anchorKey:'external_pattern_requested',applicable:c.pattern==='external'?'yes':'unknown',independent:true});
  if(c.craft!=='none'){
   const key=c.craft==='unknown'?'development_printing':`development_${c.craft}`;
   const craft=step(key,{applicable:c.craft==='unknown'?'unknown':'yes'});
   if(craft){craft.label+=c.craftExecution==='external'?'（外发）':c.craftExecution==='internal'?'（内部）':'（内外方式待核）';
    add('development_craft_dispatch',{kind:'included',includedIn:craft.id,anchorKey:null});
    add('development_craft_return',{kind:'included',includedIn:craft.id,includedPosition:'end',anchorKey:null});}
  }
  if(input.outputKind!=='工艺布片'){
   const sewing=step('development_sewing');if(sewing)add('development_sewing_transfer',{kind:'included',includedIn:sewing.id});
   if(c.washing!=='none'){
    step('development_pre_wash_check',{applicable:c.washing==='unknown'?'unknown':'yes'});
    const washing=step('development_washing',{applicable:c.washing==='unknown'?'unknown':'yes'});
    if(washing&&c.washing==='external'){washing.minutes=input.development.externalWashDays*1440;washing.binding={group:'development',key:'externalWashDays'};washing.source=input.developmentSource;washing.calendar='natural_days';}
    if(washing)add('development_washing_dispatch',{kind:'included',includedIn:washing.id,applicable:c.washing==='unknown'?'unknown':'yes'});
   }
   step('development_tail_check');
  }
  graph.endIds=previous?[previous]:['development_round_completion'];
  if(nodes.find(n=>!n.independent&&n.kind!=='included'))graph.startIds=[nodes.find(n=>!n.independent&&n.kind!=='included')!.id];
  if(!previous){const n=event('development_round_completion','本轮无新增完整开发路径，等待原成果采用／补做完成依据',2,'development_published');delete n.completedAt;}
  independent('development_cycle',c.developmentMode==='urgent'?'本轮批准加急内部周期':'本轮普通内部周期',(c.developmentMode==='urgent'?input.development.urgentDays:input.development.normalDays)*1440,c.developmentMode==='urgent'?'urgentDays':'normalDays','development_published');
  independent('final_comment_review','每份最终评语后的技术复核',input.development.sizeReviewHours*60,'sizeReviewHours','final_comment_recorded').calendar='continuous';
 }else if(input.range==='preparation'){
  graph.rangeLabel='产前纸样与面料准备分支';graph.startLabel='制单发布与主料实际到仓各自起点';graph.endLabel='准备分支汇合（不代表开裁许可）';
  add('bulk_pattern',{anchorKey:'instruction_published'});
  add('fabric_inspection',{anchorKey:'whole_fabric_arrived'});
  if(c.preshrink!=='no')add('warehouse_preshrink',{dependsOn:['fabric_inspection'],applicable:c.preshrink==='yes'?'yes':'unknown'});
  graph.endIds=['bulk_pattern',c.preshrink==='no'?'fabric_inspection':'warehouse_preshrink'];
  graph.startIds=['bulk_pattern','fabric_inspection'];
  if(c.preparation==='adopted'){
   const policy=input.preparationMinutes??{draft:1440,final:1440,source:'新采纳产前规则 · 两个独立24小时窗口'};
   for(const [id,label,minutes,key]of [['preparation_draft','制单草稿',policy.draft,'whole_fabric_arrived'],['preparation_final','正式制单',policy.final,'final_preparation_ready']] as const){
    nodes.push({id,label,stage:3,parameterKey:id,applicable:'yes',countsProgress:false,kind:'duration',minutes,offsetDays:null,dependsOn:[],anchorKey:key,targetKey:null,includedIn:null,includedPosition:'start',calendar:'continuous',source:policy.source,binding:null,independent:true});
   }
  }else add('production_sheet',{anchorKey:'customer_order_confirmed',applicable:c.preparation==='legacy'?'yes':'unknown',independent:true});
 }else if(input.range==='bulk_craft'){
  graph.rangeLabel='本批大货工艺与发裁片标准窗口';graph.startLabel=c.craft==='none'?'本批开裁完成':'本批发工艺';graph.endLabel='本批仓库发裁片（其它真实前置仍需满足）';
  let prior:string;
  if(c.craft==='none')prior=event('cutting_complete','本批真实开裁完成',4,'whole_cutting_completed').id;
  else{
   const key=c.craft==='unknown'?'bulk_printing':`bulk_${c.craft}`;
   add(key,{anchorKey:'cut_craft_dispatched',applicable:c.craft==='unknown'?'unknown':'yes'});
   add('bulk_qc',{dependsOn:[key],applicable:c.craft==='unknown'?'unknown':'yes'});prior='bulk_qc';
  }
  event('factory_selection_approved','选厂已获原批准',3,'sourcing_decided');
  graph.startIds=[c.craft==='none'?'cutting_complete':c.craft==='unknown'?'bulk_printing':`bulk_${c.craft}`];
  add('warehouse_dispatch',{dependsOn:[prior,'factory_selection_approved']});graph.endIds=['warehouse_dispatch'];
  if(input.requireContractReady){event('original_contract_ready','原发厂所需合同已就绪',3,'contract_pdf_ready');nodes.find(n=>n.id==='warehouse_dispatch')!.dependsOn.push('original_contract_ready');}
 }else if(input.range==='delivery'){
  graph.rangeLabel='工厂目标与回货、到仓质检、装箱';graph.startLabel='本批工厂完成／实际回货与到仓各自起点';graph.endLabel='本批合格装箱（即本系统出货）';
  add('factory_production',{targetKey:'factory_delivery_date',anchorKey:'factory_production_finished',independent:true});
  event('factory_finished','本 PO 实际工厂生产完成',6,'factory_production_finished');graph.startIds=['factory_finished'];
  add('ship_sample_advance',{targetKey:'customer_shipping_date',independent:true});add('order_shipping_reminder',{targetKey:'customer_shipping_date',independent:true});
  add('return_logistics',{anchorKey:'factory_return_dispatched',independent:true});
  event('garment_arrival','本批实际成衣到仓',7,'garment_arrived');
  add('garment_inspection',{dependsOn:['garment_arrival']});
  if(c.rework!=='no')add('garment_rework',{anchorKey:'rework_assignments_confirmed',applicable:c.rework==='yes'?'yes':'unknown',independent:true});
  // QC completion alone is not proof that the original packing prerequisites permit packing.
  event('packing_ready','本批原生装箱条件齐备',7,'original_packing_conditions_ready');
  add('garment_packing',{dependsOn:['packing_ready']});graph.endIds=['garment_packing'];
 }else{
  graph.rangeLabel='合同首次回签独立业务日历';graph.startLabel='首份成功就绪的合同 PDF';graph.endLabel='首次有效回签';
  nodes.push({id:'contract_return',label:'合同回签48业务小时（北京周日不计）',stage:3,parameterKey:'contract_return',applicable:'yes',countsProgress:false,kind:'duration',minutes:2880,offsetDays:null,dependsOn:[],anchorKey:'contract_pdf_ready',targetKey:null,includedIn:null,includedPosition:'start',calendar:'beijing_sunday_excluded',source:'合同原业务规则 · 0207/0265',binding:null});graph.endIds=['contract_return'];
 }
 return graph;
}

/** All applicable native windows share their original anchors. Event waits are never inferred as zero. */
function buildWholeCalculationRoute(input:CalculationRouteInput):CalculationGraph{
 const fragments=(['development','preparation','bulk_craft','delivery','contract'] as const).map(range=>buildSlaCalculationRoute({...input,range}));
 return combineWholeCalculationRoutes(input,fragments);
}

/** Native instance fragments retain their own frozen standards, scope and actual batch identities. */
export function combineWholeCalculationRoutes(input:CalculationRouteInput,fragments:CalculationGraph[]):CalculationGraph{
 const graph:CalculationGraph={...fragments[0]!,nodes:fragments.flatMap((g,i)=>g.nodes.map(n=>i===4?{...n,independent:true}:n)),anchors:Object.assign({},...fragments.map(g=>g.anchors)),endIds:[],startIds:[],rangeLabel:'适用全流程',startLabel:'订单、开发及生产各原生起点',endLabel:'适用任务完成与合格装箱（即本系统出货）'};
 const add=(key:string,dependsOn:string[]=[])=>{
  const row=catalog.get(key)!,value=input.values[key]!,native=input.native?.[key];
  if(value.kind==='ratio'||value.kind==='buffer')throw Error('全局策略不是流程节点');
  const anchorKey=native?.startedAt?`native:${key}:start`:row.startsAt;
  if(native?.startedAt)graph.anchors[anchorKey]={precision:'instant',value:native.startedAt,source:native.evidence};
  const completion=native?.completedAt?{precision:'instant' as const,value:native.completedAt,source:native.evidence}:graph.anchors[row.endsAt];
  const node:CalculationNode={id:key,label:row.label,stage:row.stage,parameterKey:key,applicable:'yes',countsProgress:false,kind:value.kind,minutes:'minutes'in value?value.minutes:null,offsetDays:'days'in value?value.days:null,dependsOn:native?.startedAt?[]:dependsOn,anchorKey:dependsOn.length&&!native?.startedAt?null:anchorKey,targetKey:null,includedIn:null,includedPosition:'start',calendar:'continuous',source:native?.evidence??input.unifiedSource,binding:{group:'unified',key},...(completion?{completedAt:completion}:{}),...(native?.waitingFor?{waitingFor:native.waitingFor}:{})};
  if(native?.minutes!==undefined&&['duration','estimate'].includes(node.kind)){node.minutes=native.minutes;if(native.minutes===null){node.kind='unlimited';node.binding=null;}}
  graph.nodes.push(node);return node;
 };
 add('order_creation');add('customer_confirmation',['order_creation']);
 for(const key of ['development_accessories','development_shipping','budget'])add(key);
 add('sourcing_ie');add('sourcing_selection',['sourcing_ie']);add('sourcing_approval',['sourcing_selection']);
 // Existing planned handoff: paper and the applicable fabric branch must both finish before cutting.
 const cutting=add('bulk_cutting',graph.nodes.filter(n=>n.parameterKey==='bulk_pattern'||n.parameterKey===(input.conditions.preshrink==='no'?'fabric_inspection':'warehouse_preshrink')).map(n=>n.id));
 // Actual receipt is a separate execution prerequisite; absence is unknown, not an instantaneous transfer.
 if(!input.native?.bulk_cutting?.startedAt)cutting.anchorKey='cutting_fabric_actually_received';
 for(const craft of graph.nodes.filter(n=>n.id.endsWith('cutting_complete')||['bulk_printing','bulk_embroidery','bulk_print_embroidery'].includes(n.parameterKey))){
  // A real partial batch can start before the rest of the whole-order cutting closes.
  const nativeStart=graph.observationMode==='instance'&&craft.anchorKey&&graph.anchors[craft.anchorKey]?.precision==='instant';
  if(!nativeStart)craft.dependsOn.push('bulk_cutting');
 }
 for(const key of ['warehouse_accessories','ship_sample','receiving_span'])add(key);
 // Independent contract/reminder/estimate windows remain visible but never become a newly invented gate.
 graph.endIds=[...new Set([...fragments.slice(0,4).flatMap(g=>g.endIds),'order_creation','customer_confirmation','development_accessories','development_shipping','budget','sourcing_approval','bulk_cutting','warehouse_accessories','ship_sample','receiving_span',...graph.nodes.filter(n=>n.parameterKey==='factory_finished'||n.parameterKey==='garment_inspection').map(n=>n.id)])];
 graph.startIds=graph.nodes.filter(n=>!n.independent&&!n.includedIn&&!n.dependsOn.length&&!['offset','order_date'].includes(n.kind)).map(n=>n.id);
 return graph;
}
