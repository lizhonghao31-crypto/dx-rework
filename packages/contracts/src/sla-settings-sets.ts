import {CraftStepChoicesSchema} from './digital-craft.js';
import {z} from 'zod';
import {DigitalSlaValuesSchema,DIGITAL_SLA_PARAMETERS,validateDigitalSlaValues} from './digital-sla.js';
import {DevelopmentCycleValuesSchema} from './digital-development-technical.js';
export const SETTINGS_PLANNING_KEYS=[
 'development_materials','development_cutting','development_pre_wash_check','external_pattern','development_pattern','development_positioning','development_embroidery','development_printing','development_craft_dispatch','development_craft_return','development_sewing','development_accessories','development_sewing_transfer','development_washing','development_washing_dispatch','development_tail_check','development_shipping',
 'budget','production_sheet','bulk_pattern','sourcing_ie','sourcing_selection','sourcing_approval','fabric_inspection','warehouse_preshrink','bulk_cutting','bulk_embroidery','bulk_printing','bulk_qc','warehouse_accessories','warehouse_dispatch','factory_production_work','factory_production','return_logistics','garment_inspection','garment_packing','ship_sample',
] as const;
export const SettingsPlanningValueSchema=z.object({minutes:z.number().nonnegative().max(525600).refine(value=>Math.abs(value*60000-Math.round(value*60000))<1e-6,'规划时长须精确到毫秒').nullable(),calendar:z.enum(['continuous','natural_days','beijing_sunday_excluded']).nullable(),
 responsibilityAdopted:z.boolean().optional(),responsibilityMinutes:z.number().positive().max(525600).refine(value=>Math.abs(value*60000-Math.round(value*60000))<1e-6,'责任时长须精确到毫秒').optional(),responsibilityCalendar:z.enum(['continuous','natural_days','beijing_sunday_excluded']).optional(),
}).strict().superRefine((v,c)=>{if(v.responsibilityAdopted&&(!v.responsibilityMinutes||!v.responsibilityCalendar))c.addIssue({code:'custom',message:'独立责任标准须同时明确时长和日历'});});
export const SettingsPlanningSchema=z.partialRecord(z.enum(SETTINGS_PLANNING_KEYS),SettingsPlanningValueSchema).superRefine((values,context)=>{for(const[key,value]of Object.entries(values)){if(value&&(value.responsibilityAdopted||value.responsibilityMinutes!==undefined||value.responsibilityCalendar!==undefined)&&!['development_embroidery','development_printing','bulk_embroidery','bulk_printing'].includes(key))context.addIssue({code:'custom',path:[key],message:'仅串行双工艺可在此明确采用独立责任标准'});}});
export const SettingsSetValuesSchema=z.object({unified:DigitalSlaValuesSchema,development:DevelopmentCycleValuesSchema,planning:SettingsPlanningSchema}).strict();
export const SettingsSetBasisSchema=z.object({unifiedVersion:z.number().int().nonnegative(),developmentVersion:z.number().int().positive(),setVersion:z.number().int().nonnegative(),unifiedDraftRevision:z.number().int().nonnegative(),developmentDraftRevision:z.number().int().nonnegative()}).strict();
export const SettingsSetDraftSchema=SettingsSetBasisSchema.extend({values:SettingsSetValuesSchema,reason:z.string().trim().min(1).max(1000)}).strict();
export const SettingsSetSaveSchema=SettingsSetDraftSchema.extend({reason:z.string().trim().max(1000)});
export const SettingsSetPublishSchema=SettingsSetDraftSchema.extend({previewToken:z.string().max(512)}).strict();
export const SettingsSetRestoreSchema=SettingsSetBasisSchema.extend({setId:z.uuid().nullable(),unifiedSourceVersion:z.number().int().positive().nullable()}).strict().superRefine((v,c)=>{if((v.setId===null)===(v.unifiedSourceVersion===null))c.addIssue({code:'custom',message:'请选择一份真实历史记录'});});
export type SettingsPlanning=z.infer<typeof SettingsPlanningSchema>;
export type SettingsSetValues=z.infer<typeof SettingsSetValuesSchema>;
export type SettingsSetBasis=z.infer<typeof SettingsSetBasisSchema>;
export type SettingsSetDraft=z.infer<typeof SettingsSetDraftSchema>;
export type SettingsSetRecord={setId:string;version:number;unifiedVersion:number;developmentVersion:number;planning:SettingsPlanning;reason:string;recordedAt:string;sourceSetId:string|null};
export type SettingsSetRead={developmentHistory:Array<{version:number;reason:string}>;basis:SettingsSetBasis;current:SettingsSetValues;set:SettingsSetRecord|null;draft:{values:SettingsSetValues;reason:string;partialRestore:boolean;basis:SettingsSetBasis;baseline:SettingsSetValues}|null};
export type SettingsSetHistoryRow={setId:string|null;version:number|null;unifiedVersion:number;developmentVersion:number|null;reason:string;recordedAt:string;partial:boolean};
export type SettingsSetHistory={items:SettingsSetHistoryRow[];page:number;pageSize:15;totalCount:number};

export const SettingsCalculationSchema=z.object({values:SettingsSetValuesSchema,
 lines:z.array(z.object({id:z.string().trim().min(1).max(80),customerDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict()).min(1).max(20),
 development:z.object({enabled:z.boolean(),craftSteps:CraftStepChoicesSchema,washing:z.enum(['免洗','内洗','外洗']),accessories:z.boolean()}).strict(),
 bulk:z.object({craftSteps:CraftStepChoicesSchema,preshrink:z.boolean()}).strict(),
}).strict();
export type SettingsCalculationInput=z.infer<typeof SettingsCalculationSchema>;
export type SettingsCalculationResult={lines:Array<{id:string;customerDate:string;startAt:string|null;endAt:string|null;totalSpanMinutes:number|null;
 rows:Array<{id:string;parameterKey:string;label:string;stage:number;minutes:number|null;calendar:string|null;startAt:string|null;endAt:string|null;endDate:string|null;includedIn:string|null;missing:string[]}>;
 stages:Array<{stage:number;spanMinutes:number|null}>}>};

/** Validate the published values, including overridden included windows. */
export function validateSettingsSetValues(raw:unknown):SettingsSetValues{
 const values=SettingsSetValuesSchema.parse(raw);values.unified=validateDigitalSlaValues(values.unified);
 for(const parent of DIGITAL_SLA_PARAMETERS){
  const raw=values.unified[parent.key],planned=values.planning[parent.key as keyof typeof values.planning],minutes=planned?.minutes??(raw&&'minutes'in raw?raw.minutes:null);
  const included=DIGITAL_SLA_PARAMETERS.filter(child=>child.includedIn?.includes(parent.key));
  if(minutes!==null&&included.length){const used=included.reduce((total,child)=>{const planned=values.planning[child.key as keyof typeof values.planning],raw=values.unified[child.key];return total+(planned?.minutes??(raw&&'minutes'in raw?raw.minutes:0));},0);if(used>minutes)throw Error(parent.label+'规划内含合计不能超过父窗口');}
 }
 return values;
}
