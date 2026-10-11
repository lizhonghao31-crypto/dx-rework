import { PatternOrderQuerySchema } from "@dx-rework/contracts/pattern-orders";
import { wageReturnPath } from "./wages/wage-query-state.js";
import { todoReturnPath } from "./todo-query-state.js";

export type PatternListQuery = { q: string; kind: string; status: string; creatorId: string; workerId: string; page: number };
export function patternPagePath(path: string, search: string): string {
  const params = new URLSearchParams(search);
  return path === "/ui/pattern-room/create" && ["q", "status", "page", "creatorId", "workerId"].some(key => params.has(key)) ? "/ui/pattern-room/orders" : path;
}
export function readPatternListQuery(search: string): PatternListQuery {
  const params = new URLSearchParams(search), input: Record<string, string> = {};
  for (const key of ["q", "kind", "status", "creatorId", "workerId", "page"]) if (params.get(key)) input[key] = params.get(key)!;
  const parsed = PatternOrderQuerySchema.safeParse(input), query = parsed.success ? parsed.data : PatternOrderQuerySchema.parse({});
  return { q: query.q ?? "", kind: query.kind ?? "", status: query.status ?? "", creatorId: query.creatorId ?? "", workerId: query.workerId ?? "", page: query.page };
}
export function patternListPath(query: PatternListQuery): string {
  const params = new URLSearchParams();
  for (const key of ["q", "kind", "status", "creatorId", "workerId"] as const) if (query[key]) params.set(key, query[key]);
  if (query.page > 1) params.set("page", String(query.page));
  return `/ui/pattern-room/orders${params.size ? `?${params}` : ""}`;
}
export function patternReturnPath(search: string): string {
  const target = new URLSearchParams(search).get("returnTo");
  return validPatternReturnPath(target) ?? "/ui/pattern-room/orders";
}
export function validPatternReturnPath(target: string | null): string | null {
  if (!target || target.includes("\\") || target.includes("#")) return null;
  const todo = todoReturnPath(`?${new URLSearchParams({ returnTo: target })}`); if (todo) return todo;
  const wage=wageReturnPath(target);if(wage)return wage;
  if(target.startsWith("/ui/digital-pattern-room?")) {
    const params=new URLSearchParams(target.split("?")[1]);
    if(params.get("section")!=="legacy"||[...params.keys()].some(key=>!["section","q","kind","status","creatorId","workerId","page"].includes(key))||params.size!==new Set(params.keys()).size)return null;
    return `/ui/digital-pattern-room?section=legacy&${patternListPath(readPatternListQuery(params.toString())).split("?")[1]??""}`;
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
