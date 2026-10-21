import {SubmissionCancelled,submissionFailure} from "../../apps/web/src/submission-validation.js";
import {afterEach,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {feedbackFetch,feedbackJson,feedbackNoContent,RequestFeedbackError} from '../../apps/web/src/request-response-feedback.js';
import {patternRequest,PatternRequestError} from '../../apps/web/src/pattern-order-client.js';
import {cuttingRequest,CuttingRequestError} from '../../apps/web/src/cutting-client.js';
import {digitalRequest,DigitalRequestError} from '../../apps/web/src/digital-production-api.js';
import {sampleRequest,SampleRequestError,sampleErrorMessage} from '../../apps/web/src/sample-request.js';
import {reworkFormRequest} from '../../apps/web/src/rework-v2-form.js';
import {workReportingRequest,workReportingNoContent} from '../../apps/web/src/work-reporting-form.js';
import {receivingRequestJson,receivingReceiptRequest} from '../../apps/web/src/receiving-page.js';
import {productionReportingRequest,saveProductionScope} from '../../apps/web/src/production-reporting-page.js';
import {sourcingWorkspaceRequest} from '../../apps/web/src/sourcing-workspace-page.js';
import {masterDataRequest} from '../../apps/web/src/master-data-page.js';
import {readWagePeriodDetail} from '../../apps/web/src/wages/wage-period-detail.js';
const schema=z.object({ok:z.literal(true)}),init={method:'POST',body:'{"TEST":"original"}',headers:{'idempotency-key':'TEST-original-key'}},generic=(value:unknown)=>schema.parse(value);
afterEach(()=>vi.unstubAllGlobals());
const clients=[
 ['digital',(method:string)=>digitalRequest('sources/TEST',method,method==='GET'?undefined:{TEST:'original'},'TEST-original-key')],
 ['pattern',(method:string)=>patternRequest('orders/TEST',schema,{...init,method,...(method==='GET'?{body:undefined}:{})})],
 ['cutting',(method:string)=>cuttingRequest('orders/TEST',schema,{...init,method,...(method==='GET'?{body:undefined}:{})})],
 ['samples',(method:string)=>sampleRequest('/api/samples/TEST',schema,{...init,method,...(method==='GET'?{body:undefined}:{})})],
 ['rework',(method:string)=>reworkFormRequest('rework-orders/TEST',schema,{...init,method,...(method==='GET'?{body:undefined}:{})})],
 ['work-report',(method:string)=>workReportingRequest('rework-orders/TEST/work-reports',generic,{...init,method,...(method==='GET'?{body:undefined}:{})})],
 ['receiving',(method:string)=>receivingRequestJson('receiving/TEST',{...init,method,...(method==='GET'?{body:undefined}:{})})],
 ['production-reporting',(method:string)=>productionReportingRequest('/TEST',schema,{...init,method,...(method==='GET'?{body:undefined}:{})})],
 ['sourcing',(method:string)=>sourcingWorkspaceRequest('sourcing/TEST',schema,{...init,method,...(method==='GET'?{body:undefined}:{})})],
 ['master-data',(method:string)=>masterDataRequest('master-data/TEST',{...init,method,...(method==='GET'?{body:undefined}:{})})],
] as const;
it.each(clients)('%s actual client preserves request shape and never repeats a failed request',async(_name,request)=>{
 const fetch=vi.fn().mockResolvedValue(Response.json({ok:true}));vi.stubGlobal('fetch',fetch);expect(await request('POST')).toEqual({ok:true});expect(fetch).toHaveBeenCalledTimes(1);const sent=fetch.mock.calls[0]![1];expect(sent.method).toBe('POST');expect(new Headers(sent.headers).get('idempotency-key')).toBe('TEST-original-key');expect(JSON.parse(sent.body)).toEqual({TEST:'original'});
 fetch.mockReset().mockResolvedValue(new Response('<html>unavailable</html>',{status:503}));await expect(request('GET')).rejects.toThrow(/未能读取|未完成读取|读取/);expect(fetch).toHaveBeenCalledTimes(1);
 fetch.mockReset().mockResolvedValue(new Response('unavailable',{status:503}));await expect(request('POST')).rejects.toThrow('未收到可确认的提交结果');expect(fetch).toHaveBeenCalledTimes(1);
 fetch.mockReset().mockResolvedValue(new Response('{'));await expect(request('POST')).rejects.toThrow('未收到可确认的提交结果');expect(fetch).toHaveBeenCalledTimes(1);
 fetch.mockReset().mockResolvedValue(Response.json({error:{code:'TEST_BUSINESS_REJECTION',message:'TEST缺实物，请由仓库从原收货入口登记'}},{status:409}));await expect(request('POST')).rejects.toThrow('TEST缺实物，请由仓库从原收货入口登记');expect(fetch).toHaveBeenCalledTimes(1);
 fetch.mockReset().mockRejectedValue(new TypeError('TEST网络断开'));await expect(request('POST')).rejects.toThrow('未收到可确认的提交结果');expect(fetch).toHaveBeenCalledTimes(1);
 fetch.mockReset().mockResolvedValue(new Response('Forbidden',{status:403}));await expect(request('POST')).rejects.toThrow('当前身份无权');expect(fetch).toHaveBeenCalledTimes(1);
 fetch.mockReset().mockRejectedValue(new DOMException('TEST sent abort','AbortError'));await expect(request('POST')).rejects.toThrow('未收到可确认的提交结果');expect(fetch).toHaveBeenCalledTimes(1);
});
it('keeps custom error classes/code/status for explicit rejections and invalid success receipts',async()=>{
 for(const [request,type] of [[()=>patternRequest('orders/TEST',schema,init),PatternRequestError],[()=>cuttingRequest('orders/TEST',schema,init),CuttingRequestError],[()=>sampleRequest('/TEST',schema,init),SampleRequestError]] as const){vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:'TEST_ORIGINAL',message:'TEST真实拒绝'}},{status:403})));await expect(request()).rejects.toMatchObject({code:'TEST_ORIGINAL',status:403});const error=await request().catch(e=>e);expect(error).toBeInstanceOf(type);vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({wrong:true})));await expect(request()).rejects.toMatchObject({code:'INVALID_RESPONSE',status:200});}
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('down',{status:502})));await expect(digitalRequest('TEST','POST',{})).rejects.toBeInstanceOf(DigitalRequestError);
});
it('treats GET cancellation, proven unsent cancellation and sent POST cancellation separately',async()=>{
 const before=new AbortController();before.abort();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const cancelled=await feedbackFetch('/TEST',{method:'POST',signal:before.signal}).catch(error=>error);expect(cancelled).toBeInstanceOf(SubmissionCancelled);expect(submissionFailure(cancelled)).toMatchObject({cancelled:true,uncertain:false});expect(fetch).not.toHaveBeenCalled();
 fetch.mockRejectedValue(new DOMException('TEST sent abort','AbortError'));await expect(feedbackFetch('/TEST',{method:'GET'})).rejects.toMatchObject({name:'AbortError'});await expect(feedbackFetch('/TEST',init)).rejects.toMatchObject({outcome:'unknown',status:null});expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[1]![1]).toMatchObject(init);
 const response={ok:true,status:200,json:async()=>{throw new DOMException('body aborted','AbortError');}} as Response;await expect(feedbackJson(response,'GET',generic)).rejects.toMatchObject({name:'AbortError'});await expect(feedbackJson(response,'POST',generic)).rejects.toMatchObject({outcome:'unknown'});
});
it('does not infer version changes from an unexplained conflict and preserves Chinese sample server reasons even for 5xx',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('conflict',{status:409})));const rejection=await sampleRequest('/TEST',schema,init).catch(e=>e);expect(sampleErrorMessage(rejection)).toContain('具体原因尚未返回');expect(sampleErrorMessage(rejection)).not.toContain('状态已变化');
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:'TEST_FAILURE',message:'TEST服务暂不能核对原借还记录'}},{status:500})));const failure=await sampleRequest('/TEST',schema,init).catch(e=>e);expect(sampleErrorMessage(failure)).toContain('TEST服务暂不能核对原借还记录');expect(sampleErrorMessage(failure)).toContain('未收到可确认的提交结果');
});
it('covers the separate production-scope POST JSON receipt and original bodyless work-report command without parsing an invented JSON receipt',async()=>{
 const fetch=vi.fn().mockResolvedValue(Response.json({saved:true}));vi.stubGlobal('fetch',fetch);const input={userId:'TEST-user',scopeType:'supplier' as const,scopeId:'TEST-supplier',active:true};await saveProductionScope(input,'TEST-scope-key');expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(input);expect(new Headers(fetch.mock.calls[0]![1].headers).get('idempotency-key')).toBe('TEST-scope-key');fetch.mockResolvedValue(new Response(null,{status:204}));await workReportingNoContent('rework-orders/TEST/report',init);expect(fetch).toHaveBeenCalledTimes(2);
 fetch.mockReset().mockResolvedValue(new Response('forbidden',{status:403}));await expect(saveProductionScope(input,'TEST-scope-key')).rejects.toThrow('当前身份无权');await expect(workReportingNoContent('rework-orders/TEST/report',init)).rejects.toThrow('当前身份无权');expect(fetch).toHaveBeenCalledTimes(2);
});
it('keeps wage details as a pure authorized GET and gives an actual read failure for malformed receipts',async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response('not-json',{status:502}));vi.stubGlobal('fetch',fetch);await expect(readWagePeriodDetail('TEST-period')).rejects.toThrow('未能读取原资料');expect(fetch.mock.calls[0]![1].method??'GET').toBe('GET');fetch.mockReset().mockResolvedValue(Response.json({}));await expect(readWagePeriodDetail('TEST-period')).rejects.toThrow('返回资料不完整');expect(fetch).toHaveBeenCalledTimes(1);
});
it('retains trusted no-content success separately from a failed later GET',async()=>{await expect(feedbackNoContent(new Response(null,{status:204}),'POST')).resolves.toBeUndefined();await expect(feedbackJson(new Response('down',{status:500}),'GET',generic)).rejects.toMatchObject({outcome:'read_failed'});expect(new RequestFeedbackError('TEST','unknown',null).outcome).toBe('unknown');});

it('validates actual receipt and directory write acknowledgements before clearing inputs or claiming saved',async()=>{
 const fetch=vi.fn().mockResolvedValue(Response.json({}));vi.stubGlobal('fetch',fetch);await expect(receivingReceiptRequest({TEST:'original'},'TEST-receipt-key')).rejects.toThrow('未收到可确认的提交结果');expect(new Headers(fetch.mock.calls[0]![1].headers).get('idempotency-key')).toBe('TEST-receipt-key');
 for(const path of ['master-data/crafts/ensure','master-data/crafts/TEST/versions','master-data/suppliers','master-data/processes'])await expect(masterDataRequest(path,init)).rejects.toThrow('未收到可确认的提交结果');
 await expect(saveProductionScope({userId:'TEST-user',scopeType:'order',scopeId:'TEST-order',active:true},'TEST-scope-key')).rejects.toThrow('未收到可确认的提交结果');await expect(feedbackNoContent(Response.json({}),'POST')).rejects.toThrow('未收到可确认的提交结果');
 const receipt={receiptId:'TEST-receipt',receivingBatchId:'TEST-batch',styleNo:'TEST-style',documentQuantity:10,actualQuantity:9,defectiveQuantity:1,differenceQuantity:-1,receivedAt:'2026-10-20T00:00:00Z'};fetch.mockResolvedValue(Response.json(receipt));await expect(receivingReceiptRequest({TEST:'original'},'TEST-receipt-key')).resolves.toEqual(receipt);
 fetch.mockResolvedValue(Response.json([{craftId:'TEST-craft',version:1}]));await expect(masterDataRequest('master-data/crafts/ensure',init)).resolves.toEqual([{craftId:'TEST-craft',version:1}]);
});

it('shows safe human feedback while retaining image-normalization recovery and original error codes',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:'ATTACHMENT_METADATA_MISMATCH',message:'Uploaded object is not a valid file of the declared type'}},{status:400})));await expect(sampleRequest('/TEST',schema,init)).rejects.toMatchObject({code:'ATTACHMENT_METADATA_MISMATCH',message:'附件内容与申报文件类型不一致，请重新选择有效原文件'});
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:'TEST_DB',message:'duplicate key value violates unique constraint 中文资料'}},{status:500})));const error=await cuttingRequest('TEST',schema).catch(e=>e);expect(error.code).toBe('TEST_DB');expect(error.message).not.toContain('constraint');expect(error.message).not.toContain('中文资料');expect(error.message).toContain('未能读取原资料');
});
