import {afterEach,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {requestFailureMessage} from '../../apps/web/src/request-failure-message.js';
import {configureChineseValidation,requestValidationMessage} from '../../packages/contracts/src/validation-language.js';
const config={...z.config()};
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();z.config(config);});
it.each([[401,'登录'],[403,'无权'],[404,'不可见'],[409,'状态'],[422,'资料格式'],[503,'服务暂时']])('keeps HTTP %s distinct from form validation', (status,expected)=>{expect(requestFailureMessage(Number(status))).toContain(expected);expect(requestFailureMessage(Number(status),'原业务原因')).toBe('原业务原因');});
it('localizes digital fields and row paths without including submitted private values',()=>{
 configureChineseValidation();const parsed=z.object({lineItems:z.array(z.object({customerWarehouseArrivalDate:z.iso.date(),factoryDeliveryDate:z.iso.date()})),taskName:z.string().min(1)}).safeParse({lineItems:[{customerWarehouseArrivalDate:'PRIVATE',factoryDeliveryDate:'PRIVATE'}],taskName:''});
 const message=requestValidationMessage(parsed);expect(message).toContain('订单明细 / 第1行 / 出货日期');expect(message).toContain('加工厂交货日');expect(message).toContain('杂事名称');expect(message).not.toMatch(/PRIVATE|Invalid input/);
});
it.each(['digital','pattern'])('distinguishes network uncertainty and preserves cancellation in %s client',async(kind)=>{
 const fetcher=vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));vi.stubGlobal('fetch',fetcher);
 const {digitalRequest}=await import('../../apps/web/src/digital-production-api.js');const {patternRequest}=await import('../../apps/web/src/pattern-order-client.js');
 const request=(method:string)=>kind==='digital'?digitalRequest('test',method,{note:'保留'}):patternRequest('test',z.object({}),{method,body:'{"note":"保留"}'});
 await expect(request('GET')).rejects.toThrow('未能读取资料');await expect(request('POST')).rejects.toThrow('先核对原记录');
 const abort=new DOMException('aborted','AbortError');fetcher.mockRejectedValue(abort);await expect(request('GET')).rejects.toBe(abort);
});
it('handles an HTML gateway response without exposing a JSON parser error',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:503,json:async()=>{throw new SyntaxError('Unexpected token');}}));const {patternRequest}=await import('../../apps/web/src/pattern-order-client.js');await expect(patternRequest('orders',z.object({}))).rejects.toThrow('服务暂时不可用');
});

it('does not treat a malformed successful write response as a definite rejection',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,status:200,json:async()=>{throw new SyntaxError('Unexpected token');}}));const {digitalRequest}=await import('../../apps/web/src/digital-production-api.js');await expect(digitalRequest('test','POST',{})).rejects.toThrow('先核对原记录');await expect(digitalRequest('test')).rejects.toThrow('返回资料格式异常');
});

it.each(['GET','POST','DELETE'])('classifies a malformed successful pattern %s response without implying rejection',async method=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,status:200,json:async()=>({unexpected:true})}));const {patternRequest}=await import('../../apps/web/src/pattern-order-client.js');const request=patternRequest('orders',z.object({orderId:z.string()}),{method});await expect(request).rejects.toThrow(method==='GET'?'返回资料格式异常':'先核对原记录');
});
