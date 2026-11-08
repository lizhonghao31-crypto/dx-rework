import {z} from 'zod';
import {DeliveryCalendarFiltersSchema,DeliveryDayQuerySchema,DeliveryListGroupSchema,DeliveryMissingKindSchema,type DeliveryCalendarFilters,type DeliveryDay,type DeliverySummary} from '@dx-rework/contracts/delivery-calendar';
import {isCalendarDate} from '@dx-rework/contracts/series-calendar';

export const DeliveryPageStateSchema=DeliveryCalendarFiltersSchema.extend({
 view:z.enum(['year','month','day','missing']).default('year'),
 date:DeliveryDayQuerySchema.shape.date,
 page:z.coerce.number().int().min(1).max(10000).default(1),
 group:DeliveryListGroupSchema.default('day'),
 backView:z.enum(['year','month','day']).default('month'),
 allMissing:z.literal('1').optional(),
 missingKind:DeliveryMissingKindSchema.default('all'),
});
export type DeliveryPageState=z.infer<typeof DeliveryPageStateSchema>;
export function readDeliveryPageState(search:string,today:string):DeliveryPageState{
 const params=new URLSearchParams(search);
 if(params.getAll('workspace').length>1||params.has('workspace')&&params.get('workspace')!=='delivery')throw Error('交付页面地址无效，请重新进入交付点阵图');
 params.delete('workspace');
 if([...params.keys()].length!==new Set(params.keys()).size)throw Error('筛选条件重复，请重新选择');
 const parsed=DeliveryPageStateSchema.safeParse({date:today,...Object.fromEntries(params)});
 if(!parsed.success)throw Error('请核对交付日期、筛选条件和页码');
 return parsed.data;
}
export function deliveryPagePath(state:DeliveryPageState):string{
 const parsed=DeliveryPageStateSchema.parse(state),params=new URLSearchParams({workspace:'delivery',view:parsed.view,date:parsed.date});
 for(const [key,value]of Object.entries(parsed)){
  if(['view','date'].includes(key)||value===undefined||value===''||key==='page'&&value===1||key==='scope'&&value==='current'||key==='group'&&value==='day'||['backView','allMissing','missingKind'].includes(key)&&parsed.view!=='missing')continue;
  params.set(key,String(value));
 }
 return '/ui/digital-cockpit?'+params;
}
/** Only a validated local calendar context may become an order-detail return. */
export function deliveryReturnPath(value:string|null,base='/'):string|null{
 if(!value||!value.startsWith('/')||value.startsWith('//')||value.includes('\\'))return null;
 try{
  const url=new URL(value,'https://local.invalid'),prefix=base==='/'?'':base.replace(/\/$/,'');
  if(url.origin!=='https://local.invalid'||url.hash||!['/ui/digital-cockpit',prefix+'/ui/digital-cockpit'].includes(url.pathname)||url.searchParams.get('workspace')!=='delivery'||!url.searchParams.has('date'))return null;
  return deliveryPagePath(readDeliveryPageState(url.search,'2000-01-01'));
 }catch{return null;}
}
export const deliveryFilters=(state:DeliveryPageState):DeliveryCalendarFilters=>DeliveryCalendarFiltersSchema.parse({search:state.search,customer:state.customer,status:state.status,scope:state.scope});
export function deliveryApiQuery(state:DeliveryPageState,kind:'year'|'month'|'day'|'missing',options:{snapshotId?:string;page?:number}={}):string{
 const query=new URLSearchParams();
 for(const [key,value]of Object.entries(deliveryFilters(state)))if(value!==undefined&&value!=='')query.set(key,String(value));
 if(kind==='year')query.set('year',state.date.slice(0,4));
 else if(kind==='month'){query.set('month',state.date.slice(0,7));query.set('selectedDate',state.date);query.set('page',String(options.page??state.page));query.set('pageSize','15');}
 else if(kind==='day'){query.set('date',state.date);query.set('group',state.group);}
 else if(state.allMissing!=='1'){if(state.backView==='year')query.set('year',state.date.slice(0,4));else query.set('month',state.date.slice(0,7));}
 if(kind==='day'||kind==='missing'){query.set('page',String(options.page??state.page));query.set('pageSize','15');}
 if(kind==='missing')query.set('kind',state.missingKind);
 if(options.snapshotId)query.set('snapshotId',options.snapshotId);
 return 'delivery-calendar/'+kind+'?'+query;
}
export function deliveryMonthCells(month:string):Array<string|null>{
 if(!isCalendarDate(month+'-01'))throw Error('交付月份无效');
 const first=new Date(month+'-01T00:00:00Z'),year=first.getUTCFullYear(),index=first.getUTCMonth(),offset=(first.getUTCDay()+6)%7,count=new Date(Date.UTC(year,index+1,0)).getUTCDate();
 return Array.from({length:Math.ceil((offset+count)/7)*7},(_,i)=>i<offset||i>=offset+count?null:month+'-'+String(i-offset+1).padStart(2,'0'));
}
export function shiftDeliveryMonth(date:string,offset:number):string{
 if(!isCalendarDate(date)||!Number.isSafeInteger(offset))throw Error('交付月份无效');
 const serial=Number(date.slice(0,4))*12+Number(date.slice(5,7))-1+offset,year=Math.floor(serial/12),month=serial%12+1;
 if(year<2000||year>2199)throw Error('请选择2000至2199年的日期');
 return String(year)+'-'+String(month).padStart(2,'0')+'-01';
}
export const deliveryQuantity=(value:number|null)=>value===null?'待核':value.toLocaleString('zh-CN');
export const deliveryRiskLabels={delivered:'已交',overdue:'逾期',due_soon:'临期',pending:'待交',unknown:'待核'} as const;
export function deliveryPercentages(summary:DeliverySummary):{packed:number;pending:number}|null{
 if(summary.orderedQty===null||summary.packedQty===null||summary.pendingQty===null)return null;
 if(summary.orderedQty===0)return {packed:0,pending:0};
 const packed=Math.max(0,Math.min(100,Math.round(summary.packedQty/summary.orderedQty*100)));
 return {packed,pending:100-packed};
}
/** Visual quantity bands derive from this response, never a contractual SLA. */
export function deliveryDensityScale(days:readonly DeliveryDay[]){
 const values=days.flatMap(day=>day.summary.orderedQty!==null&&day.summary.orderedQty>0?[day.summary.orderedQty]:[]).sort((a,b)=>a-b);
 return {small:values[Math.floor(Math.max(values.length-1,0)/3)]??0,medium:values[Math.floor(2*Math.max(values.length-1,0)/3)]??0,maximum:values.at(-1)??0};
}
