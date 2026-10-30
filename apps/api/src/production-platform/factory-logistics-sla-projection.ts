import type {FactoryReturnLogisticsWindow} from '@dx-rework/contracts/factory-flow';
import type {SlaNodeEvaluation,SlaPlan} from '@dx-rework/domain/digital-sla-plan';

/** Reuse native allocation identities. A shipment date never supplies an instant anchor. */
export function attachFactoryLogisticsRanges(nodes:SlaNodeEvaluation[],plan:SlaPlan,
 logistics:readonly FactoryReturnLogisticsWindow[],scopes:readonly {productionId:string;factoryDecisionId:string|null;lineId:string}[]):SlaNodeEvaluation[]{
 const definitions=new Map(plan.nodes.map(n=>[n.id,n]));
 return nodes.map(node=>{
  const definition=definitions.get(node.id);
  if(definition?.parameterKey!=='return_logistics'||definition.kind!=='estimate')return node;
  const windows=logistics.filter(window=>scopes.some(scope=>node.id===`return_logistics:${scope.lineId}`
   &&scope.productionId===window.productionId&&scope.factoryDecisionId===window.factoryDecisionId));
  // Preserve the canonical status, actual facts, retained P0/Pk and unknown precision.
  return windows.length?{...node,logisticsWindows:structuredClone(windows)}:node;
 });
}
