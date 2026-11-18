import {z} from 'zod';
import {DevelopmentDocumentSchema,type DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import {InitialCustomerOrderDraftSchema,type InitialCustomerOrderDraft} from '@dx-rework/contracts/digital-production';
import type {PendingDevelopmentSubmission} from './development-submit-recovery.js';

/** One unfinished original creation view in this tab, scoped by a freshly read
 * actor and environment. A pure draft has no source, command, key or version. */
export type CreationDraftIdentity={actorId:string;environment:string};
export type CreationDraftSnapshot={intent:'development'|'certain_order';form:InitialCustomerOrderDraft;document:DevelopmentDocument;quantityInput:string;sizeQuantityInputs:string[];developmentType:'头版'|'开发板';preorder:boolean;fixedCraft:boolean;measurementIds:string[];poSizeIds:string[];sharedPoColumns:boolean;dateOverrides:number[];fileKind:DevelopmentDocument['files'][number]['kind'];patternChoice:{categoryId:string;priceVersion:number}|null;baseline:string;localFiles:Array<{id:string;name:string;type:string;size:number;kind:DevelopmentDocument['files'][number]['kind']}>};
export type CreationDraftRecord={schemaVersion:1;viewId:string;identity:CreationDraftIdentity;open:boolean;snapshot:CreationDraftSnapshot}&(
 |{phase:'draft'}
 |{phase:'bound';sourceId:string;version:number|null}
 |{phase:'pending';sourceId:string|null;beforeVersion:number|null;original:{path:string;method:'POST'|'PUT';key:string;body:string};native?:PendingDevelopmentSubmission}
);
const identitySchema=z.object({actorId:z.uuid(),environment:z.string().min(1).max(1000)}).strict();
const fileKind=DevelopmentDocumentSchema.shape.files.element.shape.kind;
const textArray=z.array(z.string()),snapshotSchema=z.object({intent:z.enum(['development','certain_order']),form:z.unknown(),document:z.unknown(),quantityInput:z.string(),sizeQuantityInputs:textArray,developmentType:z.enum(['头版','开发板']),preorder:z.boolean(),fixedCraft:z.boolean(),measurementIds:textArray,poSizeIds:textArray,sharedPoColumns:z.boolean(),dateOverrides:z.array(z.number().int().nonnegative()),fileKind,patternChoice:z.object({categoryId:z.uuid(),priceVersion:z.number().int().positive()}).strict().nullable(),baseline:z.string(),localFiles:z.array(z.object({id:z.string(),name:z.string(),type:z.string(),size:z.number().int().nonnegative(),kind:fileKind}).strict())}).strict();
const originalSchema=z.object({path:z.string().max(300),method:z.enum(['POST','PUT']),key:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),body:z.string()}).strict();
const nativeSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('publish'),sourceId:z.uuid(),key:originalSchema.shape.key,body:z.object({expectedVersion:z.number().int().nonnegative(),patternOrder:z.object({categoryId:z.uuid(),priceVersion:z.number().int().positive()}).strict().optional()}).strict()}).strict(),
 z.object({operation:z.literal('confirm'),sourceId:z.uuid(),key:originalSchema.shape.key,body:z.record(z.string(),z.unknown())}).strict(),
]);
const common={schemaVersion:z.literal(1),viewId:z.uuid(),identity:identitySchema,open:z.boolean(),snapshot:snapshotSchema};
const version=z.number().int().nonnegative();
const recordSchema=z.discriminatedUnion('phase',[z.object({...common,phase:z.literal('draft')}).strict(),z.object({...common,phase:z.literal('bound'),sourceId:z.uuid(),version:version.nullable()}).strict(),z.object({...common,phase:z.literal('pending'),sourceId:z.uuid().nullable(),beforeVersion:version.nullable(),original:originalSchema,native:nativeSchema.optional()}).strict()]);
type DraftStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const key=(identity:CreationDraftIdentity)=>'dx:development-creation:v1:'+JSON.stringify(identitySchema.parse(identity));
/** Inspect structural errors but preserve the original value. Trimming,
 * defaults and business completeness constraints do not rewrite user input. */
function rawStructure(schema:z.ZodType,value:unknown){
 const result=schema.safeParse(value);
 if(!result.success&&result.error.issues.some(issue=>['invalid_type','unrecognized_keys','invalid_value'].includes(issue.code)))throw Error('本页草稿结构尚不能安全恢复；原记录保留，不创建新单');
}
function validate(value:unknown):CreationDraftRecord{
 const checked=recordSchema.parse(value);rawStructure(InitialCustomerOrderDraftSchema,checked.snapshot.form);rawStructure(DevelopmentDocumentSchema,checked.snapshot.document);
 const snapshot=checked.snapshot as CreationDraftSnapshot;
 if(!snapshot.form.lines.length)throw Error('本页原PO行结构不完整，保留草稿，不创建新单');
 if(snapshot.measurementIds.length!==snapshot.document.measurements.length||snapshot.poSizeIds.length<Math.max(...snapshot.form.lines.map(line=>line.sizes.length)))throw Error('本页原草稿行身份不完整；记录保留，不创建新单');
 if(checked.phase==='pending'){
  const id=checked.sourceId,allowed=id?[`sources/${id}/development`,`sources/${id}/development/publish`,`sources/${id}/confirm`]:['sources'];
  if(!allowed.includes(checked.original.path)||checked.original.method!==(checked.original.path===`sources/${id}/development`?'PUT':'POST'))throw Error('原创建命令范围不符，保留记录，不能重发');
  JSON.parse(checked.original.body);
  if(checked.native&&(checked.native.sourceId!==id||checked.native.key!==checked.original.key||checked.original.path!==(checked.native.operation==='publish'?`sources/${id}/development/publish`:`sources/${id}/confirm`)||JSON.stringify(checked.native.body)!==checked.original.body))throw Error('原创建回执身份不一致；记录保留，不能重发');
 }
 return checked as CreationDraftRecord;
}
export function readCreationDraft(storage:DraftStorage,identity:CreationDraftIdentity):CreationDraftRecord|null{
 const raw=storage.getItem(key(identity));if(raw===null)return null;if(raw.length>4*1024*1024)throw Error('本页草稿过大，记录保留，未提交');
 const record=validate(JSON.parse(raw));if(JSON.stringify(record.identity)!==JSON.stringify(identitySchema.parse(identity)))throw Error('本页草稿身份不符，记录保留');return record;
}
export function writeCreationDraft(storage:DraftStorage,record:CreationDraftRecord,resolvedOriginal?:{path:string;key:string}){
 const checked=validate(record),raw=JSON.stringify(checked);if(raw.length>4*1024*1024)throw Error('本页草稿未能保存，未开始新提交');
 const prior=readCreationDraft(storage,record.identity);
 if(prior&&prior.viewId!==record.viewId)throw Error('本页原草稿已变化，不能用旧回包覆盖');
 if(prior?.phase==='pending'&&(checked.phase!=='pending'||JSON.stringify(prior.original)!==JSON.stringify(checked.original))&&!(resolvedOriginal?.key===prior.original.key&&resolvedOriginal.path===prior.original.path))throw Error('原创建命令尚未核实，不能替换或清除');
 storage.setItem(key(record.identity),raw);if(storage.getItem(key(record.identity))!==raw)throw Error('本页草稿保存未取得确认，未开始新提交');
}
export function clearCreationDraft(storage:DraftStorage,identity:CreationDraftIdentity,viewId:string,resolvedOriginal?:{path:string;key:string}){
 const prior=readCreationDraft(storage,identity);if(prior&&prior.viewId!==viewId)throw Error('本页原草稿已变化，不能清除较新内容');
 if(prior?.phase==='pending'&&!(resolvedOriginal?.key===prior.original.key&&resolvedOriginal.path===prior.original.path))throw Error('原创建命令尚未核实，不能清除');
 storage.removeItem(key(identity));
 if(storage.getItem(key(identity))!==null)throw Error('原操作已确认，本页恢复记录尚未确认清理；请保留页面，不能另提');
}
