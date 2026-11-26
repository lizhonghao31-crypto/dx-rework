import {z} from 'zod';
import {DevelopmentDocumentSchema,PublishDevelopmentSchema} from './digital-development.js';
import {DevelopmentRevisionCommentRefSchema} from './digital-development-technical.js';
export const DEVELOPMENT_REVISION_NODES=['核配','纸样','裁板','工艺','车板','洗水'] as const;
export const DEVELOPMENT_PROBLEM_CATEGORIES=['尺寸','版型','工艺','面料','辅料','车缝','洗水','其他'] as const;
export const DevelopmentRevisionSchema=z.object({
 basedOnRound:z.number().int().positive(),document:DevelopmentDocumentSchema,
 origin:z.enum(['客户新增要求','未达原要求','内部发现']),customerComment:z.string().trim().max(4000),internalProblem:z.string().trim().max(4000),explanation:z.string().trim().max(4000),
 categories:z.array(z.enum(DEVELOPMENT_PROBLEM_CATEGORIES)).min(1).max(8),affectedNodes:z.array(z.enum(DEVELOPMENT_REVISION_NODES)).min(1).max(6),outputKind:z.enum(['整件样板','工艺布片']),customerCommentRef:DevelopmentRevisionCommentRefSchema.optional(),
 repeatOriginalComment:z.object({sourceId:z.string().uuid(),roundNumber:z.number().int().positive()}).strict().optional()
}).strict().superRefine((value,ctx)=>{
 if(value.origin==='内部发现'?(!value.internalProblem||Boolean(value.customerComment)):(!value.customerComment||Boolean(value.internalProblem)))ctx.addIssue({code:'custom',message:'客户修改须填客户原评语；内部修改须填内部问题，不能混写'});
 if(value.customerCommentRef&&(value.origin==='内部发现'||(!value.repeatOriginalComment&&value.customerCommentRef.roundNumber!==value.basedOnRound)))ctx.addIssue({code:'custom',path:['customerCommentRef'],message:'仅可采用本轮的真实客户评语'});
 if(value.repeatOriginalComment&&!value.customerCommentRef)ctx.addIssue({code:'custom',path:['repeatOriginalComment'],message:'再次发起须明确采用原客户评语'});
 if(new Set(value.affectedNodes).size!==value.affectedNodes.length||new Set(value.categories).size!==value.categories.length)ctx.addIssue({code:'custom',message:'问题分类和受影响节点不能重复'});
 if(value.outputKind==='工艺布片'&&(value.document.craft==='无'||value.affectedNodes.some(node=>['车板','洗水'].includes(node))))ctx.addIssue({code:'custom',message:'工艺布片须有印绣花，且不包含整件车板或洗水'});
});
export const SaveDevelopmentRevisionSchema=z.object({expectedDraftVersion:z.number().int().nonnegative(),revision:DevelopmentRevisionSchema}).strict();
export const PublishDevelopmentRevisionSchema=z.object({expectedDraftVersion:z.number().int().nonnegative(),basedOnRound:z.number().int().positive(),
 revision:DevelopmentRevisionSchema.optional(),publishCurrent:z.literal(true).optional(),expectedBasisVersion:z.number().int().positive().optional(),patternOrder:PublishDevelopmentSchema.shape.patternOrder,
}).strict().superRefine((value,ctx)=>{
 if(value.revision?value.revision.basedOnRound!==value.basedOnRound||!value.revision.customerCommentRef&&!value.publishCurrent:value.expectedDraftVersion===0)
  ctx.addIssue({code:'custom',message:'请核对当前复版资料版本，或读取已有复版草稿'});
 if((value.publishCurrent&&(!value.revision||!value.expectedBasisVersion||value.revision.origin==='内部发现'))||(!value.publishCurrent&&(value.patternOrder||value.expectedBasisVersion)))
  ctx.addIssue({code:'custom',message:'请从当前版单带出本次发布内容和适用的执行价'});
});
export type DevelopmentRevision=z.infer<typeof DevelopmentRevisionSchema>;
