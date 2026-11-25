import {it,expect} from 'vitest';
import {factoryBatchLedger,type BatchFact,type BatchCheck} from '../../apps/api/src/production-platform/factory-batch-ledger.js';
import {terminalDispatchObligations} from '../../apps/api/src/production-platform/fixed-factory-timing.js';
const monday='2026-11-09T08:00:00.000Z',tuesday='2026-11-10T08:00:00.000Z',wednesday='2026-11-11T08:00:00.000Z';
const lines=[{lineId:'po',quantity:100}];
const fact=(fact_id:string,kind:string,quantity:number,occurred_at:string,refs:Record<string,string>={}):BatchFact=>({fact_id,kind,payload:{...refs,lines:[{lineId:'po',quantity}]},occurred_at});
const check=(return_fact_id:string,checked_at:string,check_id:string):BatchCheck&{check_id:string}=>({return_fact_id,line_id:'po',result:'合格',checked_at,check_id});
it('keeps Monday60 and Wednesday40 as distinct obligations and retains the first release through a later recheck',()=>{
 const first=[fact('send','工艺发出',100,monday),fact('return60','工艺回仓',60,monday,{sendFactId:'send'})],qc=[check('return60',monday,'qc60')];
 const before=terminalDispatchObligations(factoryBatchLedger(lines,first,qc,false),first,qc,monday);
 expect(before).toMatchObject([{key:'return60:po',enteredAt:monday,complete:false,checkId:'qc60'}]);
 const later=[...first,fact('return40','工艺回仓',40,wednesday,{sendFactId:'send'})],checks=[...qc,check('return40',wednesday,'qc40'),check('return60',wednesday,'recheck60')];
 const after=terminalDispatchObligations(factoryBatchLedger(lines,later,checks,false),later,checks,monday);
 expect(after).toMatchObject([{key:'return60:po',enteredAt:monday,complete:false,checkId:'qc60'},{key:'return40:po',enteredAt:wednesday,complete:false,checkId:'qc40'}]);
 expect(after[0]).toEqual(before[0]);
});
it('completes only the dispatched return and does not use another return or missing contract as its completion/start',()=>{
 const facts=[fact('send','工艺发出',100,monday),fact('return60','工艺回仓',60,monday,{sendFactId:'send'}),fact('dispatch60','仓库实际发厂',60,tuesday,{returnFactId:'return60'}),fact('return40','工艺回仓',40,wednesday,{sendFactId:'send'})],checks=[check('return60',monday,'qc60'),check('return40',wednesday,'qc40')];
 const ledger=factoryBatchLedger(lines,facts,checks,false),windows=terminalDispatchObligations(ledger,facts,checks,monday);
 expect(windows).toMatchObject([{key:'return60:po',enteredAt:monday,complete:true,completedAt:tuesday},{key:'return40:po',enteredAt:wednesday,complete:false,completedAt:null}]);
 expect(terminalDispatchObligations(ledger,facts,checks,null).every(window=>window.enteredAt===null)).toBe(true);
});
it('starts the dispatch obligation at the real counted partial release, not a later optional full recheck',()=>{
 const facts=[fact('send','工艺发出',100,monday),fact('mixed','工艺回仓',100,monday,{sendFactId:'send'})];
 const fail:BatchCheck={...check('mixed',monday,'failed-piece'),result:'需处理',allow_dispatch:false,
  quantity_scope:{inspectedQuantity:20,qualifiedQuantity:0,problemQuantity:20,unit:'片'}};
 expect(terminalDispatchObligations(factoryBatchLedger(lines,facts,[fail],false),facts,[fail],monday)).toEqual([]);
 const release:BatchCheck={...check('mixed',tuesday,'mixed-quantities'),result:'需处理',allow_dispatch:false,
  quantity_scope:{inspectedQuantity:100,qualifiedQuantity:80,problemQuantity:20,unit:'片'}};
 const before=terminalDispatchObligations(factoryBatchLedger(lines,facts,[release],false),facts,[release],monday);
 expect(before).toMatchObject([{key:'mixed:po',checkId:'mixed-quantities',enteredAt:tuesday,complete:false}]);
 const rest=[...facts,fact('dispatch80','仓库实际发厂',80,wednesday,{returnFactId:'mixed'})];
 const later:BatchCheck={...check('mixed',wednesday,'new-release'),quantity_scope:{inspectedQuantity:100,qualifiedQuantity:100,problemQuantity:0,unit:'片'},supersedes_check_id:'mixed-quantities'};
 const checked=[release,later];
 expect(terminalDispatchObligations(factoryBatchLedger(lines,rest,checked,false),rest,checked,monday)).toEqual(before);
});
