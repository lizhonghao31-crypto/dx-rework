import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import type {JourneyNode,JourneyTiming,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {JourneyTimingWindows,JourneySlaDetails,nodeTargetLabel,slaTargetLabel} from '../../apps/web/src/journey-sla-details.js';
import {cockpitPerson} from '../../apps/web/src/cockpit-node-rows.js';
import {businessDateLabel,forecastBasisLabels} from '../../apps/web/src/cockpit-business-dates.js';
import {closureWorkQuantityLabel} from '../../apps/web/src/order-closure-panel.js';
import {closureFeedbackProjection} from '../../apps/web/src/document-feedback-projections.js';
import {nodeStatus} from '../../apps/web/src/digital-journey-cockpit-model.js';
import {cockpitOwnStatus} from '../../apps/web/src/cockpit-fixed-schedule.js';

it('P02-01: renders three original scope windows without sharing a copied deadline or losing stopped history',()=>{
 const timing:JourneyTiming={id:'bulk_qc',label:'回仓总查',stage:'post_cutting',kind:'duration',status:'running',actualStart:null,actualEnd:null,target:{at:null,exclusive:false,reasons:[]},forecast:{at:null,exclusive:false,reasons:[]},forecastBasis:'unknown',original:{at:null,exclusive:false,reasons:[]},current:{at:null,exclusive:false,reasons:[]},windows:[1,2,3].map(day=>({evidence:`TEST batch ${day}`,scopeLabel:`PO-${day} 黑`,startedAt:`2026-11-0${day}T00:00:00Z`,deadline:`2026-11-0${day+1}T00:00:00Z`,warningAt:null,complete:day===1,completedAt:day===1?'2026-11-01T01:00:00Z':null,snapshotId:`TEST frozen-${day}`}))};
 const html=renderToStaticMarkup(createElement(JourneyTimingWindows,{timing}));
 for(const day of [1,2,3]){expect(html).toContain(`PO-${day}`);expect(html).toContain(`2026/11/${day+1}`);expect(html).toContain(`TEST frozen-${day}`);}
 expect(html).toContain('已完成');expect(html).toContain('尚未完成');
});

it('P02-08/10: unknown and denied owners are not reported as a proven missing assignment',()=>{
 expect(cockpitPerson(null,'unknown')).toBe('负责人尚未取得');expect(cockpitPerson(null,'unavailable')).toBe('无权限查看');expect(cockpitPerson(null,'unassigned')).toBe('未指派');expect(cockpitPerson({id:'TEST',name:'原QC'},'assigned')).toBe('原QC');
});

it('renders a terminal legacy timing without calling it complete or erasing original R/D',()=>{
 const target={at:'2026-11-16T04:00:00.000Z',exclusive:false,reasons:[]};
 const timing:JourneyTiming={id:'TEST',label:'TEST 未完成纸样',stage:'development',kind:'duration',status:'terminated',actualStart:'2026-11-16T00:00:00.000Z',actualEnd:null,target,forecast:{at:null,exclusive:false,reasons:['已特殊结案，本窗口计时终止，未作为交付完成']},forecastBasis:'unknown',original:target,current:target,termination:{kind:'special_closure',at:'2026-11-16T00:00:00.000Z',sourceRef:'TEST original closure',elapsedSeconds:0,overdueSeconds:0}};
 const order={supervision:{asOf:'2026-11-17T00:00:00.000Z',status:'planned',originalRevision:1,currentRevision:1,nodes:[timing],coverage:[],customerReminderDate:null}} as OrderJourney;
 const html=renderToStaticMarkup(createElement(JourneySlaDetails,{order}));
 expect(html).toContain('计时已终止');expect(html).toContain('已特殊结案');expect(html).toContain('2026/11/16 12:00');expect(html).not.toContain('按时完成');expect(html).not.toContain('实际完成：');
 const node={state:'active',current:true,timing,risks:[],fixedTargets:[]} as unknown as JourneyNode;
 expect(nodeStatus(node)).toBe('计时已终止');expect(cockpitOwnStatus(node)).toEqual({text:'计时已终止',tone:'neutral'});
 expect(html).toContain('终止前计时用时：0小时');expect(html).toContain('历史超时：0小时');
 timing.termination!.elapsedSeconds=28800;timing.termination!.overdueSeconds=14400;
 const stopped=renderToStaticMarkup(createElement(JourneySlaDetails,{order}));expect(stopped).toContain('历史超时：4小时');expect(stopped).toContain('终止前计时用时：8小时');
 timing.status='unknown';timing.termination!.at=null;expect(nodeStatus(node)).toBe('已终止 · 责任时间待核');
});

it('P02-11/13: partial dates retain their coverage, plan sources and Beijing date-only boundary',()=>{
 expect(businessDateLabel({at:null,precision:'unknown',quality:'unknown',status:'partial',covered:1,total:2,reasons:[],coveredAt:{at:'2026-11-10',precision:'date'}},'plan')).toContain('已覆盖1/2项最晚2026-11-10 当天结束');
 expect(forecastBasisLabels.plan).toBe('按本单时效计划推算');expect(forecastBasisLabels.plan).not.toContain('已采用');
 for(const at of ['2026-11-11T00:00:00+08:00','2026-11-10T16:00:00Z'])expect(slaTargetLabel({at,exclusive:true,reasons:[]})).toContain('2026/11/10 当天结束');
 const at='2026-11-10T16:00:00Z',target={at,exclusive:true,reasons:[]};
 const timing:JourneyTiming={id:'TEST',label:'TEST',stage:'production',kind:'order_date',status:'warning',actualStart:null,actualEnd:null,target,forecast:target,forecastBasis:'plan',original:target,current:target};
 const node:Parameters<typeof nodeTargetLabel>[0]={instanceId:'TEST node',expectedAt:at,expectedKind:'sla',expectedPrecision:'instant',records:[],timing};
 expect(nodeTargetLabel(node)).toContain('2026/11/10 当天结束');
 node.records=[{domain:'task',id:node.instanceId,url:null,mode:'read',version:null,lineId:null}];
 node.deadlineMode='duration';node.deadlineExclusive=false;
 expect(nodeTargetLabel(node)).toContain('2026/11/11 00:00');expect(nodeTargetLabel(node)).not.toContain('当天结束');
 node.deadlineMode='date_target';node.deadlineExclusive=true;
 expect(nodeTargetLabel(node)).toContain('2026/11/10 当天结束');
});

it('P02-09: normal finishing, original registered quantity and effective process quantity are distinct',()=>{
 const row={reworkId:'TEST',reworkNo:null,status:'in_progress',problem:'',quantity:null,wageItemCount:0,businessSummary:{kind:'qc_rework' as const,processes:[{configurationItemId:'TEST process',processName:'绣花',executionKind:'worker',reportedQuantity:1,reportIds:['TEST report']}]}};
 expect(closureWorkQuantityLabel(row)).toContain('原单登记返工量 尚未记录');
 expect(closureWorkQuantityLabel({...row,quantity:2,businessSummary:{kind:'inhouse_finishing',processes:[]}})).toBe('普通做尾 · 原单登记量 2（不作为不良返工量）');
 const sheet={orderId:'TEST',revision:'a'.repeat(64),stage:'等待回货与装箱',lines:[{lineId:'TEST line',poNumber:'TEST PO',color:'黑',orderedQuantity:10,actualQuantity:1,documentQuantity:1,defectiveQuantity:0,receiptCount:1,packingQuantity:null,receivingBatchId:null,receipts:[],reworks:[row]}],outstanding:[],canClose:false,canOpenReceiving:true,canOpenRework:true,canOpenWages:false,closed:null,shipmentStatus:'未知',customerReceiptStatus:'未知'};
 const parsed=closureFeedbackProjection.parse(sheet);
 expect(parsed.lines[0]!.reworks[0]!.businessSummary!.processes[0]!.reportedQuantity).toBe(1);
 expect(closureFeedbackProjection.safeParse({...sheet,lines:[{...sheet.lines[0],reworks:[{...row,businessSummary:{kind:'qc_rework',processes:{}}}]}]}).success).toBe(false);
});
