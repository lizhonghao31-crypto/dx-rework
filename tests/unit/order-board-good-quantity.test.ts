// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {OrderBoardPage} from '../../apps/web/src/order-board-page.js';
vi.mock('../../apps/web/src/auth.js',()=>({verifySession:async()=>({status:'authorized',user:{businessRoles:[],capabilities:[],isRoot:false}})}));
let root:ReturnType<typeof createRoot>|undefined,host:HTMLDivElement|undefined;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());host?.remove();vi.unstubAllGlobals();});
it.each([67,0,null])('renders server-projected good pieces %s while keeping inclusive KPI, differences and history',async good=>{
 const at='2026-11-15T02:00:00Z',row={receivingBatchId:'TEST-batch',styleNo:'TEST-GOOD-QUANTITY',documentQuantity:100,attachments:[],priorActualQuantity:40,actualQuantity:30,defectiveQuantity:1,currentActualQuantity:70,currentDefectiveQuantity:3,cumulativeActualQuantity:70,...(good===null?{}:{cumulativeGoodQuantity:good}),differenceQuantity:-30,packingRevisionId:null,packingQuantity:null,packingDifferenceQuantity:null,packingRecordedBy:null,packingRecordedAt:null,actualCutCount:null,cuttingRecordedBy:null,cuttingRecordedAt:null,receivingDifferenceResolution:null,packingDifferenceResolution:null,receiptCount:2,receivingHistory:[{receiptId:'TEST-receipt',receivingBatchId:'TEST-batch',batchVersion:1,sequence:2,documentQuantity:100,receiptDocumentQuantity:100,receivingSource:'jiashun',actualQuantity:30,defectiveQuantity:1,cumulativeActualQuantity:70,differenceQuantity:-30,receivedAt:at,receiverName:'TEST 仓管'}],lastReceivedAt:at,lastReceiverName:'TEST 仓管',reworkOrderId:null,reworkStatus:null,version:1,rootCorrectable:false,rootDeletable:false,rootMutable:false};
 const data={date:'2026-11-15',startDate:'2026-11-15',endDate:'2026-11-15',mode:'range',status:'all',kpis:{orderCount:1,receivedQuantity:30,abnormalOrderCount:1,differenceQuantity:30,differenceRate:30},rows:[row],page:1,pageSize:15,totalCount:1,totalPages:1};
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>data})));
 host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(createElement(OrderBoardPage)));
 const card=host.querySelector('.order-board-row__actual')!;expect(card.textContent).toBe(`实收正品数量${good===null?'—':good+'件'}`);
 expect(host.querySelector('.order-board-kpis')!.textContent).toContain('期间实收数量含次品数30件');
 expect(host.querySelector('.order-board-row__difference')!.textContent).toContain('30');
 const expand=host.querySelector<HTMLButtonElement>('.order-board-history-toggle')!;await act(async()=>expand.click());
 const history=host.querySelector('.order-board-history')!.textContent;expect(history).toContain('本次实收含次品数 30件');expect(history).toContain('累计实收含次品数 70件');
});
