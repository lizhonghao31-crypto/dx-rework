import {expect,it} from 'vitest';
import {taskCraftDisplay} from '../../apps/api/src/production-platform/task-craft-display.js';
const basis=(kind='special',step='step-B')=>({basis:[`craft-step:${step}`,`craft-kind:${kind}`]});
it('uses frozen special name and sequence for every phase while leaving ordinary single printing unchanged',()=>{
 const frozen={kind:'special',name:'TEST 工艺B',sequence:2,count:3};
 expect(taskCraftDisplay('development_printing','印花',basis(),frozen)).toMatchObject({label:'TEST 工艺B（工艺2）',stepRef:'step-B',craftKind:'special',craftSequence:2});
 expect(taskCraftDisplay('development_craft_dispatch','发工艺',basis(),frozen).label).toBe('发TEST 工艺B（工艺2）');
 expect(taskCraftDisplay('development_craft_confirmation','工艺确认',basis(),frozen).label).toBe('TEST 工艺B回样确认（工艺2）');
 expect(taskCraftDisplay('development_printing','印花',basis('printing'),{sequence:1,count:1}).label).toBe('印花');
});
it('does not call missing special data printing, invent sequence, or apply craft names to a sewing task',()=>{
 expect(taskCraftDisplay('development_printing','印花',basis()).label).toBe('特殊工艺');
 expect(taskCraftDisplay('development_sewing','车板',basis(),{name:'TEST B'})).toEqual({label:'车板'});
 expect(taskCraftDisplay('development_printing','原单印花',null)).toEqual({label:'原单印花'});
});
it('only the immutable matching step can resolve missing kind metadata, and multiple identities stay explicit unknown',()=>{
 expect(taskCraftDisplay('development_printing','印花',{basis:['craft-step:step-B']},{kind:'special',name:'冻结工艺'}).label).toBe('冻结工艺');
 expect(taskCraftDisplay('development_printing','印花',{basis:['craft-step:step-A','craft-step:step-B','craft-kind:special']},{name:'不应选择'})).toEqual({label:'工艺（实例待核）'});
 expect(taskCraftDisplay('development_printing','印花',{basis:['craft-step:step-B']})).toMatchObject({label:'工艺（类别待核）'});
});
