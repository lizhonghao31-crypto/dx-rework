// @vitest-environment jsdom
import {act,createElement,type ReactNode} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {ForegroundLoading,beginForegroundWait} from "../../apps/web/src/foreground-loading.js";
import {useRemoteQueue} from "../../apps/web/src/use-remote-queue.js";

let host:HTMLDivElement,root:Root;
const advance=async(ms:number)=>{await act(async()=>vi.advanceTimersByTime(ms));};
const mounts=(view?:ReactNode)=>act(async()=>root.render(createElement("main",null,view,createElement(ForegroundLoading))));
beforeEach(()=>{
 vi.useFakeTimers();
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 host=document.createElement("div");document.body.append(host);
 root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});

it("skips fast foreground reads and lets only the most recent read clear its visible status",async()=>{
 await mounts();
 const quick=beginForegroundWait();await advance(249);expect(host.querySelector('[role="status"]')).toBeNull();
 quick();await advance(300);expect(host.textContent).not.toContain("读取中，请稍候");
 const old=beginForegroundWait();await advance(250);expect(host.querySelector('[role="status"]')?.textContent).toBe("读取中，请稍候");
 expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);expect(host.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
 let latest!:()=>void;
 await act(async()=>{latest=beginForegroundWait();});
 await advance(250);await act(async()=>old());
 expect(host.querySelector('[role="status"]')?.textContent).toBe("读取中，请稍候");
 await act(async()=>latest());expect(host.querySelector('[role="status"]')).toBeNull();
});

it("keeps the prior queue while changing page, ignores repeated and stale requests, and shows errors until explicit retry",async()=>{
 type Queue={items:string[];page:number;pageSize:number;totalCount:number};
 const schema={parse:(value:unknown)=>value as Queue};
 let read!:ReturnType<typeof useRemoteQueue<Queue>>;
 type Call={page:number;signal:AbortSignal;resolve:(response:Response)=>void};
 const requests:Call[]=[];
 vi.stubGlobal("fetch",vi.fn((url:string,init:RequestInit)=>new Promise<Response>(resolve=>{
  requests.push({page:Number(new URL(url,"http://TEST.invalid").searchParams.get("page")),signal:init.signal as AbortSignal,resolve});
 })));
 const answer=(call:Call)=>Response.json({items:["page "+call.page],page:call.page,pageSize:15,totalCount:50});
 const settle=async(call:Call,response=answer(call))=>{await act(async()=>call.resolve(response));};
 function QueueView(){
  read=useRemoteQueue("/api/test/queue",schema,"TEST read failed");
  return createElement("p",{},read.state.kind==="ready"?read.state.value.items[0]:read.state.kind==="unavailable"?read.state.message:"initial load");
 }
 await mounts(createElement(QueueView));
 await settle(requests[0]!);expect(host.textContent).toContain("page 1");
 await act(async()=>{read.page.setPage(2);read.page.setPage(2);});
 expect(requests.map(call=>call.page)).toEqual([1,2]);expect(host.textContent).toContain("page 1");
 await advance(250);expect(host.querySelector('[role="status"]')?.textContent).toBe("读取中，请稍候");
 await act(async()=>read.page.setPage(3));expect(requests[1]!.signal.aborted).toBe(true);
 await advance(250);await settle(requests[1]!);expect(host.textContent).toContain("page 1");expect(host.textContent).toContain("读取中，请稍候");
 await settle(requests[2]!,Response.json({}, {status:503}));
 expect(host.textContent).toContain("TEST read failed");expect(host.textContent).not.toContain("读取中，请稍候");
 await act(async()=>read.retry());expect(requests.map(call=>call.page)).toEqual([1,2,3,3]);
 await settle(requests[3]!);expect(host.textContent).toContain("page 3");
});
