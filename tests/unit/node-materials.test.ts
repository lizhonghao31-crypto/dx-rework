import {it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NodeMaterialsQuerySchema,JourneyReturnContextSchema,type NodeMaterial,type JourneyNode,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {emptyMaterialView,materialViewKey,materialViewFromContext,materialViewPatch,filterNodeMaterials} from '../../apps/web/src/node-materials-view.js';
import {cockpitQuery} from '../../apps/web/src/digital-journey-cockpit-model.js';
import {NodeMaterialsPanel} from '../../apps/web/src/node-materials-panel.js';
const id='00000000-0000-4000-8000-000000000001';
it('keeps node view local to exact order round and instance, with first view folded and query keys UI-only',()=>{
 const key=materialViewKey({id,selectedRound:1} as OrderJourney,{instanceId:'one'} as JourneyNode),view={open:true,filter:'pending' as const,scroll:203,focus:'primary'},context=JourneyReturnContextSchema.parse({selected:id,nodeView:'active',...materialViewPatch(key,view)});
 expect(materialViewFromContext(key,context)).toEqual(view);expect(materialViewFromContext(key+'other',context)).toEqual(emptyMaterialView());
 expect(materialViewKey({id,selectedRound:2} as OrderJourney,{instanceId:'one'} as JourneyNode)).not.toBe(key);
 const query=cockpitQuery(context);expect(query).not.toMatch(/material|nodeView/);expect(NodeMaterialsQuerySchema.safeParse({instanceId:'a',round:0}).success).toBe(false);expect(NodeMaterialsQuerySchema.safeParse({instanceId:'a',completed:true}).success).toBe(false);
});
it('filters only authorized returned rows without marking unknown, old or future inputs complete',()=>{
 const rows=[['effective',true],['stale',false],['unknown',true],['not_applicable',false]].map(([state,mine],i)=>({id:String(i),state,mine,applicability:state==='not_applicable'?'not_applicable':'required'} as NodeMaterial));
 expect(filterNodeMaterials(rows,'pending').map(r=>r.id)).toEqual(['1','2']);expect(filterNodeMaterials(rows,'effective').map(r=>r.id)).toEqual(['0']);expect(filterNodeMaterials(rows,'mine').map(r=>r.id)).toEqual(['0','2']);
});
it('renders exact folded heading without hidden body controls, files or hidden tab stops',()=>{
 const html=renderToStaticMarkup(createElement(NodeMaterialsPanel,{order:{id} as OrderJourney,node:{instanceId:'node',blockers:[]} as unknown as JourneyNode,control:{view:emptyMaterialView(),key:'node',identity:'test',restore:{current:{pending:false}},context:{},update(){},capture(){},rememberScroll(){}} as never}));
 expect(html).toContain('该节点所需材料一览');expect(html).not.toContain('node-materials-list');expect(html).not.toContain('打开原资料');expect(html).not.toContain('aria-pressed');expect(html).not.toMatch(/<details[^>]* open/);
});
