import {z} from 'zod';

export const AcceptanceClockResourceSchema=z.object({kind:z.enum(['source','order','task','sourcing','cutting','production','receiving','rework']),id:z.uuid()}).strict();
export type AcceptanceClockResource=z.infer<typeof AcceptanceClockResourceSchema>;
const version=z.number().int().nonnegative();
export const AcceptanceClockCreateSchema=z.object({name:z.string().trim().min(1).max(80),requestKey:z.uuid(),copyScenarioId:z.uuid().optional()}).strict();
export const AcceptanceClockAdvanceSchema=z.object({expectedVersion:version,requestKey:z.uuid(),at:z.iso.datetime({offset:true}),previewToken:z.string().min(1).max(2048).optional()}).strict();
export const AcceptanceClockPreviewSchema=z.object({nodeId:z.string().min(1).max(180),boundary:z.enum(['warning_before','warning','due_before','due','due_after'])}).strict();
export const AcceptanceClockStandardSchema=z.object({expectedVersion:version,configurationId:z.uuid(),requestKey:z.uuid()}).strict();
export type AcceptanceClockView=Readonly<{
 scenarioId:string;name:string;now:string;version:number;configurationId:string;configurationVersion:number;
 sourceIds:readonly string[];orderIds:readonly string[];recordedAt:string;lastScan:Readonly<{status:'pending'|'completed'|'failed';recordedAt:string;message:string}>|null;
}>;
