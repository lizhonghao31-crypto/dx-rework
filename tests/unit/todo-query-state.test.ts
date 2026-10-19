import { describe,expect,it,vi } from "vitest";
import { readTodoQuery,todoQueryPath,todoReturnPath,withTodoReturn } from "../../apps/web/src/todo-query-state.js";
import { reworkReturnPath } from "../../apps/web/src/rework-return-path.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
const actor={actorId:"00000000-0000-4000-8000-000000000001",actorRoles:["owner_group"],authorizationCapability:"todo:view",authorizationCapabilities:["todo:view"],requestId:"todo-search-test"};
describe("todo query return and merchandiser search",()=>{
 it("round-trips Chinese search, module and page across all task links",()=>{
  const source={q:"黄建华 & 嘉顺",module:"sourcing" as const,page:6};
  for(const target of ["/ui/my-tasks/id","/ui/tasks/id?todo=one","/ui/sourcing/orders/id?todo=two","/ui/samples/id","/ui/production-dashboard/id"]){
   const href=withTodoReturn(target,source),search=href.slice(href.indexOf("?"));
   expect(todoReturnPath(search)).toBe(todoQueryPath(source));
   expect(reworkReturnPath(search,null,true)).toBe(todoQueryPath(source));
  }
  expect(readTodoQuery(todoQueryPath(source).split("?")[1]!)).toEqual(source);
 });
 it("rejects unrelated return paths and bounds untrusted query parameters",()=>{
  for(const target of ["https://example.com","//example.com","/ui/my-tasks/one","/ui/../admin","/ui/my-tasks\\other"])
   expect(todoReturnPath(`?returnTo=${encodeURIComponent(target)}`)).toBeNull();
  expect(todoReturnPath("?returnTo=%2Fui%2Fmy-tasks")).toBe("/ui/my-tasks");
  expect(readTodoQuery("?page=-1&module=admin&q=李生")).toEqual({q:"李生",page:1});
 });
 it("uses the real merchandiser join in a global query while preserving recipient scope",async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{total_count:0,total_pages:0,page:1,items:[]}]});
  const service=new TodoService({query} as never);
  expect(await service.listForActor(actor,{module:"rework",query:"黄建华",page:6})).toMatchObject({page:1,totalCount:0,todos:[]});
  for(const index of [1]){
   const [sql,args]=query.mock.calls[index]!;
   expect(sql).toContain("rework_merchandiser.id=orders.merchandiser_user_id");
   expect(sql).toContain("sourcing_merchandiser.id=sourcing.created_by");
   expect(sql).toContain("COALESCE(merchandiser_name,'')");
   expect(sql).toContain("recipient_user_id=$1");
   expect(args.slice(0,2)).toEqual([actor.actorId,"黄建华"]);
  }
 });
 it("finds production risks by the source-order merchandiser and clamps the page after completion",async()=>{
  const query=vi.fn().mockImplementation(async(sql:string,args:unknown[])=>{
   if(sql.includes("GROUP BY todo_module"))return {rows:[]};
   const records=JSON.parse(String(args[2])) as Record<string,unknown>[];
   return {rows:[{total_count:records.length,total_pages:records.length?1:0,page:1,items:records.map(value=>({kind:"provider",value}))}]};
  });
  const make=(index:number,merchandiserName:string)=>{const id=`00000000-0000-4000-8000-${String(index).padStart(12,"0")}`;return {todoId:id,todoType:"business_action",category:"production_behind",sourceEventId:id,sourceAction:"production",entityType:"production_order",entityId:id,recipientUserId:actor.actorId,requiredRole:null,requiredCapability:null,route:{routeName:"production_detail",entityId:id,todoId:id},policyKey:null,dueAt:null,reminderCount:0,status:"pending",blockedReason:null,orderContext:{reworkNo:null,orderNo:null,styleNo:"S1",supplierName:"嘉顺",merchandiserName,status:"active",updatedAt:"2026-10-01T00:00:00.000Z"},version:1,createdAt:"2026-10-01T00:00:00.000Z",updatedAt:"2026-10-01T00:00:00.000Z"};};
  const records=[make(10,"黄建华"),make(11,"张三")];
  const todos=vi.fn().mockResolvedValue(records);
  const service=new TodoService({query} as never,undefined,undefined,{todos} as never);
  expect(await service.listForActor(actor,{module:"production",query:"黄建华",page:5})).toMatchObject({page:1,totalCount:1,todos:[{todoId:records[0]!.todoId}]});
  todos.mockResolvedValue(records.slice(1));
  expect(await service.listForActor(actor,{module:"production",query:"黄建华",page:5})).toMatchObject({page:1,totalCount:0,todos:[]});
 });
});
