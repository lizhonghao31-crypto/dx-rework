import {readDesignerBusinessRoots,type DesignerBusinessProjection} from './development-workbench-business-roots.js';
import {readWorkbenchShipping} from './development-workbench-shipping.js';
import type {DevelopmentShippingDisplay} from '@dx-rework/contracts/digital-development-workspace';
import type {ProductionReadinessService} from './production-readiness-service.js';
import type {WorkspaceNodeFact} from './journey-workspace-facts.js';
import type { DigitalJourneyQuery } from "./journey-query.js";
import { JourneyFilterSchema, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { DEVELOPMENT_VIEWS, PATTERN_GROUPS, PATTERN_LANES, type DevelopmentView, type DevelopmentWorkspaceFilter, type DevelopmentWorkspaceResult, type PatternWorkspaceFilter, type PatternWorkspaceResult, type PatternWorkspaceTask } from "@dx-rework/contracts/digital-development-workspace";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";
import { digitalForbidden, isDigitalManagementReader, isDigitalTechnicalManager } from "./access-policy.js";
import {journeyMatchesSearch} from "./journey-projection.js";
import type {PoolClient} from 'pg';
import type {DevelopmentWorkspaceHandling} from '@dx-rework/contracts/digital-development-workspace';
import type {DigitalProductionNotificationService} from './notification-service.js';
import {developmentRushKey,prioritizeWithinRushGroups,readDevelopmentOrderRush,type RushIdentity} from './development-order-rush.js';

/** Display views only. The original publication, route and order facts remain authoritative. */
export function developmentView(item: OrderJourney): DevelopmentView {
  return developmentNodesView(item.orderId,item.stages.flatMap(stage=>stage.nodes));
}
function developmentNodesView(orderId:string|null,nodes:readonly Pick<WorkspaceNodeFact,'key'|'stage'|'state'|'current'|'countsInProgress'>[]):DevelopmentView {
  if(orderId)return "ordered";
  if(nodes.find(node=>node.key==='development_publish')?.state!=='completed')return 'draft';
  const route=nodes.filter(node=>node.stage==='development'&&node.current&&(node.countsInProgress||node.state==='inherited')&&!['not_applicable','cancelled'].includes(node.state));
  return route.length>0&&route.every(node=>['completed','inherited'].includes(node.state))?'awaiting_order':'developing';
}

const rushMarker=(keys:ReadonlySet<string>,identity:RushIdentity)=>keys.has(developmentRushKey(identity)??'')?{orderRush:true as const}:{};
function prioritizeDesignRush<T extends {view:DevelopmentView;handling?:DevelopmentWorkspaceHandling|undefined;orderRush?:true}>(
 items:readonly T[],nodes:(item:T)=>readonly Pick<WorkspaceNodeFact,'instanceId'|'key'>[],
){
 return prioritizeWithinRushGroups(items,item=>{
  const action=item.handling?.items.find(candidate=>candidate.kind!=='waiting');
  if(!action)return null;
  const taskKind=nodes(item).find(node=>node.instanceId===action.id)?.key;
  return taskKind?`${item.view}:${action.kind}:${taskKind}`:null;
 },item=>item.orderRush===true);
}

function prioritizePatternRush<T extends {orderRush?:true;node:Pick<WorkspaceNodeFact,'owner'|'state'|'key'>}>(items:readonly T[],actorId:string){
 return prioritizeWithinRushGroups(items,task=>task.node.state==='active'&&task.node.owner?.id===actorId?task.node.key:null,task=>task.orderRush===true);
}

export function patternTasks(items: OrderJourney[],rush:ReadonlySet<string>=new Set<string>()): PatternWorkspaceTask[] {
  return items.flatMap(item => item.stages.flatMap(stage => stage.nodes).flatMap(node => {
    const group = PATTERN_GROUPS.find(group => (group.nodes as readonly string[]).includes(node.key));
    // Material plans, uncreated placeholders and inherited references are not tasks.
    if (!group || !node.current || !/^[0-9a-f-]{36}$/i.test(node.instanceId) || !node.records.some(record => record.domain === "task" && record.id === node.instanceId) || ["cancelled", "unavailable", "not_applicable", "inherited", "uncreated"].includes(node.state)) return [];
    return [{ asOf:item.asOf??null, journeyId: item.id, sourceId: item.sourceId, orderId: item.orderId, designStyleNo: item.designStyleNo, customer: item.customer, designer: item.designer, node, group: group.key,...rushMarker(rush,item) }];
  }));
}

export class DevelopmentWorkspaceQuery {
  constructor(private readonly journeys: DigitalJourneyQuery,private readonly notifications?:Pick<DigitalProductionNotificationService,'workbenchNativeActions'>,
    private readonly readiness?:Pick<ProductionReadinessService,'currentFormalHandoversInSnapshot'>) {}

  private async handling(db:PoolClient,actor:TrustedActorContext,rows:readonly {id:string;nodes:readonly Pick<WorkspaceNodeFact,'instanceId'|'current'|'planningOnly'|'owner'>[]}[]){
    const activeNodes=(row:typeof rows[number])=>row.nodes.filter(node=>node.current&&!node.planningOnly&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(node.instanceId));
    const requested=[...new Set(rows.flatMap(row=>activeNodes(row).map(node=>node.instanceId)))];
    const native=await this.notifications?.workbenchNativeActions(db,actor,requested)??[];
    const priority={returned:0,mine:1,waiting:2};
    const ordered=native.sort((left,right)=>priority[left.kind]-priority[right.kind]);
    const order=new Map(ordered.map((item,index)=>[item.id,{item,index}]));
    return new Map<string,DevelopmentWorkspaceHandling>(rows.map(row=>{
      const owners=new Map(activeNodes(row).map(node=>[node.instanceId,node.owner?.name]));
      const items=[...owners].flatMap(([id,ownerName])=>{
        const match=order.get(id);return match?[{index:match.index,item:{...match.item,...(match.item.kind==='waiting'&&ownerName?{ownerName}:{})}}]:[];
      }).sort((left,right)=>left.index-right.index).map(({item})=>item);
      return [row.id,{items,complete:false}];
    }));
  }

  async designer(actor: TrustedActorContext, filter: DevelopmentWorkspaceFilter): Promise<DevelopmentWorkspaceResult> {
    if (!isRootActor(actor) && !(actor.actorRoles.includes("sample_designer") && actor.authorizationCapabilities?.includes("pattern_room:orders:create"))) digitalForbidden();
    const viewMatches=(item:{view:DevelopmentView;handling?:DevelopmentWorkspaceHandling|undefined},business:DesignerBusinessProjection|null)=>{
      if(!business&&filter.layout==='workbench'&&item.view==='draft')return false;
      if(filter.view!=='all'&&item.view!==filter.view)return false;
      return !filter.handling||filter.handling==='all'||item.handling?.items.some(action=>action.kind===filter.handling||filter.handling==='mine'&&action.kind==='returned');
    };
    const selectsBusiness=(value:DesignerBusinessProjection|null,item:{journey:{id:string}})=>{
      if(!value)return true;
      const row=value.byId.get(item.journey.id),chosen=filter.businessView;
      return value.representatives.has(item.journey.id)&&(!chosen||Boolean(row&&(chosen==='handover'&&row.handoverComplete||chosen===row.kind)));
    };
    const indexed=await this.journeys.workspace?.(actor,JourneyFilterSchema.parse({search:filter.search,...(filter.customer?{customer:filter.customer}:{}),startDate:filter.startDate,endDate:filter.endDate}),undefined,async(facts,asOf,freshness,db,authorized)=>{
      const scoped=facts.filter(item=>!filter.designer||item.designer===filter.designer);
      const handling=filter.layout==='workbench'?await this.handling(db,actor,scoped):undefined;
      const rush=filter.layout==='workbench'?await readDevelopmentOrderRush(db,scoped):new Set<string>();
      const all=scoped.map(journey=>({journey,...rushMarker(rush,journey),view:developmentNodesView(journey.orderId,journey.nodes),canConfirm:!journey.orderId&&Boolean(journey.sourceId)&&(isRootActor(actor)||journey.nodes.some(node=>node.key==='product_development'&&node.owner?.id===actor.actorId)),...(handling?.has(journey.id)?{handling:handling.get(journey.id)!}:{})}));
      const counts=Object.fromEntries(DEVELOPMENT_VIEWS.map(view=>[view.key,view.key==='all'?all.length:all.filter(item=>item.view===view.key).length])) as DevelopmentWorkspaceResult['counts'];
      const business=filter.layout==='workbench'&&this.readiness?await readDesignerBusinessRoots(db,actor,
        authorized.filter(item=>!filter.designer||item.designer===filter.designer),this.readiness):null;
      const filtered=prioritizeDesignRush(all.filter(item=>selectsBusiness(business,item)&&viewMatches(item,business)),item=>item.journey.nodes);
      const chosenPage=business?filter.page:freshness?1:filter.page;
      const page=filtered.slice((chosenPage-1)*15,chosenPage*15);
      const shipping=business?await readWorkbenchShipping(db,actor,page.map(item=>item.journey)):null;
      return {ids:page.map(item=>item.journey.id),finish:(details,finalFreshness=freshness,detailFailures=[])=>{
        const failures=detailFailures.map(id=>({journeyId:id,designStyleNo:facts.find(item=>item.id===id)!.designStyleNo}));
        return {asOf,page:business?filter.page:finalFreshness?1:filter.page,pageSize:15 as const,total:finalFreshness?null:filtered.length,
          counts:finalFreshness?null:counts,...(business?{businessCounts:business.counts}:{}),...(finalFreshness?{freshness:finalFreshness}:{}),
          ...(failures.length?{detailFailures:failures}:{}),designers:[...new Set(authorized.flatMap(item=>item.designer?[item.designer]:[]))].sort(),
          customers:[...new Set(authorized.flatMap(item=>item.customer?[item.customer]:[]))].sort(),
          items:page.filter(item=>details.has(item.journey.id)).map(item=>({...item,
            ...(business?.byId.get(item.journey.id)?{business:{...business.byId.get(item.journey.id)!,
              ...(shipping?.get(item.journey.id)?{shipping:shipping.get(item.journey.id)!}:{})}}:{}),
            journey:{...details.get(item.journey.id)!,...(filter.layout==='workbench'?{styleName:item.journey.styleName}:{})}}))};
      }};
    });
    if(indexed)return indexed;
    let selectionFacts:OrderJourney[]|undefined,business:DesignerBusinessProjection|null=null,handling:Map<string,DevelopmentWorkspaceHandling>|undefined,rush=new Set<string>();
    let shipping=new Map<string,DevelopmentShippingDisplay>();
    const legacyItem=(journey:OrderJourney)=>({
      journey,view:developmentView(journey),...rushMarker(rush,journey),handling:handling?.get(journey.id),
    });
    const legacyNodes=(item:{journey:OrderJourney})=>item.journey.stages.flatMap(stage=>stage.nodes);
    const result = await this.journeys.list(actor, JourneyFilterSchema.parse({ search: filter.search, ...(filter.customer ? {customer: filter.customer} : {}), startDate: filter.startDate, endDate: filter.endDate }), true,async(items,db)=>{
      selectionFacts=items;
      const scoped=items.filter(item=>!filter.designer||item.designer===filter.designer);
      if(filter.layout==='workbench'){
        handling=await this.handling(db,actor,scoped.map(item=>({id:item.id,nodes:item.stages.flatMap(stage=>stage.nodes)})));
        rush=await readDevelopmentOrderRush(db,scoped);
        if(this.readiness)business=await readDesignerBusinessRoots(db,actor,scoped,this.readiness);
      }
      const selected=prioritizeDesignRush(scoped.map(legacyItem).filter(item=>viewMatches(item,business)&&selectsBusiness(business,item)),legacyNodes).slice((filter.page-1)*15,filter.page*15).map(item=>item.journey);
      if(business)shipping=await readWorkbenchShipping(db,actor,selected);
      return selected;
    },filter.layout==='workbench'?{designerNames:true}:{});
    const facts=selectionFacts??result.items,details=new Map(result.items.map(item=>[item.id,item]));
    const all = facts.filter(item => !filter.designer || item.designer === filter.designer).map(journey => ({journey,...rushMarker(rush,journey),view: developmentView(journey), canConfirm: !journey.orderId && Boolean(journey.sourceId) && (isRootActor(actor) || journey.stages.flatMap(stage => stage.nodes).some(node => node.key === "product_development" && node.owner?.id === actor.actorId)),...(handling?.has(journey.id)?{handling:handling.get(journey.id)!}:{})}));
    const counts = Object.fromEntries(DEVELOPMENT_VIEWS.map(view => [view.key, view.key === "all" ? all.length : all.filter(item => item.view === view.key).length])) as DevelopmentWorkspaceResult["counts"];
    const filtered = prioritizeDesignRush(all.filter(item=>viewMatches(item,business)&&selectsBusiness(business,item)),legacyNodes);
    const chosenBusiness=business as DesignerBusinessProjection|null;
    return {asOf: result.asOf, page: filter.page, pageSize: 15, total: filtered.length, counts,...(chosenBusiness?{businessCounts:chosenBusiness.counts}:{}), designers: [...new Set(facts.flatMap(item => item.designer ? [item.designer] : []))].sort(), customers: [...new Set(facts.flatMap(item => item.customer ? [item.customer] : []))].sort(), items: filtered.slice((filter.page - 1) * 15, filter.page * 15).map(item=>({...item,...(chosenBusiness?.byId.has(item.journey.id)?{business:{...chosenBusiness.byId.get(item.journey.id)!,...(shipping.get(item.journey.id)?{shipping:shipping.get(item.journey.id)!}:{})}}:{}),journey:details.get(item.journey.id)!}))};
  }
  async pattern(actor: TrustedActorContext, filter: PatternWorkspaceFilter): Promise<PatternWorkspaceResult> {
    const manager=isDigitalManagementReader(actor)||isDigitalTechnicalManager(actor);
    const clerk=actor.actorRoles.includes("development_clerk");
    if(filter.scope!=="mine"&&!manager&&!clerk)digitalForbidden();
    if(filter.scope==="unassigned"&&!manager)digitalForbidden();
    if(filter.scope==="dispatch"&&!isRootActor(actor)&&!actor.actorRoles.includes("pattern_room_supervisor"))digitalForbidden();
    const indexed=await this.indexedPattern(actor,filter);if(indexed)return indexed;
    // Board cards contain read-only facts. Handling always re-reads the actual task.
    let rush=new Set<string>();
    const result = await this.journeys.list(actor, JourneyFilterSchema.parse({}), true,async(items,db)=>{
      rush=await readDevelopmentOrderRush(db,items);return items;
    },{details:false,patternBusiness:filter.business});
    const journeys=new Map(result.items.map(item=>[item.id,item])),search=filter.search.toLocaleLowerCase();
    const all = patternTasks(result.items,rush).filter(task => filter.business === "all" || (task.node.key === "bulk_pattern" ? filter.business === "bulk" : filter.business === "development"));
    const assignments=filter.scope==="dispatch"?await this.journeys.pendingPatternAssignments(actor,[...new Set(all.flatMap(task=>task.sourceId?[task.sourceId]:[]))]):[];
    // One genuine current task supplies document context for each pending original order.
    // Formal assignment never changes this task's readiness, owner or completion.
    const dispatch=assignments.flatMap(assignment=>{
      const candidates=all.filter(task=>task.sourceId===assignment.sourceId&&["pending","active","blocked"].includes(task.node.state));
      const task=candidates.find(task=>task.group==="dispatch")??candidates[0];
      return task?[{...task,nativeAssignment:{orderId:assignment.orderId}}]:[];
    });
    const scoped=filter.scope==="dispatch"?dispatch:all.filter(task=>filter.scope==="mine"?task.node.owner?.id===actor.actorId:filter.scope==="unassigned"?!task.node.owner:filter.scope==="personnel"?["materials","dispatch"].includes(task.group):true);
    const filtered = scoped.filter(task => (journeyMatchesSearch(journeys.get(task.journeyId)!,search)||Boolean(task.node.owner?.name?.toLocaleLowerCase().includes(search)))&&(!filter.owner || task.node.owner?.id === filter.owner)
      && (filter.state === "all" || (filter.state === "ongoing" ? ["pending", "active", "blocked"].includes(task.node.state) : task.node.state === filter.state))
      && (!filter.risk || task.node.risks.includes(filter.risk)));
    const lane = PATTERN_LANES.find(item => item.key === filter.lane);
    const matching = filtered.filter(task => (!filter.group || task.group === filter.group) && (!lane || (lane.groups as readonly string[]).includes(task.group)));
    const visible=prioritizePatternRush(matching,actor.actorId);
    const owners = [...new Map(scoped.flatMap(task => task.node.owner ? [[task.node.owner.id, task.node.owner] as const] : [])).values()];
    return {asOf: result.asOf, page: filter.page, pageSize: 15, total: visible.length, archiveTotal: new Set(visible.map(task => task.journeyId)).size,
      counts: Object.fromEntries(PATTERN_GROUPS.map(group => [group.key, filtered.filter(task => task.group === group.key).length])) as PatternWorkspaceResult["counts"], owners,
      riskCounts:Object.fromEntries(PATTERN_GROUPS.map(group=>[group.key,{dueSoon:filtered.filter(task=>task.group===group.key&&task.node.risks.includes("due_soon")).length,overdue:filtered.filter(task=>task.group===group.key&&task.node.risks.includes("overdue")).length}])) as PatternWorkspaceResult["riskCounts"],
      risks: matching.filter(task => task.node.risks.length > 0).slice(0, 15),
      boardPreview:PATTERN_LANES.flatMap(lane=>visible.filter(task=>(lane.groups as readonly string[]).includes(task.group)).slice(0,3)),
      items: visible.slice((filter.page - 1) * 15, filter.page * 15)};
  }
  private async indexedPattern(actor:TrustedActorContext,filter:PatternWorkspaceFilter):Promise<PatternWorkspaceResult|null|undefined>{
    return this.journeys.workspace?.(actor,JourneyFilterSchema.parse({search:filter.search}),filter.business,async(facts,asOf,freshness,db)=>{
      type Task=Omit<PatternWorkspaceTask,'node'>&{node:WorkspaceNodeFact};
      const rush=await readDevelopmentOrderRush(db,facts);
      const journeys=new Map(facts.map(item=>[item.id,item])),search=filter.search.toLocaleLowerCase();
      const all:Task[]=facts.flatMap(item=>item.nodes.flatMap(node=>{
        const group=PATTERN_GROUPS.find(group=>(group.nodes as readonly string[]).includes(node.key));
        if(!group||!node.current||!node.nativeTask||!/^[0-9a-f-]{36}$/i.test(node.instanceId)||['cancelled','unavailable','not_applicable','inherited','uncreated'].includes(node.state))return [];
        if(filter.business!=='all'&&(node.key==='bulk_pattern'?filter.business!=='bulk':filter.business!=='development'))return [];
        return [{asOf:item.asOf,journeyId:item.id,sourceId:item.sourceId,orderId:item.orderId,designStyleNo:item.designStyleNo,customer:item.customer,designer:item.designer,node,group:group.key,...rushMarker(rush,item)}];
      }));
      const assignments=filter.scope==='dispatch'?await this.journeys.pendingPatternAssignments(actor,[...new Set(all.flatMap(task=>task.sourceId?[task.sourceId]:[]))]):[];
      const dispatch:Task[]=assignments.flatMap(assignment=>{const candidates=all.filter(task=>task.sourceId===assignment.sourceId&&['pending','active','blocked'].includes(task.node.state)),task=candidates.find(task=>task.group==='dispatch')??candidates[0];return task?[{...task,nativeAssignment:{orderId:assignment.orderId}}]:[];});
      const scoped=filter.scope==='dispatch'?dispatch:all.filter(task=>filter.scope==='mine'?task.node.owner?.id===actor.actorId:filter.scope==='unassigned'?!task.node.owner:filter.scope==='personnel'?['materials','dispatch'].includes(task.group):true);
      const filtered=scoped.filter(task=>(!search||journeys.get(task.journeyId)!.selectionSignals?.searchMatched||Boolean(task.node.owner?.name?.toLocaleLowerCase().includes(search)))&&(!filter.owner||task.node.owner?.id===filter.owner)
        &&(filter.state==='all'||(filter.state==='ongoing'?['pending','active','blocked'].includes(task.node.state):task.node.state===filter.state))&&(!filter.risk||task.node.risks.includes(filter.risk)));
      const lane=PATTERN_LANES.find(item=>item.key===filter.lane),matching=filtered.filter(task=>(!filter.group||task.group===filter.group)&&(!lane||(lane.groups as readonly string[]).includes(task.group)));
      const visible=prioritizePatternRush(matching,actor.actorId);
      const page=visible.slice(((freshness?1:filter.page)-1)*15,(freshness?1:filter.page)*15),risks=matching.filter(task=>task.node.risks.length>0).slice(0,15),board=PATTERN_LANES.flatMap(lane=>visible.filter(task=>(lane.groups as readonly string[]).includes(task.group)).slice(0,3));
      const display=[...page,...risks,...board];
      return {ids:display.map(task=>task.journeyId),finish:(details,finalFreshness=freshness,detailFailures=[])=>{
        const actual=new Map(patternTasks([...details.values()],rush).map(task=>[task.journeyId+':'+task.node.instanceId,task]));
        const card=(task:Task):PatternWorkspaceTask=>{const value=actual.get(task.journeyId+':'+task.node.instanceId);if(!value)throw new Error('Current workspace task is absent from its native projection');return {...value,...(task.nativeAssignment?{nativeAssignment:task.nativeAssignment}:{})};};
        return {asOf,page:finalFreshness?1:filter.page,pageSize:15,total:finalFreshness?null:visible.length,archiveTotal:finalFreshness?null:new Set(visible.map(task=>task.journeyId)).size,...(finalFreshness?{freshness:finalFreshness}:{}),...(detailFailures.length?{detailFailures:detailFailures.map(id=>({journeyId:id,designStyleNo:facts.find(item=>item.id===id)!.designStyleNo}))}:{}),
          counts:finalFreshness?null:Object.fromEntries(PATTERN_GROUPS.map(group=>[group.key,filtered.filter(task=>task.group===group.key).length])) as PatternWorkspaceResult['counts'],
          owners:[...new Map(scoped.flatMap(task=>task.node.owner?[[task.node.owner.id,task.node.owner] as const]:[])).values()],
          riskCounts:finalFreshness?null:Object.fromEntries(PATTERN_GROUPS.map(group=>[group.key,{dueSoon:filtered.filter(task=>task.group===group.key&&task.node.risks.includes('due_soon')).length,overdue:filtered.filter(task=>task.group===group.key&&task.node.risks.includes('overdue')).length}])) as PatternWorkspaceResult['riskCounts'],
          items:page.filter(task=>details.has(task.journeyId)).map(card),risks:risks.filter(task=>details.has(task.journeyId)).map(card),boardPreview:board.filter(task=>details.has(task.journeyId)).map(card)};
      }};
    });
  }

}
