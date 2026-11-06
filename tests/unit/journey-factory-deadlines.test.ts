import {it,expect} from 'vitest';
import {attachJourneyFactoryDeadlines} from '../../apps/api/src/production-platform/journey-factory-deadlines.js';
import type {JourneyNode} from '@dx-rework/contracts/digital-production-journey';
const keys=['process_logistics','bulk_qc','warehouse_dispatch'];
const nodes=():JourneyNode[]=>keys.map(key=>({key,label:key,stage:'post_cutting',instanceId:'TEST-'+key,state:'completed',current:true,round:null,occurrence:1,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:'2026-11-02T00:01:00Z',actualQuality:'verified',enteredAt:null,sla:'finished',completionResult:'unknown',overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null}));
const tasks=()=>keys.map(key=>({task_id:'TEST-'+key,task_kind:key,route_instance_id:'TEST-preparation'}));
const lines=[{id:'TEST-line',po:'TEST-existing-PO',color:'黑',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:10}];
const factory=()=>({preparationId:'TEST-preparation',craftKey:'bulk_printing',facts:{},windows:keys.map((key,index)=>({key:'TEST-window-'+index,kind:key as 'process_logistics'|'bulk_qc'|'warehouse_dispatch',parameterKey:key,enteredAt:'2026-11-02T00:00:00Z',dueAt:`2026-11-0${index+3}T00:00:00Z`,warningAt:null,completedAt:'2026-11-02T00:01:00Z',complete:true,minutes:1440,evidence:'TEST-original-source-'+index,lineIds:['TEST-line']}))});
it('retains all three completed original batch D/C without filling the generic task D or requiring a supervision plan',()=>{
 const rows=nodes(),before=structuredClone(rows),source=factory();attachJourneyFactoryDeadlines(rows,tasks(),source,lines);
 for(let i=0;i<rows.length;i++){expect(rows[i]!.nativeWindows).toEqual([expect.objectContaining({deadline:source.windows[i]!.dueAt,completedAt:source.windows[i]!.completedAt,complete:true,scopeLabel:'PO TEST-existing-PO · 黑'})]);const {nativeWindows,...unchanged}=rows[i]!;expect(nativeWindows).toBeDefined();expect(unchanged).toEqual(before[i]);}
 expect(source).toEqual(factory());
});
it('does not attach batch dates to another preparation, a catalogue placeholder, or a scope with an invisible sibling PO',()=>{
 const rows=nodes();rows[0]!.instanceId='process_logistics:0';const raw=tasks();raw[1]!.route_instance_id='TEST-other-route';const source=factory();source.windows[2]!.lineIds.push('TEST-hidden');attachJourneyFactoryDeadlines(rows,raw,source,lines);expect(rows.every(n=>n.nativeWindows===undefined)).toBe(true);
});
