import {selectCockpitWashingWindow} from './washing-window-target.js';
import {CockpitMilestoneFlow,cockpitMilestones,milestoneContains} from './cockpit-milestones.js';
import {CockpitFrameworkNodes,CockpitPlanDates} from './cockpit-framework-nodes.js';
import {CockpitDurationSummary,CockpitActualDates,useScheduleObservation} from './cockpit-fixed-schedule.js';
import {useNodeMaterialsView} from './node-materials-view.js';
import {NodeMaterialsPanel} from './node-materials-panel.js';
import {CockpitDocuments} from "./cockpit-documents.js";
import {useEffect,useRef,useState,type ReactNode} from "react";
import {CockpitBadge,CockpitStack} from './cockpit-astryx.js';
import {type JourneyNode,type OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {PoOrderFacts} from "./po-delivery-dates.js";
import {CockpitPhoto} from "./cockpit-photo-preview.js";
import {CockpitOperationLog} from "./cockpit-operation-log.js";
import {CockpitNodeRows,CockpitRecordLink,cockpitNodeTone,cockpitNodeStatus,cockpitPerson,cockpitVisibleBlockers} from "./cockpit-node-rows.js";
import {cockpitDetailNodes,journeyDetailSelection,journeyTime,orderStatus,nodeIsInProgress,nodeIsTerminated,type CockpitContext} from "./digital-journey-cockpit-model.js";
import "./cockpit-detail.css";
import './cockpit-detail-r5.css';
import {CockpitDate} from './cockpit-date.js';
import {CockpitNodeDates} from './cockpit-node-dates.js';
import {CockpitDetailRisks} from './cockpit-detail-risks.js';
import {CockpitStageProgress} from './cockpit-stage-progress.js';

import {CockpitCurrentSummary} from './cockpit-current-summary.js';
import {CockpitHomeDialog} from './cockpit-home-dialog.js';
import {lazyBusinessPage} from './lazy-business-page.js';
const CockpitPersonnel=lazyBusinessPage(()=>import('./digital-cockpit-personnel.js').then(module=>({default:module.DigitalCockpitPersonnel})),{shellOnError:false});
function revealNode(id:string){
  const row=document.getElementById(`journey-node-${id}`),viewport=row?.closest<HTMLElement>(".journey-node-viewport");if(!row||!viewport)return;const target=row.getBoundingClientRect(),bounds=viewport.getBoundingClientRect(),header=viewport.querySelector("thead")?.getBoundingClientRect().height??0;if(target.top<bounds.top+header||target.bottom>bounds.bottom)viewport.scrollTop+=target.top-bounds.top-header;
}
export function CockpitDetail({order,context,onChange,asOf,actions,busy=false,onPlanCommitted,restoreReading=false}:{order:OrderJourney;context:CockpitContext;onChange:(patch:Partial<CockpitContext>)=>void;asOf:string|undefined;actions:ReactNode;busy?:boolean;onPlanCommitted?:(()=>void)|undefined;restoreReading?:boolean}){
  const nodeViewport=useRef<HTMLDivElement>(null),currentNodeHeading=useRef<HTMLHeadingElement>(null);
  const scheduleAsOf=useScheduleObservation(order,busy);
  const [nodesExpanded,setNodesExpanded]=useState(false);
  useEffect(()=>setNodesExpanded(false),[order.id]);
  const [nodeFilter,setNodeFilter]=useState(context.nodeView??"all");
  useEffect(()=>setNodeFilter(context.nodeView??"all"),[order.id,context.nodeView]);
  const nodes=cockpitDetailNodes(order),legacySelection=journeyDetailSelection(order,context);
  const windowSelection=selectCockpitWashingWindow(nodes,context.focus,context.materialFocus);
  const milestones=cockpitMilestones(order),framework=Boolean(order.fixedSchedule?.framework);
  const chosen=milestones.find(item=>item.selectionKey===context.milestone)??(context.milestone===undefined?milestones.find(item=>legacySelection.selected&&milestoneContains(item,legacySelection.selected)):undefined);
  const milestoneScope=chosen?.scopeRef??milestones[0]?.scopeRef,flowMilestones=milestones.filter(item=>item.scopeRef===milestoneScope);
  const memberNodes=chosen?nodes.filter(node=>milestoneContains(chosen,node)):nodes.filter(node=>node.state!=='not_applicable');
  const expandedStages=(context.expanded??'').split(',');
  const explicitStages=expandedStages.filter(key=>nodes.some(node=>node.stage===key));
  const creationDisplayOnly=expandedStages.includes('creation')&&!explicitStages.includes('creation');
  const legacyFlowSelection=creationDisplayOnly?['creation',...explicitStages]:legacySelection.stages;
  const visible=memberNodes.filter(node=>(!explicitStages.length||explicitStages.includes(node.stage))&&(!context.round||node.stage!=='development'||node.round===context.round));
  const selection=framework?{nodes:visible,stages:[...new Set(visible.map(node=>node.stage))],selected:visible.find(node=>node.instanceId===context.focus)??visible.find(node=>node.current&&nodeIsInProgress(node))??visible[0]}:legacySelection,selected=windowSelection.reference!==null?windowSelection.node:selection.selected;
  const requested=windowSelection.node,filter=context.nodeView??'all';
  const filterMatches=!requested||filter==='all'||filter==='completed'&&['completed','inherited'].includes(requested.state)||filter==='active'&&nodeIsInProgress(requested)||filter==='not_started'&&['uncreated','pending'].includes(requested.state)||filter==='overdue'&&requested.risks.includes('overdue');
  const conflicting=Boolean(requested&&(!visible.some(node=>node.instanceId===requested.instanceId)||!filterMatches));
  useEffect(()=>{if(requested&&conflicting)onChange({milestone:'',expanded:requested.stage,nodeView:'all',focus:requested.instanceId,row:requested.instanceId});},[requested?.instanceId,conflicting]);
  // Invalid explicit window context must not be erased by the ordinary default
  // material-view initialization, nor silently choose a different native node.
  const materials=useNodeMaterialsView(order,selected??null,context,patch=>{if(!windowSelection.error)onChange(patch);});
  const clearWindowFocus=():Partial<CockpitContext>=>{
    if(materials.view.focus.startsWith('washing-window:'))materials.update({focus:''},false);
    return windowSelection.reference!==null?{materialFocus:undefined,materialNode:undefined}:{};
  };
  const selectWindow=(focus:string):CockpitContext=>{
    const next=materials.update({focus},false);
    if(!selected)return next;
    const selection={focus:selected.instanceId,row:selected.instanceId,materialNode:materials.key,materialFocus:focus};
    onChange(selection);
    return {...next,...selection};
  };

  useEffect(()=>{if(materials.view.open){const details=nodeViewport.current?.closest('.cockpit-detail-columns')?.querySelector<HTMLDetailsElement>('.cockpit-current-additional');if(details)details.open=true;}},[materials.key,materials.view.open]);
  const revealedRow=useRef<HTMLElement|null>(null);
  const readSnapshot=useRef<OrderJourney|null>(null);
  useEffect(()=>{const restoring=restoreReading&&readSnapshot.current!==order;readSnapshot.current=order;const id=context.row??context.focus;if(!id){revealedRow.current=null;return;}if(restoring){revealedRow.current=document.getElementById(`journey-node-${id}`);return;}const frame=requestAnimationFrame(()=>{const row=document.getElementById(`journey-node-${id}`);if(row&&row!==revealedRow.current){revealNode(id);revealedRow.current=row;}});return()=>cancelAnimationFrame(frame);},[order,context.focus,context.row,context.expanded,nodeFilter,restoreReading]);
  const rounds=[...new Set(nodes.filter(node=>node.stage==="development"&&node.round).map(node=>node.round!))].sort((a,b)=>b-a);
  const focus=(node:JourneyNode,fromRisk=false)=>{setNodeFilter("all");onChange({nodeView:'all',...clearWindowFocus(),...(framework?{milestone:milestones.find(item=>milestoneContains(item,node)&&(item.selectionKey===chosen?.selectionKey))?.selectionKey??milestones.find(item=>milestoneContains(item,node))?.selectionKey??'',expanded:''}:{expanded:node.stage}),focus:node.instanceId,row:node.instanceId,...(fromRisk?{round:node.stage==="development"?node.round??undefined:undefined}:{})});requestAnimationFrame(()=>{
   revealNode(node.instanceId);
   const heading=currentNodeHeading.current;
   const bounds=heading?.getBoundingClientRect();
   if(heading&&bounds&&(bounds.top<0||bounds.bottom>window.innerHeight))heading.focus();
  });};
  const matches=(node:JourneyNode,key:string)=>key==="all"||key==="completed"&&["completed","inherited"].includes(node.state)||key==="active"&&nodeIsInProgress(node)||key==="not_started"&&["uncreated","pending"].includes(node.state)||key==="overdue"&&node.risks.includes("overdue");
  const filters=[{key:"all",label:"全部节点"},{key:"completed",label:"已完成"},{key:"active",label:"进行中"},{key:"not_started",label:"未开始"},{key:"overdue",label:"逾期"}];
  const stopped=selected&&(selected.state==='cancelled'||nodeIsTerminated(selected));
  const primary=stopped?undefined:selected?.records.find(record=>record.mode==="handle"&&record.domain==="task")??selected?.records.find(record=>record.mode==="handle");
  const read=selected?.records.find(record=>record.mode==="read"&&record.url&&record.domain==="task")??selected?.records.find(record=>record.mode==="read"&&record.url);
  const primaryAction=selected&&(primary||read)&&<div className="cockpit-node-primary" data-material-focus="primary"><CockpitRecordLink record={(primary??read)!} context={materials.context} onNavigate={()=>materials.capture('primary')} disabled={busy}>{primary?'进入该节点办理':'查看节点记录'}</CockpitRecordLink></div>;
  const creationDetails=order.cockpitCreationDetails??[];
  const identityCreation=creationDetails.find(entry=>entry.subject===(order.orderId?'order':'source'));
  const creationEntries=creationDetails.flatMap(({subject,at,record})=>
    at&&record&&!(subject==='source'&&order.cockpitCreation?.developmentPublishedWithOrder)?[{subject,at,record}]:[]);
  const creationSelected=creationDisplayOnly&&creationEntries.length>0;
  const flow=(order.flowStages??order.stages).map(stage=>{
    if(stage.key!=='creation')return stage;
    const current=stage.nodes.filter(node=>node.key===(order.orderId?'order_information':'product_development'));
    return {...stage,nodes:current,state:current[0]?.state??'unavailable' as const};
  });
  const selectCreation=()=>{
    setNodeFilter('all');
    onChange({...clearWindowFocus(),nodeView:'all',expanded:'creation',milestone:'',focus:undefined,row:undefined});
  };
  const blockers=selected?cockpitVisibleBlockers(selected):[];
  const hasActual=selected&&Boolean(selected.actualDate||selected.actualAt||selected.fixedTargets?.some(target=>target.progress.goalDelta.actual.precision!=='unknown'));
  const roundSelector=order.sourceId&&rounds.length>1&&<label className="cockpit-round-select">查看开发轮次<select aria-label="开发轮次" value={context.round??order.selectedRound??rounds[0]} onChange={event=>onChange({...clearWindowFocus(),round:Number(event.target.value),milestone:'',expanded:"development",focus:undefined,row:undefined})}>{rounds.map(round=><option key={round} value={round}>第 {round} 轮{round===order.adoptedRound?" · 大货采用":""}</option>)}</select></label>;
  return <section className="journey-detail journey-golden cockpit-detail" aria-label="订单全景详情">
    <div className="cockpit-detail-toolbar"><div><button type="button" className="journey-text-action" onClick={()=>onChange({selected:undefined,expanded:undefined,focus:undefined,row:undefined,round:undefined,milestone:undefined})}>‹ 生产管理总览</button><span> › 订单详情</span></div><div>{asOf&&<span className="journey-muted">数据时点：{journeyTime(asOf)}</span>}{actions}</div></div>
    <section className="dx-production-panel cockpit-detail-identity"><div className="cockpit-identity-primary"><CockpitPhoto src={order.styleImageUrl} label={order.designStyleNo} className="cockpit-detail-photo"/><div className="cockpit-identity-heading"><h1>{order.styleName||order.designStyleNo}<span className={`cockpit-order-state is-${order.display?.mainState??"unknown"}`}>{order.display?orderStatus(order):"—"}</span></h1><span><b>订单ID：</b>{order.identity?.businessNumber??'—'}</span>{roundSelector}</div><dl className="cockpit-identity-facts"><div data-identity-fact="customer"><dt>客户：</dt><dd>{order.customer??"—"}</dd></div><div data-identity-fact="type"><dt>订单类型：</dt><dd>{order.orderId?"大货订单":"产品开发"}</dd></div><div data-identity-fact="merchandiser"><dt>跟单：</dt><dd>{order.merchandisers.map(person=>person.name??"姓名未登记").join(" / ")||"未指派"}{order.orderId&&<div className="cockpit-personnel-inline"><CockpitPersonnel key={order.orderId} orderId={order.orderId} showCustomer={false} readOnly={busy} onChanged={()=>onPlanCommitted?.()}/></div>}</dd></div><div data-identity-fact="quantity" className="cockpit-identity-quantity"><dt>下单总数：</dt><dd>{order.orderId?`${order.lines.reduce((sum,line)=>sum+line.orderedQuantity,0).toLocaleString()}件`:"—"}</dd></div><div data-identity-fact="created"><dt>创建日期：</dt><dd><CockpitDate value={identityCreation?.at??null} precision="instant" missing="未记录" stacked/></dd><dt>创建人：</dt><dd>{identityCreation?.creator?identityCreation.creator.name||"姓名未登记":"未记录"}</dd></div><div data-identity-fact="version"><dt>资料版本：</dt><dd>开发 {order.sourceVersion===null?"—":`v${order.sourceVersion}`} · 制单 {order.instructionVersion===null?"—":`v${order.instructionVersion}`}</dd></div></dl></div><PoOrderFacts order={order}/></section>
    <section className="dx-production-panel cockpit-flow-panel" aria-label="订单全流程"><div className="cockpit-flow-heading"><h2>{framework?(flowMilestones[0]?.route==='A'?'要对色':flowMilestones[0]?.route==='B'?'无需对色':'流程'):'流程'}</h2>{!framework&&order.seriesPlanVisible&&!order.fixedSchedule&&order.supervision?.status!=='limited'&&<small>缺少有效固定计划</small>}{framework&&new Set(milestones.map(item=>item.scopeRef)).size>1&&<select aria-label="里程碑PO范围" value={milestoneScope} onChange={event=>{setNodeFilter('all');onChange({...clearWindowFocus(),milestone:milestones.find(item=>item.scopeRef===event.target.value)?.selectionKey,nodeView:'all',expanded:'',focus:undefined,row:undefined});}}>{[...new Map(milestones.map(item=>[item.scopeRef,item])).values()].map(item=><option key={item.scopeRef} value={item.scopeRef}>{order.lines.find(line=>line.id===item.lineId)?.po??'本单'}</option>)}</select>}{framework&&creationEntries.length>0&&<button type="button" className="journey-text-action" data-cockpit-focus="stage:creation" aria-pressed={creationSelected} onClick={selectCreation}>订单创建</button>}<CockpitDurationSummary order={order} asOf={scheduleAsOf}/></div>{framework?<CockpitMilestoneFlow items={flowMilestones} selected={chosen?.selectionKey} lines={order.lines} asOf={scheduleAsOf} onSelect={item=>{setNodeFilter('all');onChange({...clearWindowFocus(),milestone:item.selectionKey,nodeView:'all',expanded:'',focus:undefined,row:undefined});}}/>:<div className="cockpit-flow-scroll"><div className="cockpit-stages">{flow.map((stage,index)=><CockpitStageProgress key={stage.key} stage={stage} index={index} lines={order.lines} scheduleAsOf={scheduleAsOf} fact={order.visualProgress?.stages.find(value=>value.key===stage.key)} selected={legacyFlowSelection.includes(stage.key)} onSelect={stage.key==='creation'&&creationEntries.length?selectCreation:()=>{setNodeFilter("all");onChange({...clearWindowFocus(),nodeView:'all',expanded:stage.key,focus:undefined,row:undefined});}}/>)}</div></div>}</section>
    <div className="journey-three-columns cockpit-detail-columns">
      <section className="dx-production-panel journey-current-panel" aria-label="当前节点详情">
       {creationSelected?<><div className="journey-section-title"><h2 ref={currentNodeHeading} tabIndex={-1}>当前节点：订单创建</h2></div>
        <dl className="cockpit-creation-records">{creationEntries.map(entry=><div key={entry.subject}>
         <dt><CockpitRecordLink record={entry.record} context={materials.context} onNavigate={()=>materials.capture('stage:creation')} disabled={busy}>{entry.subject==='source'?'创建纯开发':'创建正式订单'}</CockpitRecordLink></dt>
         <dd><CockpitDate value={entry.at} precision="instant" missing="未记录" stacked/></dd>
        </div>)}</dl>
       </>:<>
       <div className="journey-section-title"><h2 ref={currentNodeHeading} tabIndex={-1}>当前节点：{selected?selected.label+(selected.subject?` · ${selected.subject}`:""):"暂无可见节点"}</h2>{selected&&<CockpitStack className="cockpit-node-heading-actions"><CockpitBadge tone={cockpitNodeTone(selected)}>{cockpitNodeStatus(selected)}</CockpitBadge>{primaryAction}</CockpitStack>}</div>
       {windowSelection.error?<p role="alert">{windowSelection.error}</p>:selected?<>
        <CockpitCurrentSummary node={selected}/>
        {framework&&selected.fixedTargets?.length?<p className="cockpit-current-plan">计划 <CockpitPlanDates node={selected} lines={order.lines}/></p>:null}
        <details className="cockpit-current-additional" key={selected.instanceId} open>
         <summary>节点详情</summary>
         <div className="cockpit-current-scroll" tabIndex={0} role="region" aria-label="当前节点资料">
          <div className="cockpit-node-current"><dl>
           <CockpitNodeDates node={selected} order={order} context={materials.context} disabled={busy} onNavigate={selectWindow}/>
           {hasActual&&<div><dt>实际完成：</dt><dd><CockpitActualDates node={selected} lines={order.lines}/></dd></div>}
           {(selected.round!=null||selected.occurrence!=null)&&<div><dt>轮次 / 次数：</dt><dd>{[selected.round!=null?`第 ${selected.round} 轮`:null,selected.occurrence!=null?`第 ${selected.occurrence} 次`:null].filter(Boolean).join(' / ')}</dd></div>}
           {(selected.completionOperators?.length||selected.operator)?<div><dt>实际操作者：</dt><dd>{selected.completionOperators?.length?selected.completionOperators.map(person=>cockpitPerson(person)).join(" / "):cockpitPerson(selected.operator)}</dd></div>:null}
          </dl></div>
          {blockers.length>0&&<div className="cockpit-node-blockers"><strong>{selected.key==='cutting_gate'?`还差 ${blockers.length} 项才能开裁`:`待核对 ${blockers.length} 项`}：</strong><ul>{blockers.map((blocker,index)=>{
           const [short,...detail]=blocker.label.split('；'),record=blocker.record;
           return <li key={blocker.key+index}>{record?.url?<CockpitRecordLink record={record} context={materials.context} disabled={busy}>{short}</CockpitRecordLink>:short}{detail.length>0&&<details><summary>说明</summary><p>{detail.join('；')}</p></details>}</li>;
          })}</ul></div>}
         </div>
         <NodeMaterialsPanel order={order} node={selected} control={materials} busy={busy}/>
        </details>
       </>:<p>当前没有可见节点。</p>}
       </>}
      </section>
      <section className="dx-production-panel journey-node-panel" aria-label="小流程明细"><h2>{chosen?chosen.label+`节点（${memberNodes.length}）`:'全部节点'}{context.round?` · 第 ${context.round} 轮`:""}</h2><div className="journey-node-tabs"><select aria-label="节点状态筛选" value={nodeFilter} onChange={event=>{const value=event.currentTarget.value as typeof nodeFilter;setNodeFilter(value);onChange({...clearWindowFocus(),nodeView:value});}}>{filters.map(filter=><option key={filter.key} value={filter.key}>{filter.label}（{selection.nodes.filter(node=>matches(node,filter.key)).length}）</option>)}</select><button type="button" onClick={()=>{setNodeFilter("all");onChange({...clearWindowFocus(),nodeView:'all',milestone:'',expanded:"",focus:undefined,row:undefined});}}>本单全部节点</button></div>{framework&&<label>阶段<select aria-label="节点阶段筛选" value={explicitStages[0]??''} onChange={event=>onChange({...clearWindowFocus(),expanded:event.target.value,focus:undefined,row:undefined})}><option value="">全部阶段</option>{order.stages.filter(stage=>memberNodes.some(node=>node.stage===stage.key)).map(stage=><option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></label>}<div className="journey-node-viewport" ref={nodeViewport} tabIndex={0} role="region" aria-label="节点列表"><CockpitFrameworkNodes nodes={selection.nodes.filter(node=>matches(node,nodeFilter))} lines={order.lines} selectedId={selected?.instanceId} asOf={scheduleAsOf} onSelect={node=>focus(node)}/></div>{!selection.nodes.filter(node=>matches(node,nodeFilter)).length&&<p role="status">当前条件没有可见节点。可选择本单全部节点查看其他记录。</p>}<footer className="cockpit-node-footer"><button type="button" className="journey-text-action" onClick={()=>setNodesExpanded(true)}>查看更多 ›</button></footer></section>

    {nodesExpanded&&<CockpitHomeDialog title="全部节点明细" onClose={()=>setNodesExpanded(false)}><div className="cockpit-full-node-scroll" role="region" aria-label="完整节点日期与原记录" tabIndex={0}><CockpitNodeRows idPrefix="journey-full-node" lines={order.lines} nodes={selection.nodes.filter(node=>matches(node,nodeFilter))} selectedId={selected?.instanceId} context={context} asOf={scheduleAsOf??asOf} onSelect={node=>{focus(node);setNodesExpanded(false);}}/></div></CockpitHomeDialog>}
      <CockpitDetailRisks nodeIds={chosen?memberNodes.map(node=>node.instanceId):undefined} order={order} stages={selection.stages} context={context} asOf={asOf} onFocus={node=>focus(node,true)}/>
      <section className="dx-production-panel journey-documents-panel"><h2>相关单据</h2><CockpitDocuments order={order} context={context} onChange={onChange}/></section>
      <CockpitOperationLog order={order}/>
    </div>
  </section>;
}
