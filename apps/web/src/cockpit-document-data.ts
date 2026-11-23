import type {OrderJourney} from "@dx-rework/contracts/digital-production-journey";
export type CockpitDocumentFile={id:string;name:string;path:string|null;note?:string|undefined;at?:string|undefined;by?:string|undefined};
export type CockpitDocumentMetadataFact={label:string;at:string;by:string};
export type CockpitDocumentEntry={sourceOnly?:boolean;technicalPart?:'plt'|'sizes'|'consumption'|'comment'|'final'|'legacy_pattern';id:string;label:string;url?:string|undefined;originalUrl?:string|undefined;originalEntries?:CockpitDocumentEntry[];note?:string|undefined;at?:string|undefined;by?:string|undefined;metadata?:CockpitDocumentMetadataFact[];files?:CockpitDocumentFile[];children?:CockpitDocumentEntry[];load?:{part?:'plt'|'sizes'|'consumption'|'comment'|'final';kind:string;path:string;originalPath?:string;id:string;version?:number|undefined;round?:string|undefined;cursor?:number|undefined;scopeRef?:string|undefined;resourceKind?:"order"|"source"|undefined;productionArtifact?:{id:string;version:number;sourceId:string;roundNumber:number}|undefined;instructionVersion?:number|undefined}|undefined};
export type CockpitDocumentResult={legacy?:boolean;state:"created"|"missing"|"not_applicable"|"unknown";entries:CockpitDocumentEntry[];note?:string;nextPage?:number|null};
export type CockpitDocumentReader=(path:string,signal:AbortSignal)=>Promise<unknown>;
export type Row=Record<string,unknown>;
export const row=(value:unknown):Row=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Row:{};
export const rows=(value:unknown):Row[]=>Array.isArray(value)?value.map(row):[];
export const str=(value:unknown)=>typeof value==="string"?value:"";
export const num=(value:unknown)=>typeof value==="number"?value:0;
export const strings=(value:unknown)=>Array.isArray(value)?value.filter((v):v is string=>typeof v==="string"):[];
export const file=(id:string,name:string,path:string|null,note?:string):CockpitDocumentFile=>({id,name,path,...(note?{note}:{})});
export const apiFile=(id:string,name:string)=>file(id,name,`tools/attachments/${id}/download?mode=preview`);
export const result=(entries:CockpitDocumentEntry[],note?:string):CockpitDocumentResult=>({state:entries.some(e=>!e.sourceOnly)?"created":entries.length?"unknown":"missing",entries,...(note?{note}:{})});
export const approvalStatuses:Record<string,string>={pending:"待审批",pending_management:"待审批",approved:"已批准",rejected:"已退回",cancelled:"已取消"};
export const requireFields=(value:Row,fields:string[])=>{if(fields.some(field=>!Object.hasOwn(value,field)))throw new Error("资料返回不完整，请刷新重试");};
// HTTP success alone is not evidence that a collection is empty. Validate before
// converting metadata into an existence fact (the snapshot evicts rejected reads).
export const invalidMetadata=():never=>{throw new Error("资料返回类型异常，尚不能确认是否已创建；请重试读取目录");};
export const objectValue=(value:unknown):value is Row=>value!==null&&typeof value==="object"&&!Array.isArray(value);
export const textValue=(value:unknown)=>typeof value==="string"&&value.length>0;
export const integerValue=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
export const positiveValue=(value:unknown)=>integerValue(value)&&(value as number)>0;
export const nullableText=(value:unknown)=>value===null||textValue(value);
export const checkedRows=(value:unknown,valid:(item:Row)=>boolean=()=>true):Row[]=>{
 if(!Array.isArray(value)||!value.every(item=>objectValue(item)&&valid(item)))return invalidMetadata();return value as Row[];
};
export const checkedNumbers=(value:unknown):number[]=>{if(!Array.isArray(value)||!value.every(positiveValue))return invalidMetadata();return value as number[];};
export const check=(valid:boolean)=>{if(!valid)invalidMetadata();};
export const sameEntity=(value:Row,key:string,expected:string,label:string)=>{requireFields(value,[key]);if(value[key]!==expected)throw new Error(`${label}与本单不一致，本次未确认；请刷新后从原单进入`);};
export const na=():CockpitDocumentResult=>({state:"not_applicable",entries:[],note:"当前没有此类业务来源。"});
export const records=(order:OrderJourney,domain:string)=>[...new Map([...order.links,...order.stages.flatMap(stage=>stage.nodes.flatMap(node=>node.records))].filter(record=>record.domain===domain&&record.url).map(record=>[record.id,record])).values()];
export const original=(kind:string,id:string,version?:number|undefined)=>`/ui/digital-production?${kind}=${id}${version?`&${kind==="development"?"round":kind==="budget"?"budgetVersion":"instructionVersion"}=${version}`:""}`;

