/** Date-only arithmetic. Never interpret a customer promise through browser/server timezone. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year=Number(value.slice(0,4));
  if(year<1000||year>9999)return false;
  const instant=Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant)&&new Date(instant).toISOString().slice(0,10)===value;
}
export function addCalendarDays(value:string,days:number):string {
  if(!isCalendarDate(value)||!Number.isSafeInteger(days))throw new Error('请输入有效日期和自然日数');
  const result=new Date(Date.parse(`${value}T00:00:00Z`)+days*86400000).toISOString().slice(0,10);
  if(!isCalendarDate(result))throw new Error('日期超出支持年份');
  return result;
}
export function calendarDaysBetween(from:string,to:string):number {
  if(!isCalendarDate(from)||!isCalendarDate(to))throw new Error('请输入有效日期');
  return (Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000;
}
/** Shift calendar months first, then validate the chosen day. Invalid dates never overflow/clamp. */
export function seriesCalendarDate(year:number,month:number,monthOffset:number,day:number):string {
  if(!Number.isInteger(year)||year<1000||year>9999||!Number.isInteger(month)||month<1||month>12
    ||!Number.isInteger(monthOffset)||monthOffset< -12||monthOffset>0||!Number.isInteger(day)||day<1||day>31)throw new Error('系列年份、月份或计划参数无效');
  const index=year*12+month-1+monthOffset,y=Math.floor(index/12),m=index-y*12+1;
  const date=`${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  if(!isCalendarDate(date))throw new Error('该月份没有所选日号，请明确调整计划参数或手动选择日期');
  return date;
}
