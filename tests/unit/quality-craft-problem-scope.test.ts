import {describe,expect,it} from 'vitest';
import {countedCraftCheck,qualifyCurrentCraftProblem} from '../../apps/api/src/production-platform/quality-craft-problem-scope.js';

const loc={orderId:'order-a',preparationId:'prep-a',stepRef:'printing-a',returnFactId:'return-a',lineId:'po-a',checkId:'check-a'};
const quantity_scope={inspectedQuantity:220,qualifiedQuantity:200,problemQuantity:20,unit:'片'};
const returned_payload={stepRef:loc.stepRef,sendFactId:'send-original-a',warehouseMotion:{factoryId:'approved-original-factory'},
 lines:[{lineId:'po-a',quantity:300},{lineId:'po-b',quantity:100}]};
const row={check_id:loc.checkId,result:'需处理',quantity_scope,returned_payload};

describe('the original quantity-bound craft problem',()=>{
 it('takes only 20 proven pieces, not the 300-piece return or the uninspected remainder',()=>{
  expect(qualifyCurrentCraftProblem(row,loc)).toMatchObject({problemScopeId:loc.checkId,problemQuantity:20,qualifiedQuantity:200,
   actualReturned:300,factoryId:'approved-original-factory',sourceSendFactId:'send-original-a'});
 });
 it('does not invent a quantity or original supplier for a legacy result, a different PO, or a superseded check',()=>{
  expect(qualifyCurrentCraftProblem({...row,quantity_scope:null},loc)).toBeNull();
  expect(qualifyCurrentCraftProblem({...row,returned_payload:{...returned_payload,warehouseMotion:null}},loc)).toBeNull();
  expect(qualifyCurrentCraftProblem(row,{...loc,lineId:'po-b'})).toBeNull();
  expect(qualifyCurrentCraftProblem(row,{...loc,checkId:'check-new'})).toBeNull();
  expect(qualifyCurrentCraftProblem(row,{...loc,stepRef:'older-step'})).toBeNull();
 });
 it('rejects counts outside the physical return and does not implicitly convert garments to pieces',()=>{
  expect(countedCraftCheck({...quantity_scope,inspectedQuantity:301},300)).toBeNull();
  expect(countedCraftCheck({...quantity_scope,problemQuantity:100},300)).toBeNull();
  expect(countedCraftCheck({...quantity_scope,unit:'件'},300)).toBeNull();
 });
});
