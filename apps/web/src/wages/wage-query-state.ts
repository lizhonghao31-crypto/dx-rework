import { ReportQuerySchema } from "@dx-rework/contracts/reporting";

const filterKeys=["from","to","q","personType","wageSource","patternKind","status"] as const;
const pageValue=(value:string|null)=>value&&/^[1-9]\d{0,5}$/.test(value)?Math.min(100_000,Number(value)):1;
export function readWageListQuery(search:string) {
  const params=new URLSearchParams(search),input:Record<string,string>={};
  for(const key of filterKeys) if(params.get(key)) input[key]=params.get(key)!;
  const parsed=ReportQuerySchema.safeParse(input);
  return {...(parsed.success?parsed.data:{}),page:pageValue(params.get("page")),personPage:pageValue(params.get("personPage"))};
}
export function wageListPath(query:Readonly<Record<string,string|number|undefined>>) {
  const params=new URLSearchParams();
  for(const key of [...filterKeys,"page","personPage"]) {
    const value=query[key];if(value!==undefined&&value!==""&&(!["page","personPage"].includes(key)||Number(value)>1)) params.set(key,String(value));
  }
  return `/ui/wages${params.size?`?${params}`:""}`;
}
export function wageReturnPath(value:string|null):string|null {
  if(!value||value.includes("\\")||value.split("?")[0]!=="/ui/wages")return null;
  return wageListPath(readWageListQuery(value.includes("?")?value.slice(value.indexOf("?")):""));
}
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function wageSourcePath(row:Readonly<Record<string,unknown>>,returnTo:string):string|null {
  if(row.sourceStatus!=="available"||!uuid(row.sourceOrderId))return null;
  const params=new URLSearchParams({returnTo:wageReturnPath(returnTo)??"/ui/wages"});
  if(row.wageSource==="order_rework")return `/ui/tasks/${row.sourceOrderId}?${params}`;
  if(row.wageSource!=="pattern_room"||!uuid(row.roundId)||!uuid(row.segmentId))return null;
  params.set("round",row.roundId);params.set("segment",row.segmentId);
  return `/ui/pattern-room/orders/${row.sourceOrderId}?${params}#segment-${row.segmentId}`;
}
