import {describe,it,expect} from 'vitest';
import {effectiveMaterials} from '../../apps/api/src/production-platform/development-material-readiness.js';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
const missingMainMaterials=(document:DevelopmentDocument,events:Array<{materialId:string;action:string}>)=>effectiveMaterials(document,events.map((event,index)=>({id:String(index),materialId:event.materialId,kind:event.action,at:'2026-10-15T00:00:00Z'}))).filter(row=>row.required&&!row.supplyAvailable&&!row.earlyException).map(row=>row.name);
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {analysisWorkspaceOverview,workspaceAnalysisRows} from '../../apps/api/src/production-platform/analysis-workspace-metrics.js';
import {DigitalAnalysisFilterSchema} from '@dx-rework/contracts/digital-production-analysis';
import {taskAnalysis,type AnalysisTask} from '../../apps/api/src/production-platform/reporting-metrics.js';
const at='2026-10-06T07:00:00.000Z';
const task=(patch:Partial<AnalysisTask>={}):AnalysisTask=>({taskId:'supply',sourceId:'source',orderId:null,styleNo:'TEST',customer:'PD',category:'上衣',requiredRole:'sample_designer',assigneeId:'designer',assigneeName:'TEST',nodeKey:'development_material_supply',label:'补料',round:1,sourceRound:1,instructionVersion:null,state:'ready',createdAt:at,enteredAt:at,completedAt:null,enteredQuality:'现场登记',completedQuality:'缺失',dueAt:null,policyVersion:1,pendingConditions:[],sourceCreatedAt:at,sourcePublished:true,events:[],...patch});
describe('FIX-01 current material metrics',()=>{
 it('includes ordinary auxiliaries in supply metrics and never treats cloth substitution as authorized arrival',()=>{
  const materials=['主布','配布','辅料'].map((category,index)=>({materialId:`00000000-0000-4000-8000-00000000000${index}`,category,label:category,supplier:'',name:'TEST',width:'',weight:'',composition:'',consumption:'',color:'蓝',specification:'',quantity:'1',requiredThisRound:true,available:false,expectedDate:null}));
  const document=DevelopmentDocumentSchema.parse({template:'上衣',quantity:1,sampleSize:'M',orderDate:'2026-10-06',returnDate:null,unit:'cm',sizes:['M'],measurements:[],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',craft:'无',washing:'免洗',materials,files:[]});
  expect(missingMainMaterials(document,[])).toEqual(['主布','配布','辅料']);
  const arrival={materialId:materials[0]!.materialId,action:'到货'};
  expect(missingMainMaterials(document,[arrival,{materialId:materials[1]!.materialId,action:'确认代用'}])).toEqual(['配布','辅料']);
  expect(missingMainMaterials(document,[arrival,{materialId:materials[1]!.materialId,action:'到货'}])).toEqual(['辅料']);
 });
 it('keeps the missing-material KPI and exact drill consistent, then removes recovered and terminal supply tasks',()=>{
  const rows=[taskAnalysis(task({materialSupplyPending:true}),at),taskAnalysis(task({taskId:'recovered'}),at),taskAnalysis(task({taskId:'closed',state:'completed',materialSupplyPending:true}),at)];
  const filters=DigitalAnalysisFilterSchema.parse({from:'2026-10-01',to:'2026-10-31',scope:'snapshot',metric:'materials'});
  expect(analysisWorkspaceOverview(rows,at,'2026-11-01T00:00:00Z',at).snapshot.materialPending).toBe(1);
  expect(workspaceAnalysisRows(rows,[],filters,at,'2026-11-01T00:00:00Z',at).map(row=>row.taskId)).toEqual(['supply']);
 });
});
