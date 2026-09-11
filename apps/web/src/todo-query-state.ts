import type { TodoModule } from "@dx-rework/contracts";

export type TodoQueryState = { q: string; module?: TodoModule; page: number };
const modules:readonly string[]=["rework","sourcing","production","samples"];
export function readTodoQuery(search:string):TodoQueryState {
 const query=new URLSearchParams(search),module=query.get("module"),page=Number(query.get("page")??1);
 return {q:(query.get("q")??"").slice(0,100),page:Number.isSafeInteger(page)&&page>0&&page<=100_000?page:1,
  ...(module&&modules.includes(module)?{module:module as TodoModule}:{})};
}
export function todoQueryPath(value:TodoQueryState):string {
 const query=new URLSearchParams();if(value.q.trim())query.set("q",value.q.trim());
 if(value.module)query.set("module",value.module);if(value.page>1)query.set("page",String(value.page));
 return `/ui/my-tasks${query.size?`?${query}`:""}`;
}
export function todoReturnPath(search:string):string | null {
 const target=new URLSearchParams(search).get("returnTo");
 if(!target || target.includes("\\") || target.split("?")[0]!=="/ui/my-tasks")return null;
 return todoQueryPath(readTodoQuery(target.slice(target.indexOf("?")+1)));
}
export function withTodoReturn(target:string,source:TodoQueryState):string {
 const separator=target.includes("?")?"&":"?";
 return `${target}${separator}returnTo=${encodeURIComponent(todoQueryPath(source))}`;
}
