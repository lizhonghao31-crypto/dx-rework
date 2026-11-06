import {z} from 'zod';
import {DigitalSlaValuesSchema,type DigitalSlaValues} from './digital-sla.js';
import {DevelopmentCycleValuesSchema,type DevelopmentCycleValues} from './digital-development-technical.js';

export const SLA_CALCULATOR_VERSION='m01-calculation-1' as const;
export const SLA_CALENDAR_VERSION='beijing-sunday-0207-v1' as const;
export const SLA_CALCULATION_ROUTE_VERSION='m01-routes-1' as const;
export const SlaCalculationRangeSchema=z.enum(['development','preparation','bulk_craft','delivery','contract']);
const anchor=z.discriminatedUnion('precision',[
 z.object({precision:z.literal('instant'),value:z.iso.datetime({offset:true}),source:z.string().trim().min(1).max(300)}).strict(),
 z.object({precision:z.literal('date'),value:z.iso.date(),source:z.string().trim().min(1).max(300)}).strict(),
 z.object({precision:z.literal('unknown'),reason:z.string().trim().min(1).max(500)}).strict(),
]);
export type CalculationAnchor=z.infer<typeof anchor>;
export const CalculationAnchorSchema=anchor;
export type CalculationEstimateRange={fromInclusive:string;toExclusive:string;shippedOn:string;source:string;actualDispatchedAt:null};
export const SlaCalculationConditionsSchema=z.object({
 craft:z.enum(['none','printing','embroidery','print_embroidery','unknown']),
 craftExecution:z.enum(['internal','external','unknown']),
 pattern:z.enum(['internal','external','unknown']),
 washing:z.enum(['none','internal','external','unknown']),
 preshrink:z.enum(['yes','no','unknown']),
 preparation:z.enum(['adopted','legacy','unknown']),
 developmentMode:z.enum(['normal','urgent']),
 rework:z.enum(['yes','no','unknown']),
}).strict();
export type SlaCalculationConditions=z.infer<typeof SlaCalculationConditionsSchema>;
// A reference is an explicit example input, never an instance fact or an arbitrary graph.
export const SLA_REFERENCE_KEYS=['development_published','external_pattern_requested','customer_order_confirmed','instruction_published','whole_fabric_arrived','final_preparation_ready','cut_craft_dispatched','whole_cutting_completed','sourcing_decided','factory_production_finished','factory_return_dispatched','garment_arrived','garment_qc_completed','rework_assignments_confirmed','round_actual_work_completed','original_packing_conditions_ready','contract_pdf_ready','factory_delivery_date','customer_shipping_date','final_comment_recorded'] as const;
const references=z.partialRecord(z.enum(SLA_REFERENCE_KEYS),anchor).refine(v=>Object.keys(v).length<=SLA_REFERENCE_KEYS.length);
export const SlaCalculationSelectionSchema=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('example'),range:SlaCalculationRangeSchema,conditions:SlaCalculationConditionsSchema,references}).strict(),
 z.object({mode:z.literal('instance'),range:SlaCalculationRangeSchema,kind:z.enum(['source','order']),id:z.string().uuid(),round:z.number().int().positive().optional(),poLineId:z.string().uuid().optional(),batchId:z.string().uuid().optional()}).strict(),
]);
export const SlaCalculationPreviewSchema=z.object({
 selection:SlaCalculationSelectionSchema,
 unified:z.object({expectedVersion:z.number().int().nonnegative(),values:DigitalSlaValuesSchema}).strict().optional(),
 development:z.object({expectedVersion:z.number().int().positive(),values:DevelopmentCycleValuesSchema}).strict().optional(),
 checkContextDigest:z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();
export type SlaCalculationPreviewInput=z.infer<typeof SlaCalculationPreviewSchema>;
export type SlaCalculationSelection=z.infer<typeof SlaCalculationSelectionSchema>;
export type CalculationNode={
 id:string;label:string;stage:number;parameterKey:string;
 applicable:'yes'|'no'|'unknown';countsProgress:boolean;
 kind:'duration'|'included'|'estimate'|'order_date'|'unlimited'|'offset';
 minutes:number|null;offsetDays:number|null;dependsOn:string[];anchorKey:string|null;targetKey:string|null;
 includedIn:string|null;includedPosition:'start'|'end';
 calendar:'continuous'|'natural_days'|'beijing_sunday_excluded';
 source:string;binding:{group:'unified'|'development';key:string}|null;
 completedAt?:CalculationAnchor;
 waitingFor?:string;
 independent?:boolean;
 exclusion?:{knownMs:number|null;reasons:string[]};
 estimateRange?:CalculationEstimateRange;
};
export type CalculationGraph={
 observationMode:'example'|'instance';
 nodes:CalculationNode[];anchors:Record<string,CalculationAnchor>;warningPercent:number;stageBufferMinutes:number;
 endIds:string[];rangeLabel:string;startLabel:string;endLabel:string;
 startIds?:string[];
};
export type CalculationTime={at:string|null;exclusive:boolean;reasons:string[]};
export type CalculationRow={
 id:string;label:string;stage:number;kind:CalculationNode['kind'];applicable:CalculationNode['applicable'];
 source:string;calendar:CalculationNode['calendar'];minutes:number|null;offsetDays:number|null;
 start:CalculationTime;end:CalculationTime;target:CalculationTime|null;
 determiningPredecessors:string[];basis:'standard'|'actual'|'reference'|'target'|'unknown';
 includedIn:string|null;independent:boolean;
 estimateRange?:CalculationEstimateRange;
};
export type SlaCalculationResult={
 calculatorVersion:typeof SLA_CALCULATOR_VERSION;calendarVersion:typeof SLA_CALENDAR_VERSION;
 rows:CalculationRow[];
 stages:Array<{stage:number;start:CalculationTime;end:CalculationTime;spanMs:number|null;partial:boolean;missing:string[]}>;
 overall:{status:'complete'|'partial';start:CalculationTime;end:CalculationTime;spanMs:number|null;determiningNodes:string[];missing:string[];knownBranches:Array<{id:string;start:CalculationTime;end:CalculationTime;spanMs:number|null}>};
 rangeLabel:string;startLabel:string;endLabel:string;
};
export type SlaCalculationContext={
 selection:SlaCalculationSelection;
 identity:{kind:'example'|'source'|'order';id:string|null;sourceId:string|null;orderId:string|null;round:number|null;label:string};
 unified:{version:number;values:DigitalSlaValues};
 development:{version:number;values:DevelopmentCycleValues};
 graph:CalculationGraph;
 bindings:Record<string,unknown>;
 limitations:string[];
};
export type SlaCalculationPreview={
 context:SlaCalculationContext;contextDigest:string;contextChanged:boolean;
 current:SlaCalculationResult;draft:SlaCalculationResult;
 differences:{overallMs:number|null;stages:Array<{stage:number;spanMs:number|null}>;nodes:Array<{id:string;endMs:number|null}>};
 calculationReceipt:{purpose:'read_only_calculation';contextDigest:string;valuesDigest:string;resultDigest:string;calculatorVersion:typeof SLA_CALCULATOR_VERSION;calendarVersion:typeof SLA_CALENDAR_VERSION;status:'complete'|'partial'};
};
