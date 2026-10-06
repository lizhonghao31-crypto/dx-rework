export function shanghaiBusinessDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) throw new Error("Unable to resolve Shanghai business date");
  return `${year}-${month}-${day}`;
}

/** Show the original instant consistently, independent of the browser's timezone. */
export function shanghaiBusinessTime(value:string):string {
  return `${new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）`;
}
