import {afterEach,describe,expect,it,vi} from 'vitest';
import {DigitalRequestError,digitalRequest} from '../../apps/web/src/digital-production-api.js';
import {digitalReadFailureInfo} from '../../apps/web/src/digital-read-failure.js';
afterEach(()=>vi.unstubAllGlobals());
describe('safe read failures preserve original business reasons',()=>{
 it.each([[401,'登录已失效'],[403,'当前身份无权查看'],[404,'原记录不存在或当前不可见'],[409,'读取请求未被接受'],[503,'服务暂时不可用']] as const)('classifies %s without losing the server reason',async(status,title)=>{
  const fetch=vi.fn().mockResolvedValue(Response.json({error:{message:'TEST 原业务原因'}},{status}));vi.stubGlobal('fetch',fetch);const error=await digitalRequest('sources/TEST/execution').catch(error=>error);expect(error).toBeInstanceOf(DigitalRequestError);expect(digitalReadFailureInfo(error)).toMatchObject({title,detail:'TEST 原业务原因'});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('distinguishes a failed connection from an empty successful read',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new TypeError('synthetic network')));const error=await digitalRequest('sources/TEST/execution').catch(error=>error);expect(digitalReadFailureInfo(error).title).toBe('网络连接失败');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({items:[]})));expect(await digitalRequest('sources/TEST/execution')).toEqual({items:[]});
 });
 it('keeps aborted reads aborted and never repeats an unknown-result write',async()=>{
  const abort=new DOMException('aborted','AbortError');vi.stubGlobal('fetch',vi.fn().mockRejectedValue(abort));await expect(digitalRequest('sources/TEST/execution')).rejects.toBe(abort);
  const fetch=vi.fn().mockRejectedValue(new TypeError('synthetic network'));vi.stubGlobal('fetch',fetch);await expect(digitalRequest('sources/TEST/execution/route','POST',{taskId:'TEST'},'TEST-key')).rejects.toThrow('未收到可确认的提交结果，请先核对原记录，避免重复提交');expect(fetch).toHaveBeenCalledTimes(1);
 });
});
