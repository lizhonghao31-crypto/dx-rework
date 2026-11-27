import {describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {developmentCreationBasicsIssues,developmentPreparationQuantityIssues,projectDevelopmentSewingRows} from '@dx-rework/contracts/digital-development';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {emptyWorkbenchDevelopmentSheet} from '../../apps/web/src/workbench-development-sheet-fields.js';

describe('workbench creation data rules',()=>{
 it('requires real names only for current submission and does not invent brand or style',()=>{
  expect(developmentCreationBasicsIssues({workbenchSheet:emptyWorkbenchDevelopmentSheet()}).map(issue=>issue.field)).toEqual(['styleName','brand']);
  expect(developmentCreationBasicsIssues({workbenchSheet:{...emptyWorkbenchDevelopmentSheet(),styleName:'开衫',brand:'TEST 品牌'}})).toEqual([]);
 });
 it('skips an empty fixed-meter placeholder and validates real physical quantities without treating them as receipts',()=>{
  const document=initialDevelopmentDocument(),seed=document.materials[0]!;
  const meters={...seed,materialId:randomUUID(),quantityUnit:'米',pricingUnit:'米'};
  expect(developmentPreparationQuantityIssues({materials:[meters]},true)).toEqual([]);
  const chosen={...meters,name:'测试布料',quantity:'520 米'};
  expect(developmentPreparationQuantityIssues({materials:[chosen]},true)).toEqual([]);
  expect(developmentPreparationQuantityIssues({materials:[{...chosen,quantity:'520箱'}]},true).map(issue=>issue.field)).toEqual(['quantityUnit']);
  expect(developmentPreparationQuantityIssues({materials:[{...chosen,quantity:''}]},false)).toEqual([]);
  expect(developmentPreparationQuantityIssues({materials:[{...chosen,quantity:''}]},true).map(issue=>issue.field)).toEqual(['quantity']);
  const auxiliary={...chosen,category:'辅料' as const,label:'辅料',quantity:'12',quantityUnit:'',pricingUnit:''};
  expect(developmentPreparationQuantityIssues({materials:[auxiliary]},true).map(issue=>issue.field)).toEqual(['quantityUnit']);
  expect(developmentPreparationQuantityIssues({materials:[{...auxiliary,quantityUnit:'个'}]},true)).toEqual([]);
 });
 it('derives total and each size exactly once across colors and keeps existing technical data',()=>{
  const document=initialDevelopmentDocument();
  const row=(color:string,size:string,quantity:number)=>({rowId:randomUUID(),color,size,quantity});
  const sewingRows=[row('黑色','M',2),row('蓝色','M',3),row('黑色','S',4)];
  const input={...document,unit:'inch' as const,sampleSize:'S',sizes:['L','M'],measurements:[{name:'胸围',values:['20','21']}],
   workbenchSheet:{...emptyWorkbenchDevelopmentSheet(),sewingRows}};
  expect(projectDevelopmentSewingRows(input)).toMatchObject({issues:[],document:{unit:'inch',sampleSize:'S',
   sizes:['L','M','S'],measurements:[{name:'胸围',values:['20','21','']}],quantity:9,sizeQuantities:[0,5,4]}});
  expect(projectDevelopmentSewingRows({...input,workbenchSheet:{...input.workbenchSheet,sewingRows:[...sewingRows,row('黑色','M',1)]}}).issues)
   .toEqual([expect.objectContaining({field:'size',message:'该颜色和尺码已有一条制作行'})]);
 });
});
