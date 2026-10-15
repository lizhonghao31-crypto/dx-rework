import {afterEach,expect,it,vi} from 'vitest';
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
const reply=(value:unknown)=>({ok:true,json:async()=>value});
function deferred(){let resolve!:(value:unknown)=>void;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
it('shares concurrent candidate reads, isolates callers and discards settled results',async()=>{
 const pending=deferred(),fetcher=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(reply({items:['fresh']}));vi.stubGlobal('fetch',fetcher);
 const {digitalRequest}=await import('../../apps/web/src/digital-production-api.js');
 const a=digitalRequest<{items:string[]}>('access/candidates?purpose=technical'),b=digitalRequest<{items:string[]}>('access/candidates?purpose=technical');
 expect(fetcher).toHaveBeenCalledTimes(1);pending.resolve(reply({items:['first']}));
 const [first,second]=await Promise.all([a,b]);first.items.push('local');expect(second.items).toEqual(['first']);
 expect(await digitalRequest('access/candidates?purpose=technical')).toEqual({items:['fresh']});expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not share different purposes or failed reads',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce({ok:false,status:403,json:async()=>({error:{message:'denied'}})}).mockResolvedValue(reply([]));vi.stubGlobal('fetch',fetcher);
 const {digitalRequest}=await import('../../apps/web/src/digital-production-api.js');
 await expect(digitalRequest('access/candidates?purpose=technical')).rejects.toThrow('denied');
 await Promise.all([digitalRequest('access/candidates?purpose=technical'),digitalRequest('access/candidates?purpose=financial')]);expect(fetcher).toHaveBeenCalledTimes(3);
});
it.each(['session','write'])('rejects stale reads after %s changes without aborting writes',async(change)=>{
 const pending=deferred(),fetcher=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(reply({saved:true}));vi.stubGlobal('fetch',fetcher);
 const {digitalRequest}=await import('../../apps/web/src/digital-production-api.js');
 const old=digitalRequest('access/candidates');const rejected=expect(old).rejects.toThrow('读取条件已变化');
 if(change==='session')(await import('../../apps/web/src/auth-session.js')).invalidateSession();
 else expect(await digitalRequest('tasks/change','POST',{value:1},'request-key',{signal:new AbortController().signal})).toEqual({saved:true});
 pending.resolve(reply([]));await rejected;
 if(change==='write')expect(fetcher.mock.calls[1]?.[1]).not.toHaveProperty('signal');
});
it('passes cancellation only to its own read and does not share cancellable requests',async()=>{
 const fetcher=vi.fn().mockResolvedValue(reply([]));vi.stubGlobal('fetch',fetcher);
 const {digitalRequest}=await import('../../apps/web/src/digital-production-api.js'),controller=new AbortController();
 await Promise.all([digitalRequest('access/candidates','GET',undefined,undefined,{signal:controller.signal}),digitalRequest('access/candidates')]);
 expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[0]?.[1]).toHaveProperty('signal',controller.signal);expect(fetcher.mock.calls[1]?.[1]).not.toHaveProperty('signal');
});
it.each(['access/candidates?purpose=technical','tasks/00000000-0000-4000-8000-000000000001'])('refreshes %s after a successful write instead of joining an overlapping stale read',async(path)=>{
 const writing=deferred(),reading=deferred();
 const fetcher=vi.fn().mockReturnValueOnce(writing.promise).mockReturnValueOnce(reading.promise).mockResolvedValue(reply({state:'committed'}));vi.stubGlobal('fetch',fetcher);
 const {digitalRequest}=await import('../../apps/web/src/digital-production-api.js');
 const write=digitalRequest('tasks/change','POST',{value:1},'request-key');
 const stale=digitalRequest(path),rejected=expect(stale).rejects.toThrow('读取条件已变化');
 writing.resolve(reply({saved:true}));await write;
 expect(await digitalRequest(path)).toEqual({state:'committed'});
 expect(fetcher).toHaveBeenCalledTimes(3);
 reading.resolve(reply({state:'before-commit'}));await rejected;
});
