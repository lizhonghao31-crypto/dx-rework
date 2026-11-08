import {z} from 'zod';
import {DigitalSlaValuesSchema} from './digital-sla.js';
import {DevelopmentCycleValuesSchema} from './digital-development-technical.js';

export const SlaDraftGroupSchema=z.enum(['unified','development']);
export type SlaDraftGroup=z.infer<typeof SlaDraftGroupSchema>;
const revision=z.number().int().nonnegative();
const base={expectedVersion:revision,expectedDraftRevision:revision,reason:z.string().trim().max(1000)};
export const SlaDraftSaveSchema=z.discriminatedUnion('group',[
 z.object({...base,group:z.literal('unified'),values:DigitalSlaValuesSchema}).strict(),
 z.object({...base,group:z.literal('development'),values:DevelopmentCycleValuesSchema}).strict(),
]);
export type SlaDraftSave=z.infer<typeof SlaDraftSaveSchema>;
export const SlaDraftDiscardSchema=z.object({group:SlaDraftGroupSchema,expectedDraftRevision:revision}).strict();
const saved={revision:z.number().int().positive(),expectedVersion:revision,reason:z.string().max(1000),savedAt:z.iso.datetime({offset:true})};
export const SlaSavedDraftSchema=z.discriminatedUnion('group',[
 z.object({...saved,group:z.literal('unified'),values:DigitalSlaValuesSchema,baselineValues:DigitalSlaValuesSchema}).strict(),
 z.object({...saved,group:z.literal('development'),values:DevelopmentCycleValuesSchema,baselineValues:DevelopmentCycleValuesSchema}).strict(),
]);
export type SlaSavedDraft=z.infer<typeof SlaSavedDraftSchema>;
const envelope={group:SlaDraftGroupSchema,currentStandardVersion:revision,revision,draft:SlaSavedDraftSchema.nullable()};
export const SlaDraftEnvelopeSchema=z.object(envelope).strict()
 .refine(value=>!value.draft||value.draft.group===value.group&&value.draft.revision===value.revision,'草稿对象与当前版本不一致');
export type SlaDraftEnvelope=z.infer<typeof SlaDraftEnvelopeSchema>;
export const SlaDraftSavedReplySchema=z.object({saved:SlaSavedDraftSchema,currentRevision:z.number().int().positive(),currentStandardVersion:revision,superseded:z.boolean()}).strict()
 .refine(value=>value.superseded===(value.saved.revision!==value.currentRevision),'草稿保存回执的当前版本不一致');
export type SlaDraftSavedReply=z.infer<typeof SlaDraftSavedReplySchema>;
export const SlaDraftDiscardedReplySchema=z.object({...envelope,discardedRevision:z.number().int().positive(),superseded:z.boolean()}).strict()
 .refine(value=>value.superseded===(value.discardedRevision!==value.revision),'丢弃草稿回执的当前版本不一致');
export type SlaDraftDiscardedReply=z.infer<typeof SlaDraftDiscardedReplySchema>;
