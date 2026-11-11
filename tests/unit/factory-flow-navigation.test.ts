import {it,expect} from 'vitest';
import {factoryFlowProductionHref} from '../../apps/web/src/factory-flow-navigation.js';
const id='00000000-0000-4000-8000-000000000001',decision='00000000-0000-4000-8000-000000000002',line='00000000-0000-4000-8000-000000000003';
it('opens both original production views in the exact transferred factory and preserves the selected PO line',()=>{
 const sheet={productionId:id,currentProduction:{productionId:id,factoryDecisionId:decision}};
 const dashboard=new URL(factoryFlowProductionHref(sheet,'')!,'https://test.invalid'),reporting=new URL(factoryFlowProductionHref(sheet,'','reporting',line)!,'https://test.invalid');
 expect(dashboard.pathname).toBe('/ui/production-dashboard/'+id);expect(dashboard.searchParams.get('factoryDecisionId')).toBe(decision);
 expect(reporting.pathname).toBe('/ui/production-reporting/'+id);expect(reporting.searchParams.get('factoryDecisionId')).toBe(decision);expect(reporting.searchParams.get('line')).toBe(line);
});
it('does not turn a known absent current execution into the old zero-allocation factory',()=>{
 expect(factoryFlowProductionHref({productionId:id,currentProduction:null},'')).toBeNull();
 expect(factoryFlowProductionHref({productionId:id,currentProduction:null},'','reporting',line)).toBeNull();
});
it('retains the native original execution and an older compatible response without inventing a factory decision',()=>{
 for(const sheet of [{productionId:id,currentProduction:{productionId:id,factoryDecisionId:null}},{productionId:id}]){
  const url=new URL(factoryFlowProductionHref(sheet,'')!,'https://test.invalid');expect(url.pathname).toBe('/ui/production-dashboard/'+id);expect(url.searchParams.has('factoryDecisionId')).toBe(false);
 }
});
