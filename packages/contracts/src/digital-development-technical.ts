import {DevelopmentMakingUpgradeSchema,DevelopmentOccurrenceSchema,type DevelopmentDocument} from './digital-development.js';
import {z} from 'zod';

export const DEVELOPMENT_TECHNICAL_RULE = 'development-20261031.1' as const;
export const DEVELOPMENT_PLOT_MIME = 'application/octet-stream' as const;
export const DEVELOPMENT_UPLOAD_PURPOSES=['工艺开发板','面料报告','车板成果','纸样成果','尾查照片','外部纸样','定位图','工艺回样照片','客户评语依据','补做成果'] as const;
export type DevelopmentUploadPurpose=typeof DEVELOPMENT_UPLOAD_PURPOSES[number];
export const DEVELOPMENT_PURPOSE_TASK_KIND:Partial<Record<DevelopmentUploadPurpose,string>>={'车板成果':'development_sewing','纸样成果':'development_pattern','尾查照片':'development_tail_check','定位图':'development_positioning','工艺回样照片':'craft','补做成果':'development_patch'};
const scope=z.string().trim().min(1).max(100).default('整款');
const revisionCommentInteger=z.number().int().positive().max(2_147_483_647);
/** Unlike comment creation, a stored revision reference cannot default its scope. */
export const DevelopmentRevisionCommentRefSchema=z.object({
 sourceId:z.uuid(),roundNumber:revisionCommentInteger,scopeRef:scope.unwrap(),commentId:z.uuid(),version:revisionCommentInteger,
}).strict();
export type DevelopmentRevisionCommentRef=z.infer<typeof DevelopmentRevisionCommentRefSchema>;
const ids=z.array(z.string().uuid()).max(20).refine(v=>new Set(v).size===v.length,'附件不能重复');
const note=z.string().trim().max(4000);
const decimal=z.string().regex(/^(?:0|[1-9]\d{0,10})(?:\.\d{1,6})?$/,'请填写非负数，最多六位小数');
export const TechnicalConsumptionRowSchema=z.object({materialId:z.string().uuid(),unit:z.string().trim().max(30),consumption:z.union([z.literal(''),decimal])}).strict();
export function validTechnicalMeasurement(value:string,unit:'cm'|'inch'):boolean {
 if(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/.test(value))return Number(value)>0;
 if(unit!=='inch')return false;
 const fraction=value.match(/^(?:(\d{1,6})\s+)?([1-9]\d{0,5})\/([1-9]\d{0,5})$/);
 return !!fraction&&Number(fraction[2])<Number(fraction[3]);
}
export const TechnicalSizeTableSchema=z.object({
 unit:z.enum(['cm','inch']),baseSize:z.string().trim().max(40),sizes:z.array(z.string().trim().max(40)).max(20),
 measurements:z.array(z.object({pointId:z.string().uuid(),name:z.string().trim().max(100),tolerance:z.string().trim().max(100),method:z.string().trim().max(500),values:z.array(z.string().trim().max(32)).max(20)}).strict()).max(100),
 gradingNote:z.string().trim().max(4000),templateRef:z.object({id:z.string().uuid(),version:z.number().int().positive()}).strict().nullable(),
}).strict().superRefine((v,c)=>{
 if(new Set(v.sizes.filter(Boolean)).size!==v.sizes.filter(Boolean).length)c.addIssue({code:'custom',message:'尺码不能重复'});
 const named=v.measurements.map(r=>r.name).filter(Boolean);
 if(new Set(v.measurements.map(r=>r.pointId)).size!==v.measurements.length||new Set(named).size!==named.length)c.addIssue({code:'custom',message:'测量部位不能重复'});
 if(v.measurements.some(r=>r.values.length!==v.sizes.length))c.addIssue({code:'custom',message:'尺寸数值必须对应尺码列'});
});
export const TechnicalArtifactBodySchema=z.object({pltAttachmentIds:ids,consumptionRows:z.array(TechnicalConsumptionRowSchema).max(100),baseSizeTable:TechnicalSizeTableSchema,note,
 basedOnFinalComment:z.object({id:z.string().uuid(),version:z.number().int().positive()}).strict().nullable(),
}).strict().superRefine((v,c)=>{if(new Set(v.consumptionRows.map(r=>r.materialId)).size!==v.consumptionRows.length)c.addIssue({code:'custom',message:'同一物料用量不能重复'});});
export function technicalSizeTableIssues(t:TechnicalSizeTable):string[]{
 const errors:string[]=[];
 if(!t.baseSize||!t.sizes.includes(t.baseSize))errors.push('请选择本成果基码，且基码须在尺寸表内');
 if(t.sizes.some(s=>!s))errors.push('请填写尺码列名称');
 if(!t.measurements.length)errors.push('缺少基码尺寸表');
 if(t.measurements.some(r=>!r.name))errors.push('请填写测量部位名称');
 if(t.measurements.some(r=>r.values.some(v=>!validTechnicalMeasurement(v,t.unit))))errors.push('请补齐各部位实际尺寸；英寸支持小数或带分数');
 return errors;
}
export function technicalArtifactIssues(body:TechnicalArtifactBody):string[]{
 return [...(!body.pltAttachmentIds.length?['缺少PLT纸样原件']:[]),...(!body.consumptionRows.length?['缺少结构单件用量']:[]),...(body.consumptionRows.some(r=>!r.unit||r.consumption==='')?['请补齐结构用量的单位和数值']:[]),...technicalSizeTableIssues(body.baseSizeTable)];
}
export const SaveTechnicalArtifactSchema=z.object({taskId:z.string().uuid(),expectedDocumentVersion:z.number().int().positive(),expectedVersion:z.number().int().nonnegative(),scopeRef:scope,action:z.enum(['save','publish']),body:TechnicalArtifactBodySchema}).strict()
 .superRefine((v,c)=>{if(v.action==='publish')for(const message of technicalArtifactIssues(v.body))c.addIssue({code:'custom',message});});
export const CustomerCommentOccurrenceSchema=z.union([DevelopmentOccurrenceSchema,z.object({precision:z.literal('current')}).strict()]);
export const RecordFinalCommentSchema=z.object({roundNumber:z.number().int().positive(),scopeRef:scope,expectedVersion:z.number().int().nonnegative(),isFinal:z.boolean(),decision:z.enum(['approved','changes_required','noted']),text:z.string().trim().min(1).max(4000),evidenceRefs:ids,evidenceNote:z.string().trim().min(1).max(2000),occurredAt:z.iso.datetime({offset:true}).nullable(),actualTime:CustomerCommentOccurrenceSchema.optional()}).strict().superRefine((value,ctx)=>{if(value.isFinal&&value.decision==='noted')ctx.addIssue({code:'custom',path:['decision'],message:'最终批复须确认认可或修改'});if(value.actualTime!==undefined&&value.occurredAt!==null)ctx.addIssue({code:'custom',path:['actualTime'],message:'实际发生时间只能采用一种填写方式'});});
export const SupplementCommentTimeSchema=z.object({commentId:z.uuid(),commentVersion:z.number().int().positive(),actualTime:DevelopmentOccurrenceSchema.refine(value=>value.precision!=='unknown','请依据原记录填写实际发生日期或时间'),note:z.string().trim().min(1).max(2000)}).strict();
export type SupplementCommentTime=z.infer<typeof SupplementCommentTimeSchema>;
export const CompleteSizeReviewSchema=z.object({taskId:z.string().uuid(),expectedReviewVersion:z.number().int().positive(),finalCommentId:z.string().uuid(),finalCommentVersion:z.number().int().positive(),decision:z.enum(['reuse','revise']),artifactSetId:z.string().uuid(),artifactVersion:z.number().int().positive(),note:z.string().trim().min(1).max(2000)}).strict();
export const CompletePositionSchema=z.object({taskId:z.string().uuid(),artifactSetId:z.string().uuid(),artifactVersion:z.number().int().positive(),attachmentIds:ids.refine(v=>v.length>0,'请上传定位图'),note}).strict();
export const TechnicalTemplateBodySchema=z.object({customerCode:z.string().trim().min(1).max(30),name:z.string().trim().min(1).max(100),table:TechnicalSizeTableSchema,note}).strict();
export const SaveTechnicalTemplateSchema=z.object({templateId:z.string().uuid(),expectedVersion:z.number().int().nonnegative(),body:TechnicalTemplateBodySchema,reason:z.string().trim().min(1).max(1000)}).strict();
export const SaveTechnicalMaterialDecisionSchema=z.object({roundNumber:z.number().int().positive(),materialId:z.string().uuid(),expectedVersion:z.number().int().nonnegative(),preshrinkMethod:z.enum(['专业针织预缩','常规梭织预缩','其它经技术确认']).nullable().optional(),highTemperatureRequired:z.boolean().nullable(),basis:z.string().trim().min(1).max(2000),supplierEvidenceIds:ids,warpShrinkPercent:decimal.nullable(),weftShrinkPercent:decimal.nullable()}).strict()
 .superRefine((v,c)=>{if([v.warpShrinkPercent,v.weftShrinkPercent].some(n=>n!==null&&Number(n)>100))c.addIssue({code:'custom',message:'缩率百分比不能高于100%'});});
export const SavePreparationBasisSchema=z.object({roundNumber:z.number().int().positive(),expectedVersion:z.number().int().nonnegative(),basis:z.enum(['first_development','confirmed_repeat']),finalFabric:z.boolean(),finalCraft:z.boolean(),sampleEvidenceIds:ids,customerFabricEvidenceIds:ids,note:z.string().trim().min(1).max(2000)}).strict().superRefine((v,c)=>{if(v.basis==='confirmed_repeat'&&(!v.sampleEvidenceIds.length||!v.customerFabricEvidenceIds.length))c.addIssue({code:'custom',message:'复版并行准备须有已有首版及客户确认面料的实际依据'});});
export const TechnicalPlotUploadSchema=z.object({filename:z.string().min(1).max(255).refine(v=>/\.plt$/i.test(v),'纸样原件请上传.plt文件'),mimeType:z.literal(DEVELOPMENT_PLOT_MIME),sizeBytes:z.number().int().positive(),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();

export const DevelopmentCycleValuesSchema=z.object({normalDays:z.number().int().min(1).max(365),urgentDays:z.number().int().min(1).max(365),sizeReviewHours:z.number().int().min(1).max(8760),externalWashDays:z.number().int().min(1).max(365)}).strict().superRefine((v,c)=>{if(v.urgentDays>v.normalDays)c.addIssue({code:'custom',message:'加急周期不能长于正常周期'});});
export const DEVELOPMENT_CYCLE_DEFAULTS={normalDays:7,urgentDays:5,sizeReviewHours:24,externalWashDays:3} as const;
export const DevelopmentCycleDraftSchema=z.object({expectedVersion:z.number().int().positive(),values:DevelopmentCycleValuesSchema,reason:z.string().trim().min(1).max(1000)}).strict();
export const DevelopmentCyclePublishSchema=DevelopmentCycleDraftSchema.extend({previewToken:z.string().min(1),savedDraftRevision:z.number().int().positive().optional()}).strict();
export const DevelopmentUrgentRequestSchema=z.object({roundNumber:z.number().int().positive(),expectedRevision:z.number().int().nonnegative(),action:z.enum(['request','approve','reject']),reason:z.string().trim().min(1).max(1000)}).strict();
export const DevelopmentPatchDecisionSchema=z.object({issueId:z.string().uuid(),expectedVersion:z.number().int().positive(),decision:z.enum(['patch','new_round']),making:DevelopmentMakingUpgradeSchema.optional(),reusableArtifacts:z.boolean(),reason:z.string().trim().min(1).max(2000)}).strict().superRefine((v,c)=>{if(v.decision==='patch'&&!v.reusableArtifacts)c.addIssue({code:'custom',message:'关键成果不能复用时须建立新轮次'});});

export type TechnicalArtifactBody=z.infer<typeof TechnicalArtifactBodySchema>;
export type TechnicalSizeTable=z.infer<typeof TechnicalSizeTableSchema>;
export type SaveTechnicalArtifact=z.infer<typeof SaveTechnicalArtifactSchema>;
export type RecordFinalComment=z.infer<typeof RecordFinalCommentSchema>;
export type CompleteSizeReview=z.infer<typeof CompleteSizeReviewSchema>;
export type DevelopmentCycleValues=z.infer<typeof DevelopmentCycleValuesSchema>;
export type TechnicalArtifact={artifactSetId:string;version:number;sourceId:string;roundNumber:number;scopeRef:string;taskId:string;documentVersion:number;status:'draft'|'published';body:TechnicalArtifactBody;createdBy:string;createdAt:string;inheritedFrom?:{sourceId:string;roundNumber:number}};
export type EffectiveTechnicalEvidence={sourceId:string;roundNumber:number;scopeRef:string;revision:string;state:'effective'|'pending_review'|'pending_customer'|'superseded'|'unknown';reasonCodes:string[];customerCode:string|null;finalCommentRef:{id:string;version:number}|null;reviewRef:{id:string;version:number}|null;artifactRef:{id:string;version:number}|null};
export type TechnicalFinalComment={commentId:string;version:number;roundNumber:number;scopeRef:string;isFinal:boolean;decision:'approved'|'changes_required'|'noted';text:string;evidenceRefs:string[];evidenceNote:string;customerCode:string|null;occurredAt:string|null;occurredDate?:string|null;timeEvidence?:{id:string;note:string;recordedAt:string;recordedBy:string}|null;recordedAt:string;reviewTaskId:string|null};
export type TechnicalSizeReview={reviewId:string;version:number;taskId:string;roundNumber:number;scopeRef:string;finalCommentId:string;finalCommentVersion:number;state:'pending'|'completed'|'superseded';decision:'reuse'|'revise'|null;artifactSetId:string|null;artifactVersion:number|null;note:string;assigneeId:string|null;dueAt:string|null};
export type DevelopmentCycleStatus={ruleVersion:typeof DEVELOPMENT_TECHNICAL_RULE;policyVersion:number;roundNumber:number;mode:'normal'|'urgent';publishedAt:string;completedAt:string|null;internalCompleted?:boolean;internalSeconds:number;excludedSeconds:number;allowedSeconds:number|null;calendarRef?:'continuous'|'natural_days'|'beijing_sunday_excluded'|null;state:'running'|'warning'|'overdue'|'completed'|'unrated';precisionReasons:string[];dueAt:string|null;urgentRevision:number;urgentState:'none'|'requested'|'approved'|'rejected'};
export type DevelopmentCommentRevisionLink={commentId:string;sourceId:string;roundNumber:number;status:'draft'|'published';timeRequestId:string|null};
export type DevelopmentTechnicalState={revisionCommentLinks?:DevelopmentCommentRevisionLink[];
 inheritedRevisionComment?:{ref:DevelopmentRevisionCommentRef;text:string;evidenceRefs:string[];previousRoundNumber:number;latest:DevelopmentCommentRevisionLink};enrolled:boolean;ruleVersion:typeof DEVELOPMENT_TECHNICAL_RULE|null;roundNumber:number;scopeRef:string;artifacts:TechnicalArtifact[];comments:TechnicalFinalComment[];reviews:TechnicalSizeReview[];effective:EffectiveTechnicalEvidence|null;cycle:DevelopmentCycleStatus|null;canRecordComment:boolean;canMaintainTemplates:boolean;canRequestUrgent:boolean;canApproveUrgent:boolean;canTriagePatch:boolean;patches:Array<{issueId:string;roundNumber:number;tailTaskId:string;note:string;decision:'patch'|'new_round'|null;workTaskId:string|null;nativeOrderId:string|null}>;preparationBasis:{version:number;basis:'first_development'|'confirmed_repeat';finalFabric:boolean;finalCraft:boolean;sampleEvidenceIds:string[];customerFabricEvidenceIds:string[];note:string}|null;materialDecisions:Array<{preshrinkMethod?:string|null;materialId:string;version:number;highTemperatureRequired:boolean|null;basis:string;supplierEvidenceIds:string[];warpShrinkPercent:string|null;weftShrinkPercent:string|null}>};

export const ExternalPaperIntervalSchema=z.object({requestId:z.string().uuid(),expectedVersion:z.number().int().nonnegative(),departedAt:z.iso.datetime({offset:true}).nullable(),note:z.string().trim().min(1).max(2000)}).strict();

export const CompleteDevelopmentPatchSchema=z.object({taskId:z.string().uuid(),note:z.string().trim().min(1).max(2000),attachmentIds:ids,measurements:z.array(z.object({name:z.string().trim().min(1),values:z.array(z.string().trim().max(32)).max(20)}).strict()).max(100).optional()}).strict();

/** Read-only technical projection. Counts are retained only for matching original size names; never guessed from a total. */
export function technicalMakingDocument(document:DevelopmentDocument,table:TechnicalSizeTable):DevelopmentDocument{
 return {...document,unit:table.unit,sampleSize:table.baseSize,sizes:table.sizes,
  measurements:table.measurements.map(row=>({name:row.name,values:row.values})),
  sizeQuantities:table.sizes.map(size=>{const index=document.sizes.indexOf(size);return index>=0?document.sizeQuantities?.[index]??null:null;})};
}
