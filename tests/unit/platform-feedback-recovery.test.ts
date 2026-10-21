import {afterEach,describe,it,expect,vi} from 'vitest';
import {downloadReportExport} from '../../apps/web/src/reporting/reporting-client.js';
import {instructionRequest} from '../../apps/web/src/production-instruction-panel.js';
import {closureRequest} from '../../apps/web/src/order-closure-panel.js';
import {initialInstruction} from '@dx-rework/contracts/production-instruction';
import {buildWorkbook} from '../../apps/api/src/reporting/xlsx-workbook.js';
const id='00000000-0000-4000-8000-000000000001';
afterEach(()=>vi.unstubAllGlobals());
describe('actual synchronous export feedback',()=>{
 it('uses the original filtered GET and actual XLSX without claiming browser persistence',async()=>{
  const bytes=buildWorkbook([{name:'TEST',rows:[['TEST',0]]}]);const fetch=vi.fn().mockResolvedValue(new Response(new Uint8Array(bytes),{headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent('TEST 导出.xlsx')}`}}));vi.stubGlobal('fetch',fetch);
  const file=await downloadReportExport('rework_overview',{from:'2026-10-01',to:'2026-10-20',q:'TEST',limit:'100'});expect(file.filename).toBe('TEST 导出.xlsx');expect(new Uint8Array(await file.blob.arrayBuffer())).toEqual(new Uint8Array(bytes));expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]![0]).toBe('/api/management/reports/rework_overview/export.xlsx?from=2026-10-01&to=2026-10-20&q=TEST&limit=100');expect(fetch.mock.calls[0]![1]).toMatchObject({credentials:'include'});expect(fetch.mock.calls[0]![1].method).toBeUndefined();
 });
 it.each(['wrong-type','wrong-file','refused','network'])('does not treat %s as a received export or create a task',async mode=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  if(mode==='network')fetch.mockRejectedValue(new TypeError('TEST unreachable'));
  else if(mode==='refused')fetch.mockResolvedValue(Response.json({error:{code:'FORBIDDEN',message:'TEST当前身份无报表导出权限'}},{status:403}));
  else fetch.mockResolvedValue(new Response('TEST invalid',{headers:{'content-type':mode==='wrong-type'?'text/html':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}}));
  await expect(downloadReportExport('rework_overview',{})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('keeps a cancelled GET distinct from an uncertain write',async()=>{const controller=new AbortController();controller.abort();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(downloadReportExport('rework_overview',{},controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(fetch).not.toHaveBeenCalled();});
});
describe('actual instruction and closure receipt boundaries',()=>{
 const instruction={order:{productionOrderId:id,lines:[]},document:initialInstruction(),version:1,canEdit:true,cutStarted:false};
 const closure={orderId:id,revision:'a'.repeat(64),productionId:null,stage:'等待回货与装箱',lines:[],outstanding:[],canClose:true,canOpenReceiving:false,canOpenRework:false,canOpenWages:false,closed:null,shipmentStatus:'未知',customerReceiptStatus:'未知'};
 it('preserves a historical instruction extension and rejects an incomplete successful write',async()=>{
  const historical={...instruction,document:{...instruction.document,legacyNote:'TEST保留旧扩展'}};vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json(historical)).mockResolvedValueOnce(Response.json({})));
  expect(await instructionRequest(`orders/${id}/instruction?version=1`)).toEqual(historical);
  await expect(instructionRequest(`orders/${id}/instruction`,'PUT',{expectedVersion:0,document:instruction.document},'TEST-original')).rejects.toMatchObject({status:200,code:'INVALID_RESPONSE',resultUnknown:true});
 });
 it('distinguishes a valid open closure from a malformed or mismatched close acknowledgement',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json(closure)).mockResolvedValueOnce(Response.json({...closure,orderId:'00000000-0000-4000-8000-000000000002'})).mockResolvedValueOnce(Response.json(closure)));
  expect(await closureRequest(`orders/${id}/closure`)).toEqual(closure);
  await expect(closureRequest(`orders/${id}/closure`)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  await expect(closureRequest(`orders/${id}/closure`,'POST',{reason:'TEST结案原因',expectedRevision:closure.revision},'TEST-original')).rejects.toMatchObject({resultUnknown:true});
 });
});
