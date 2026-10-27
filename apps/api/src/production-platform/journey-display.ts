import { JOURNEY_NODES, JOURNEY_STAGES, type JourneyDisplay, type JourneyNode, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";

/** Canonical business shares, independent of legacy count flags and PO/task multiplicity. */
const businessKey=(key:string)=>key==="development_material_recheck"?"development_materials":key;
const finished=(node:JourneyNode)=>node.state==="completed"||node.state==="inherited"&&Boolean(node.inheritedFrom);
export function progressLabel(ratio:number|null):string {
  if(ratio===null)return "进度资料待完善";
  const percentage=ratio===1?100:Math.min(99.9,Math.round(ratio*1000)/10);
  return `${percentage.toFixed(1)}%`;
}
export function journeyDisplay(order:OrderJourney,asOf:string,terminal:{cancelled?:boolean;closedAt?:string|null}={}):JourneyDisplay {
  const nodes=order.stages.flatMap(stage=>stage.nodes).filter(node=>node.current);
  const closed=nodes.some(node=>["packing","special_closure"].includes(node.key)&&node.state==="completed");
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(asOf));
  const dates=order.poDeliveryDates??[];
  const earliestShipmentDate=dates.flatMap(line=>line.customerWarehouseArrivalDate?[line.customerWarehouseArrivalDate]:[]).sort()[0]??null;
  const activated=nodes.some(node=>!["creation"].includes(node.stage)&&Boolean(node.enteredAt))
    ||nodes.some(node=>node.stage!=="creation"&&["active","completed"].includes(node.state)&&node.records.length>0);
  const mainState=terminal.cancelled?"cancelled":closed?"completed":earliestShipmentDate&&earliestShipmentDate<today?"overdue":earliestShipmentDate&&(itemReminder(order)??earliestShipmentDate)<=today?"due_soon":activated?"active":"not_started";
  const stages=JOURNEY_STAGES.map(definition=>{
    const candidates=nodes.filter(node=>node.stage===definition.key&&(definition.key!=="creation"||node.key===(order.orderId?"order_information":"product_development")));
    const expectedKeys=new Set(JOURNEY_NODES.filter(node=>node.stage===definition.key&&(definition.key!=="creation"||node.key===(order.orderId?"order_information":"product_development"))).map(node=>businessKey(node.key)));
    const groups=new Map<string,JourneyNode[]>();
    for(const node of candidates){const key=businessKey(node.key);groups.set(key,[...(groups.get(key)??[]),node]);}
    // A missing catalog definition/permission/applicability cannot disappear from the denominator.
    const unknown=[...expectedKeys].some(key=>!groups.has(key))||candidates.some(node=>node.state==="unavailable"||node.progressApplicability==="unknown");
    const applicable=[...groups.values()].filter(group=>!group.every(node=>node.state==="not_applicable"||node.progressApplicability==="not_applicable"));
    const completed=applicable.filter(group=>group.filter(node=>node.state!=="not_applicable"&&node.progressApplicability!=="not_applicable").every(finished)).length;
    const current= candidates.filter(node=>!["completed","inherited","not_applicable","cancelled"].includes(node.state));
    const risk=current.some(node=>node.risks.includes("overdue"))?"overdue" as const:current.some(node=>node.risks.includes("due_soon"))?"due_soon" as const:unknown||current.some(node=>node.risks.includes("unknown"))?"unknown" as const:"normal" as const;
    return {key:definition.key,ratio:unknown?null:applicable.length?completed/applicable.length:1,applicable:unknown?null:applicable.length,completed:unknown?null:completed,notApplicable:!unknown&&!applicable.length,risk};
  });
  // A development archive has no production mother yet. Its non-applicable bulk
  // stages cannot supply completed shares to a development progress indicator.
  const progressStages=order.orderId?stages:stages.filter(stage=>stage.key==="development");
  const actualRatio=progressStages.some(stage=>stage.ratio===null)?null:progressStages.reduce((sum,stage)=>sum+stage.ratio!,0)/progressStages.length;
  const unknownLabels=progressStages.filter(stage=>stage.ratio===null).map(stage=>JOURNEY_STAGES.find(definition=>definition.key===stage.key)!.label);
  const actualLabel=actualRatio===null?`${unknownLabels.join("、")}资料待核`:progressLabel(actualRatio);
  return {ruleVersion:"cockpit-display-v1",mainState,earliestShipmentDate,missingShipmentDates:Math.max(order.lines.length-dates.filter(line=>line.customerWarehouseArrivalDate).length,0),closedAt:terminal.closedAt??null,actualRatio,actualLabel,awaitingClosure:Boolean(order.orderId)&&actualRatio===1&&!closed&&!terminal.cancelled,stages,timeRatio:null,timeLabel:order.supervision?.assessment==='partially_unavailable'?"部分节点时效不可评估，请查看原因":order.supervision?.status==='planned'?"节点时效按冻结标准评价":"沿原任务截止监督"};
}
const itemReminder=(order:OrderJourney)=>order.supervision?.customerReminderDate;
/** Explicit cockpit scope. Existing workspace consumers keep their legacy selection contract. */
export function compareCockpitOrders(a:OrderJourney,b:OrderJourney):number {
  const x=a.display!,y=b.display!;
  if((x.mainState==="completed")!==(y.mainState==="completed"))return x.mainState==="completed"?1:-1;
  if(x.mainState==="completed"){
    if(Boolean(x.closedAt)!==Boolean(y.closedAt))return x.closedAt?-1:1;
    if(x.closedAt&&y.closedAt&&x.closedAt!==y.closedAt)return y.closedAt.localeCompare(x.closedAt);
  }else{
    if(Boolean(x.earliestShipmentDate)!==Boolean(y.earliestShipmentDate))return x.earliestShipmentDate?-1:1;
    if(x.earliestShipmentDate!==y.earliestShipmentDate)return (x.earliestShipmentDate??"").localeCompare(y.earliestShipmentDate??"");
  }
  return (a.orderNumbers[0]??a.designStyleNo).localeCompare(b.orderNumbers[0]??b.designStyleNo)||a.id.localeCompare(b.id);
}
