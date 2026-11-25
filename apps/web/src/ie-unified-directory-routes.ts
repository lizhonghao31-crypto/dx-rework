import {UnifiedIeDirectoryQuerySchema,type UnifiedIeDirectoryEntry,type UnifiedIeDirectoryQuery} from '@dx-rework/contracts/digital-quotation';
import {z} from 'zod';

const focusEntry=z.string().regex(/^(processing_quote|sourcing_review|rework_review):[0-9a-f-]{36}:[0-9a-f-]{36}$/);
const locationSchema=UnifiedIeDirectoryQuerySchema.extend({directory:z.literal('unified'),focus:focusEntry.optional(),
 kind:z.union([z.literal('all'),z.literal('processing_quote'),z.literal('sourcing_review'),z.literal('rework_review')]).default('all'),
 detail:z.discriminatedUnion('type',[
  z.object({type:z.literal('processing_quote'),quoteId:z.uuid(),rowId:z.uuid(),id:z.uuid(),resourceKind:z.enum(['source','order'])}).strict(),
  z.object({type:z.literal('sourcing_review'),caseId:z.uuid()}).strict(),
 ]).optional(),
});
export type UnifiedIeLocation=z.infer<typeof locationSchema>;
export const unifiedIeEntryKey=(row:UnifiedIeDirectoryEntry)=>`${row.kind}:${row.objectId}:${row.entryId}`;
export const unifiedIeListLabel={all:'全部类型',processing_quote:'外发加工报价',sourcing_review:'外发加工核价',rework_review:'返工核价与复核'} as const;
export const unifiedIeStateLabel={all:'全部状态',not_started:'未开始',awaiting_price:'待核价',returned:'退回重核',priced:'已核价'} as const;

export function parseUnifiedIeLocation(params:URLSearchParams){
 const {detail,...rest}=Object.fromEntries(params);
 if([...new Set(params.keys())].some(key=>params.getAll(key).length!==1))return null;
 let selection:unknown;
 try{selection=detail===undefined?undefined:JSON.parse(detail);}catch{return null;}
 const parsed=locationSchema.safeParse({...rest,...(selection===undefined?{}:{detail:selection})});
 return parsed.success?parsed.data:null;
}

export function unifiedIeHref(path:string,query:UnifiedIeDirectoryQuery,extra:Pick<UnifiedIeLocation,'focus'|'detail'>={}){
 const params=new URLSearchParams({directory:'unified',kind:query.kind,page:String(query.page),search:query.search});
 if(query.state&&query.state!=='all')params.set('state',query.state);
 if(extra.focus)params.set('focus',extra.focus);
 if(extra.detail)params.set('detail',JSON.stringify(extra.detail));
 return `${path}?${params}`;
}

export function unifiedIeOriginalHref(paths:{directory:string;reworkProcess:string;reworkReporting:string},query:UnifiedIeDirectoryQuery,row:UnifiedIeDirectoryEntry){
 const focus=unifiedIeEntryKey(row);
 if(row.kind==='processing_quote')return unifiedIeHref(paths.directory,query,{focus,detail:{type:row.kind,quoteId:row.objectId,
  rowId:row.entryId,id:row.resourceId,resourceKind:row.orderId===null?'source':'order'}});
 if(row.kind==='sourcing_review')return unifiedIeHref(paths.directory,query,{focus,detail:{type:row.kind,caseId:row.objectId}});
 const process=row.nativeStatus==='pending_ie_review';
 if(!process&&!['pending_final_quantity_ie_review','pending_quantity_adjustment_ie_review'].includes(row.nativeStatus))return null;
 return `${process?paths.reworkProcess:paths.reworkReporting}?${new URLSearchParams({rework:row.objectId,
  ieReturn:unifiedIeHref(paths.directory,query,{focus})})}`;
}
