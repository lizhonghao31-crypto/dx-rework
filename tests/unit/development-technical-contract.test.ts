import {describe,it,expect} from 'vitest';
import {SaveTechnicalArtifactSchema,RecordFinalCommentSchema,TechnicalArtifactBodySchema,technicalArtifactIssues,validTechnicalMeasurement,CompleteSizeReviewSchema,DevelopmentCycleValuesSchema} from '../../packages/contracts/src/digital-development-technical.js';
const uuid='00000000-0000-4000-8000-000000000001';
const empty=()=>TechnicalArtifactBodySchema.parse({pltAttachmentIds:[],consumptionRows:[{materialId:uuid,unit:'',consumption:''}],baseSizeTable:{unit:'cm',baseSize:'',sizes:[],measurements:[],gradingNote:'',templateRef:null},note:'',basedOnFinalComment:null});
describe('versioned technical contracts',()=>{
 it('persists an incomplete technical draft but never publishes it as three required results',()=>{
  const body=empty(),input={taskId:uuid,expectedDocumentVersion:1,expectedVersion:0,scopeRef:'整款',body,action:'save'};
  expect(SaveTechnicalArtifactSchema.safeParse(input).success).toBe(true);expect(SaveTechnicalArtifactSchema.safeParse({...input,action:'publish'}).success).toBe(false);
  expect(technicalArtifactIssues(body)).toContain('缺少PLT纸样原件');
 });
 it('requires each dimensional column, correct base size and honest consumption units',()=>{
  const body=empty();body.pltAttachmentIds=[uuid];body.consumptionRows=[{materialId:uuid,unit:'米',consumption:'0.125'}];body.baseSizeTable={unit:'inch',baseSize:'M',sizes:['M'],measurements:[{pointId:uuid,name:'胸围',values:['18 1/2'],tolerance:'±1/4',method:'平量'}],gradingNote:'技术按客户依据逐码录入',templateRef:null};
  expect(technicalArtifactIssues(body)).toEqual([]);
  body.baseSizeTable.baseSize='L';expect(technicalArtifactIssues(body).length).toBeGreaterThan(0);
  expect(TechnicalArtifactBodySchema.safeParse({...body,consumptionRows:[body.consumptionRows[0],body.consumptionRows[0]]}).success).toBe(false);
 });
 it('supports explicit inch fractions without silently treating cm or arbitrary text as valid dimensions',()=>{
  expect(validTechnicalMeasurement('18 1/2','inch')).toBe(true);expect(validTechnicalMeasurement('1/4','inch')).toBe(true);
  for(const value of ['1/0','1/1','NaN','Infinity','-1','0','18 1/2cm'])expect(validTechnicalMeasurement(value,'inch')).toBe(false);
  expect(validTechnicalMeasurement('1/4','cm')).toBe(false);
 });
 it('distinguishes final feedback from intermediate communication and pins review choices to actual versions',()=>{
  const comment={roundNumber:1,scopeRef:'整款',expectedVersion:0,isFinal:false,decision:'approved',text:'TEST 中间沟通',evidenceRefs:[],evidenceNote:'TEST邮件文字依据',occurredAt:null};
  expect(RecordFinalCommentSchema.parse(comment).isFinal).toBe(false);
  expect(RecordFinalCommentSchema.safeParse({...comment,evidenceNote:''}).success).toBe(false);
  expect(CompleteSizeReviewSchema.safeParse({taskId:uuid,expectedReviewVersion:1,finalCommentId:uuid,finalCommentVersion:1,decision:'reuse',artifactSetId:uuid,artifactVersion:1,note:''}).success).toBe(false);
 });
 it('rejects invalid policy units instead of extending an urgent deadline past a normal one',()=>{
  expect(DevelopmentCycleValuesSchema.parse({normalDays:7,urgentDays:5,sizeReviewHours:24,externalWashDays:3}).urgentDays).toBe(5);
  expect(DevelopmentCycleValuesSchema.safeParse({normalDays:7,urgentDays:8,sizeReviewHours:24,externalWashDays:3}).success).toBe(false);
 });
});
