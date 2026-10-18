import { wageReturnPath } from "./wages/wage-query-state.js";
export function reworkReturnPath(search: string, source: unknown, fromTodos = false): string {
  for (const candidate of [new URLSearchParams(search).get('returnTo'), source]) {
    if (typeof candidate === 'string' && candidate.startsWith('/ui/') && !candidate.includes('\\') && !/^\/ui\/(tasks|my-tasks|responsibility)\//.test(candidate)) return candidate;
  }
  return fromTodos ? '/ui/my-tasks' : '/ui/tasks';
}

/** A history page keeps the original filtered list even when the last node is already complete. */
export function reworkHistorySource(search: string, source: unknown = null): {path:string;label:string} {
  const query=new URLSearchParams(search);
  const path=reworkReturnPath(query.getAll("returnTo").length>1?"":search,source);
  if(path.startsWith("/ui/wages")) {
    const wage=wageReturnPath(path);
    return wage?{path:wage,label:"返回工资管理"}:{path:"/ui/tasks",label:"返回订单列表"};
  }
  const pathname=path.split("?")[0];
  return {path,label:pathname==="/ui/my-tasks"?"返回我的待办":pathname==="/ui/tasks"?"返回订单列表":"返回来源列表"};
}
