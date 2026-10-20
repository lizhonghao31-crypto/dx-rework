import {digitalDetailReturnUrl} from './digital-detail-route.js';
import {createWebUrls} from '../url-contract.js';
import { PatternOrderQuerySchema } from "@dx-rework/contracts/pattern-orders";
import { wageReturnPath } from "./wages/wage-query-state.js";
import { todoReturnPath } from "./todo-query-state.js";

export type PatternListQuery = { q: string; kind: string; status: string; creatorId: string; workerId: string; page: number; origin?: "standalone" };
export function patternPagePath(path: string, search: string): string {
  const params = new URLSearchParams(search);
  return path === "/ui/pattern-room/create" && ["q", "status", "page", "creatorId", "workerId"].some(key => params.has(key)) ? "/ui/pattern-room/orders" : path;
}
export function readPatternListQuery(search: string): PatternListQuery {
  const params = new URLSearchParams(search), input: Record<string, string> = {};
  for (const key of ["q", "kind", "status", "creatorId", "workerId", "page", "origin"]) if (params.get(key)) input[key] = params.get(key)!;
  const parsed = PatternOrderQuerySchema.safeParse(input), query = parsed.success ? parsed.data : PatternOrderQuerySchema.parse({});
  return { q: query.q ?? "", kind: query.kind ?? "", status: query.status ?? "", creatorId: query.creatorId ?? "", workerId: query.workerId ?? "", page: query.page, ...(query.origin ? {origin:query.origin} : {}) };
}
export function patternListPath(query: PatternListQuery): string {
  const params = new URLSearchParams();
  for (const key of ["q", "kind", "status", "creatorId", "workerId", "origin"] as const) if (query[key]) params.set(key, query[key]);
  if (query.page > 1) params.set("page", String(query.page));
  return `/ui/pattern-room/orders${params.size ? `?${params}` : ""}`;
}
export function patternReturnPath(search: string): string {
  const query=new URLSearchParams(search),target=query.getAll("returnTo").length===1?query.get("returnTo"):null;
  return validPatternReturnPath(target) ?? "/ui/pattern-room/orders";
}
export function validPatternReturnPath(target: string | null,base=import.meta.env.BASE_URL): string | null {
  if (!target || target.includes("\\") || target.includes("#")) return null;
  const digital=digitalDetailReturnUrl(target,base);
  if(digital){
    const urls=createWebUrls(base),prefix=urls.base==='/'?'':urls.base.slice(0,-1);
    const relative=(value:string,depth=0):string|null=>{
      if(depth>3)return null;const url=new URL(value,'https://local.invalid');
      if(url.origin!=='https://local.invalid')return null;
      const path=prefix&&url.pathname.startsWith(prefix+'/')?url.pathname.slice(prefix.length):url.pathname;
      if(url.searchParams.has('returnTo')){const nested=relative(url.searchParams.get('returnTo')!,depth+1);if(!nested)return null;url.searchParams.set('returnTo',nested);}
      return path+url.search;
    };
    return relative(digital);
  }
  const todo = todoReturnPath(`?${new URLSearchParams({ returnTo: target })}`); if (todo) return todo;
  const wage=wageReturnPath(target);if(wage)return wage;
  if(target.startsWith("/ui/digital-pattern-room?")) {
    const params=new URLSearchParams(target.split("?")[1]);
    const standalone=params.get("section")==="development"&&params.get("source")==="standalone";
    if((params.get("section")!=="legacy"&&!standalone)||[...params.keys()].some(key=>!["section","source","q","kind","origin","status","creatorId","workerId","page"].includes(key))||params.size!==new Set(params.keys()).size)return null;
    return `/ui/digital-pattern-room?${standalone?"section=development&source=standalone":"section=legacy"}&${patternListPath(readPatternListQuery(params.toString())).split("?")[1]??""}`;
  }
  if (["/ui/pattern-room", "/ui/pattern-room/prices"].includes(target)) return target;
  if (!["/ui/pattern-room/orders", "/ui/pattern-room/create"].includes(target.split("?")[0]!)) return null;
  return patternListPath(readPatternListQuery(target.includes("?") ? target.slice(target.indexOf("?")) : ""));
}
export function patternEstimate(price: string | null, quantity: string): string | null {
  if (!price || !/^\d+\.\d{3}$/.test(price) || !/^[1-9]\d{0,6}$/.test(quantity) || BigInt(quantity) > 1_000_000n) return null;
  const total = BigInt(price.replace(".", "")) * BigInt(quantity);
  return `${total / 1000n}.${(total % 1000n).toString().padStart(3, "0")}`;
}
