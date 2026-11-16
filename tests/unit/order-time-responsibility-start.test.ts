import {expect,it} from 'vitest';
import {orderTimeNativeTiming} from '../../apps/api/src/production-platform/order-time-native-timing.js';
const at='2026-11-15T22:53:30.123Z',automatic='2026-11-15T22:54:18.382Z';
const rule={kind:'work',minutes:30,calendar:'continuous',reminder:{enabled:true,percent:70}};
const plan={version:'order-time-plan-v1',revision:1,overrides:{},company:{version:'order-time-standard-v1',reference:'TEST original company',revision:1,stageBufferMinutes:0,nodes:{development_tail_check:rule}}};
const task={task_id:'TEST tail',source_id:'TEST source',production_order_id:null,task_kind:'development_tail_check',order_time_managed:true,entered_quality:'补报未核实'};
const base={enteredAt:null,seconds:1800,warningRatio:.7,basis:[] as string[]};
function db(original:unknown=null){return {query:async(sql:string)=>{
 if(sql.startsWith('SELECT entered_at,sla_basis'))return {rows:original?[original]:[]};
 if(sql.startsWith('SELECT plan_version_id,input_snapshot'))return {rows:[{plan_version_id:'TEST original plan',input_snapshot:{plan}}]};
 throw Error('Unexpected native responsibility query: '+sql);
 }};}
it('keeps a native explicit unknown R instead of using the automatic activation time',async()=>{
 const result=await orderTimeNativeTiming(db() as never,task,base,automatic);expect(result?.enteredAt).toBeNull();expect(result?.seconds).toBe(1800);
});
it('does not resurrect a previously captured synthetic R after current native evidence becomes unknown',async()=>{
 const original={entered_at:automatic,sla_basis:{...base,enteredAt:automatic,orderTimePlanRef:'TEST first',basis:['order-time:TEST first:development_tail_check']},due_at:'2026-11-15T23:24:18.382Z',warning_at:null};
 const result=await orderTimeNativeTiming(db(original) as never,task,base,automatic);expect(result?.enteredAt).toBeNull();expect(result?.seconds).toBe(1800);
});
it('retains a genuinely captured started quota when a later order arrangement has a smaller duration',async()=>{
 const original={entered_at:at,sla_basis:{...base,enteredAt:at,seconds:28800,orderTimePlanRef:'TEST first',basis:['task:TEST trusted upstream:completed']},due_at:'2026-11-16T06:53:30.123Z',warning_at:null};
 const result=await orderTimeNativeTiming(db(original) as never,{...task,entered_quality:'已核实'},{...base,enteredAt:at,seconds:14400},at);expect(result?.enteredAt).toBe(at);expect(result?.seconds).toBe(28800);
});
it('uses the verified original ready correction rather than the earlier synthetic R without changing the captured quota',async()=>{
 const original={entered_at:automatic,sla_basis:{...base,enteredAt:automatic,seconds:28800,orderTimePlanRef:'TEST first',basis:['task:TEST actual source:completed']},due_at:null,warning_at:null};
 for(const corrected of [null,at]){
  const result=await orderTimeNativeTiming(db(original) as never,task,base,automatic,{at:corrected,eventId:'TEST original ready correction'});
  expect(result?.enteredAt).toBe(corrected);expect(result?.seconds).toBe(28800);expect(result?.timeQuality).toBe(corrected?'已核实':'缺失');
 }
});

it('selects the already-effective policy at verified R when the old order-time-only window never had real provenance',async()=>{
 const original={entered_at:automatic,sla_basis:{...base,enteredAt:automatic,seconds:28800,orderTimePlanRef:'TEST wrong later policy',basis:['order-time:TEST wrong later policy']},due_at:null,warning_at:null};
 const result=await orderTimeNativeTiming(db(original) as never,task,{...base,enteredAt:at},automatic,{at,eventId:'TEST verified original'});
 expect(result).toMatchObject({enteredAt:at,seconds:1800,orderTimePlanRef:'TEST original plan'});
});
