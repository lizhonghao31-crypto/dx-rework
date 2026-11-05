import {useNodeMaterialsView} from './node-materials-view.js';
import {NodeMaterialsPanel} from './node-materials-panel.js';
import {JourneySlaDetails} from "./journey-sla-details.js";
import {SeriesPlanPanel} from './series-plan-panel.js';
import {CockpitDocuments} from "./cockpit-documents.js";
import {useEffect,useRef,useState,type ReactNode} from "react";
import {StatusBadge} from "@dx-rework/ui";
import {isJourneyPlanningNode,type JourneyNode,type OrderJourney,type JourneyBusinessDateGroup} from "@dx-rework/contracts/digital-production-journey";
import {PoDateSummary,PoOrderFacts} from "./po-delivery-dates.js";
import {CockpitPhoto} from "./cockpit-photo-preview.js";
import {CockpitOperationLog} from "./cockpit-operation-log.js";
import {CockpitNodeRows,CockpitRecordLink,cockpitNodeTone,cockpitNodeStatus,cockpitPerson} from "./cockpit-node-rows.js";
import {journeyDetailSelection,journeyTime,orderStatus,stageTimes,type CockpitContext} from "./digital-journey-cockpit-model.js";
import "./cockpit-detail.css";
import {CockpitBusinessProgress,businessProgressLabel} from "./cockpit-business-progress.js";
import {CockpitNodeDates} from './cockpit-node-dates.js';
import {CockpitDetailRisks} from './cockpit-detail-risks.js';
import {businessDateLabel,forecastBasisLabels} from './cockpit-business-dates.js';

function businessStageFact(order:OrderJourney,key:string){
  const legacy=order.display?.stages.find(stage=>stage.key===key);
  const business=order.businessProgress?.stages.find(stage=>stage.key===key);
  return legacy&&business?{...legacy,ratio:business.ratio,applicable:business.unknown?null:business.applicable,completed:business.unknown?null:business.completed,notApplicable:business.unknown===0&&business.applicable===0,risk:business.unknown?'unknown' as const:legacy.risk}:legacy;
}
const ratioLabel=(ratio:number|null|undefined)=>ratio===null||ratio===undefined?"进度资料待完善":`${(ratio===1?100:Math.min(99.9,Math.round(ratio*1000)/10)).toFixed(1)}%`;
function CompactDate({value}:{value:string}){return <span>{value}</span>;}
function StageRing({stage,index,fact,dates,selected,onSelect}:{stage:OrderJourney["stages"][number];index:number;fact:NonNullable<OrderJourney["display"]>["stages"][number]|undefined;dates?:JourneyBusinessDateGroup|undefined;selected:boolean;onSelect:()=>void}){
  const started=stage.nodes.some(node=>!isJourneyPlanningNode(node)&&(Boolean(node.enteredAt)||["active","completed","inherited"].includes(node.state)));
  const color=fact?.risk==="overdue"?"#d83145":fact?.risk==="due_soon"?"#b57b00":!fact||fact.risk==="unknown"||fact.notApplicable||!started?"#8a9ab2":"#00a981";
  const times=stageTimes(stage),actual=ratioLabel(fact?.ratio);
  const risk=fact?.risk==="overdue"?"逾期":fact?.risk==="due_soon"?"临期":!fact||fact.risk==="unknown"?"待核实":fact.notApplicable?"不适用":fact.ratio===1?"已完成":started?"正常":"未启动";
  return <div className={`cockpit-stage${selected?" is-selected":""}`}>
    <button type="button" aria-pressed={selected} className="cockpit-stage-select" data-cockpit-focus={"stage:"+stage.key} aria-label={`${stage.label}节点明细；业务完成进度 ${actual}；时效 ${risk}`} onClick={onSelect}>
      <span className="cockpit-stage-rings"><svg viewBox="0 0 104 104" aria-hidden="true"><circle cx="52" cy="52" r="46" fill="none" stroke={color} strokeOpacity=".22" strokeWidth="7"/><circle cx="52" cy="52" r="35" fill="none" stroke="#ecf0f5" strokeWidth="7"/>{fact?.ratio!==null&&fact?.ratio!==undefined&&<circle cx="52" cy="52" r="35" fill="none" stroke={color} strokeWidth="7" pathLength="100" strokeDasharray={`${fact.ratio*100} 100`} transform="rotate(-90 52 52)"/>}<text x="52" y="61" textAnchor="middle" fill={color} fontSize="30" fontWeight="700">{index+1}</text></svg>{fact?.ratio===1&&!fact.notApplicable&&<span className="cockpit-stage-check" aria-label="已完成">✓</span>}</span>
      <strong>{stage.label}{fact?.notApplicable?<small>不适用</small>:null}</strong>
      <small className="cockpit-stage-state">{risk} · 实际 {actual}</small>
    </button>
    <details data-cockpit-disclosure={"stage-dates:"+stage.key}><summary>阶段日期与依据</summary><div className={`cockpit-stage-dates${dates?" has-business-dates":""}`}>{dates?.adoptedPlan.status!=='not_applicable'&&<div><span>{dates?'采用计划：':'节点目标：'}</span><CompactDate value={dates?businessDateLabel(dates.adoptedPlan,'plan'):times.expected}/></div>}<div><span>实际：</span><CompactDate value={dates?businessDateLabel(dates.actual,'actual'):times.actual}/></div>{dates&&!(dates.forecast.bases.length===1&&dates.forecast.bases[0]==='actual')&&<div><span>预计：</span><CompactDate value={businessDateLabel(dates.forecast,'forecast')}/><small>{dates.forecast.bases.map(basis=>forecastBasisLabels[basis]).join(' / ')}</small></div>}</div></details>
  </div>;
}
function revealNode(id:string){
  const row=document.getElementById(`journey-node-${id}`),viewport=row?.closest<HTMLElement>(".journey-node-viewport");if(!row||!viewport)return;const target=row.getBoundingClientRect(),bounds=viewport.getBoundingClientRect(),header=viewport.querySelector("thead")?.getBoundingClientRect().height??0;if(target.top<bounds.top+header||target.bottom>bounds.bottom)viewport.scrollTop+=target.top-bounds.top-header;
}
export function CockpitDetail({order,context,onChange,asOf,actions,busy=false,onPlanCommitted}:{order:OrderJourney;context:CockpitContext;onChange:(patch:Partial<CockpitContext>)=>void;asOf:string|undefined;actions:ReactNode;busy?:boolean;onPlanCommitted?:(()=>void)|undefined}){
  const [nodeFilter,setNodeFilter]=useState(context.nodeView??"all");
  useEffect(()=>setNodeFilter(context.nodeView??"all"),[order.id,context.nodeView]);
  const nodes=order.stages.flatMap(stage=>stage.nodes),selection=journeyDetailSelection(order,context),selected=selection.selected;
  const materials=useNodeMaterialsView(order,selected??null,context,onChange);
  const revealedRow=useRef<HTMLElement|null>(null);
  useEffect(()=>{const id=context.row??context.focus;if(!id){revealedRow.current=null;return;}const frame=requestAnimationFrame(()=>{const row=document.getElementById(`journey-node-${id}`);if(row&&row!==revealedRow.current){revealNode(id);revealedRow.current=row;}});return()=>cancelAnimationFrame(frame);},[order,context.focus,context.row,context.expanded,nodeFilter]);
  const rounds=[...new Set(nodes.filter(node=>node.stage==="development"&&node.round).map(node=>node.round!))].sort((a,b)=>b-a);
  const focus=(node:JourneyNode,fromRisk=false)=>{setNodeFilter("all");onChange({nodeView:'all',expanded:node.stage,focus:node.instanceId,row:node.instanceId,...(fromRisk?{round:node.stage==="development"?node.round??undefined:undefined}:{})});requestAnimationFrame(()=>revealNode(node.instanceId));};
  const matches=(node:JourneyNode,key:string)=>key==="all"||key==="completed"&&["completed","inherited"].includes(node.state)||key==="active"&&["active","blocked"].includes(node.state)||key==="not_started"&&["uncreated","pending"].includes(node.state)||key==="overdue"&&node.risks.includes("overdue");
  const filters=[{key:"all",label:"全部节点"},{key:"completed",label:"已完成"},{key:"active",label:"进行中"},{key:"not_started",label:"未开始"},{key:"overdue",label:"逾期"}];
  const primary=selected?.records.find(record=>record.mode==="handle"&&record.domain==="task")??selected?.records.find(record=>record.mode==="handle");
  const read=selected?.records.find(record=>record.mode==="read"&&record.url&&record.domain==="task")??selected?.records.find(record=>record.mode==="read"&&record.url);
  const flow=(order.flowStages??order.stages).map(stage=>{if(stage.key!=="creation")return stage;const nodes=stage.nodes.filter(node=>node.key===(order.orderId?"order_information":"product_development"));return {...stage,nodes,state:nodes[0]?.state??"unavailable" as const};});
  const roundSelector=order.sourceId&&rounds.length>1&&<label className="cockpit-round-select">查看开发轮次<select aria-label="开发轮次" value={context.round??order.selectedRound??rounds[0]} onChange={event=>onChange({round:Number(event.target.value),expanded:"development",focus:undefined,row:undefined})}>{rounds.map(round=><option key={round} value={round}>第 {round} 轮{round===order.adoptedRound?" · 大货采用":""}</option>)}</select></label>;
  return <section className="journey-detail journey-golden cockpit-detail" aria-label="订单全景详情">
    <div className="cockpit-detail-toolbar"><div><button type="button" className="journey-text-action" onClick={()=>onChange({selected:undefined,expanded:undefined,focus:undefined,row:undefined,round:undefined})}>‹ 生产管理总览</button><span> › 订单详情</span></div><div>{asOf&&<span className="journey-muted">数据时点：{journeyTime(asOf)}</span>}{actions}</div></div>
    <section className="dx-production-panel cockpit-detail-identity"><CockpitPhoto src={order.styleImageUrl} label={order.designStyleNo} className="cockpit-detail-photo"/><div><div className="cockpit-identity-heading"><h1>{order.designStyleNo}<span className={`cockpit-order-state is-${order.display?.mainState??"unknown"}`}>{order.display?orderStatus(order):"状态资料暂不可用"}</span></h1>{roundSelector}</div><div className="cockpit-identity-facts"><span>客户：{order.customer??"未登记"}</span><span>订单类型：{order.orderId?"大货订单":"产品开发"}</span><span>跟单：{order.merchandisers.map(person=>person.name??"姓名未登记").join(" / ")||"未指派"}</span><span>下单总数：{order.orderId?order.lines.reduce((sum,line)=>sum+line.orderedQuantity,0).toLocaleString():"未下单"}</span>{order.styleName&&<span>款名：{order.styleName}</span>}{order.identity?<span>订单号：{order.identity.businessNumber??order.identity.reason}</span>:order.orderNumbers.length>0&&<span>母单编号：{order.orderNumbers.join(" / ")}</span>}<span>创建日期：{journeyTime(order.createdAt)}</span><PoDateSummary lines={order.poDeliveryDates??[]}/><span>资料版本：开发 {order.sourceVersion===null?"未登记":`v${order.sourceVersion}`} · 制单 {order.instructionVersion===null?"未发布":`v${order.instructionVersion}`}</span></div><PoOrderFacts order={order}/></div></section>
    {order.businessProgress&&<section className="dx-production-panel cockpit-order-progress"><CockpitBusinessProgress order={order} compact/></section>}
    <section className="dx-production-panel cockpit-flow-panel" aria-label="订单全流程"><div className="journey-section-title"><h2>{order.orderId?"订单全流程进度":"开发阶段进度"} <strong>{order.businessProgress?businessProgressLabel(order.businessProgress):order.display?.actualLabel??"进度资料暂不可用"}</strong></h2></div>{order.display?.awaitingClosure&&<p>节点已完成，待业务收口。</p>}<div className="cockpit-flow-scroll"><div className="cockpit-stages">{flow.map((stage,index)=><StageRing key={stage.key} stage={stage} index={index} fact={businessStageFact(order,stage.key)} dates={order.businessProgress?.dates?.stages.find(value=>value.key===stage.key)} selected={selection.stages.includes(stage.key)} onSelect={()=>{setNodeFilter("all");onChange({nodeView:'all',expanded:stage.key,focus:undefined,row:undefined});}}/>)}</div></div></section>
    <details className="dx-production-panel cockpit-plan-area" data-cockpit-disclosure="plans"><summary>计划与时效</summary>    {order.orderId&&order.seriesPlanVisible&&<SeriesPlanPanel key={order.orderId} orderId={order.orderId} onCommitted={onPlanCommitted}/>}
    <JourneySlaDetails order={order}/>
    </details>
    <div className="journey-three-columns cockpit-detail-columns"><div className="cockpit-main-work">
      <section className="dx-production-panel journey-current-panel" aria-label="当前节点详情"><div className="journey-section-title"><h2>当前节点详情：{selected?selected.label+(selected.subject?` · ${selected.subject}`:""):"暂无可见节点"}</h2>{selected&&<StatusBadge tone={cockpitNodeTone(selected)}>{cockpitNodeStatus(selected)}</StatusBadge>}</div>{selected?<><div className="cockpit-node-current"><dl><div><dt>负责人：</dt><dd>{selected.responsibilityRole?`${selected.responsibilityRole} · ${cockpitPerson(selected.owner,selected.ownerStatus)}`:cockpitPerson(selected.owner,selected.ownerStatus)}</dd></div><CockpitNodeDates node={selected} order={order}/><div><dt>实际完成：</dt><dd>{journeyTime(selected.actualDate??selected.actualAt,selected.actualDate?"date":"instant","—")}{(selected.actualAt||selected.actualDate)&&selected.actualQuality!=="verified"&&<small>原完成记录，时间待核</small>}</dd></div><div><dt>轮次 / 次数：</dt><dd>{selected.round??"—"} / {selected.occurrence??"—"}</dd></div><div><dt>实际操作者：</dt><dd>{selected.completionOperators?.length?selected.completionOperators.map(person=>cockpitPerson(person)).join(" / "):selected.operator?cockpitPerson(selected.operator):"尚无记录"}</dd></div></dl><div className="cockpit-node-primary" data-material-focus="primary">{primary?<CockpitRecordLink record={primary} context={materials.context} onNavigate={()=>materials.capture('primary')} disabled={busy}>进入该节点办理</CockpitRecordLink>:<><p className="journey-muted">{["completed","inherited","cancelled"].includes(selected.state)?"该节点已结束。":read?"可在原业务页查看该节点记录。":"办理与资料请从相关单据进入。"}</p>{read&&<CockpitRecordLink record={read} context={materials.context} onNavigate={()=>materials.capture('primary')} disabled={busy}>查看节点记录</CockpitRecordLink>}</>}</div></div>{selected.blockers.length>0&&<div className="cockpit-node-blockers">{selected.blockers.map((blocker,index)=><p key={blocker.key+index}>{blocker.label}</p>)}</div>}<NodeMaterialsPanel order={order} node={selected} control={materials} busy={busy}/></>:<p>当前没有可见节点。</p>}</section>
      <section className="dx-production-panel journey-node-panel" aria-label="小流程明细"><h2>{selection.stages.length?order.stages.filter(stage=>selection.stages.includes(stage.key)).map(stage=>stage.label).join("、"):"全部阶段"}：适用节点{context.round?` · 第 ${context.round} 轮`:""}</h2><div className="journey-node-tabs">{filters.map(filter=><button type="button" key={filter.key} data-cockpit-focus={'node-filter:'+filter.key} className={nodeFilter===filter.key?"is-selected":undefined} onClick={()=>{setNodeFilter(filter.key as typeof nodeFilter);onChange({nodeView:filter.key as typeof nodeFilter});}}>{filter.label}（{selection.nodes.filter(node=>matches(node,filter.key)).length}）</button>)}<button type="button" onClick={()=>{setNodeFilter("all");onChange({nodeView:'all',expanded:"",focus:undefined,row:undefined});}}>全部阶段</button></div><div className="journey-node-viewport" tabIndex={0} role="region" aria-label="节点明细，可横向和纵向滚动查看"><CockpitNodeRows nodes={selection.nodes.filter(node=>matches(node,nodeFilter))} selectedId={selected?.instanceId} context={context} asOf={asOf} onSelect={node=>focus(node)}/></div></section>
      </div><aside className="cockpit-side-work"><CockpitDetailRisks order={order} stages={selection.stages} context={context} asOf={asOf} onFocus={node=>focus(node,true)}/>
      <section className="dx-production-panel journey-documents-panel"><h2>相关单据</h2><CockpitDocuments order={order} context={context} onChange={onChange}/></section>
      </aside>
    </div>
    <CockpitOperationLog order={order}/>
  </section>;
}
