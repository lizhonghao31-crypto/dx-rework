import {useTodoContentRead} from './todo-content-read.js';
import {useState} from 'react';
import {PatternRoomExecutionWorkspace} from './pattern-room-orders-page.js';
import {Surface} from '@dx-rework/ui';
import {PageHeader} from '@dx-rework/ui/production';
import {DevelopmentAssignmentTable} from './development-assignment-table.js';
import {useDevelopmentExecution} from './digital-development-execution-panel.js';
import {DigitalReadFailure} from './digital-read-failure.js';
export function DevelopmentArrangementPage({sourceId,round,onClose}:{sourceId:string;round?:number|undefined;onClose:()=>void}){
 const controller=useDevelopmentExecution({sourceId}),{state,busy}=controller;
 const [arrangementDirty,setArrangementDirty]=useState(false);
 const current=state?.arrangement,stale=Boolean(round&&current&&round!==current.roundNumber);
 const readRef=useTodoContentRead({routeName:'digital_development_arrangement',entityId:sourceId,developmentRound:current?.roundNumber},Boolean(state&&current&&!stale&&!controller.readError));
 const receipt=typeof sessionStorage!=='undefined'&&sessionStorage.getItem(`development-check:${sourceId}:${round??current?.roundNumber}`)==='completed';
 return <div ref={readRef}><PageHeader title={state?.sheet.designStyleNo??'本轮人员安排'} description="核料后一次安排本轮实际流程；各工序仍按真实前置开始。"/><button type="button" className="development-text-action" disabled={busy} onClick={onClose}>← 返回来源</button>
 {receipt&&<p role="status">核料已完成。本页可一次安排本轮师傅。</p>}
 {controller.readError&&<DigitalReadFailure error={controller.readError} onRetry={()=>void controller.recheck()} busy={busy}/>}
 {!state&&!controller.readError&&<p role="status">正在读取本轮安排…</p>}
 {state&&<Surface><h2>第 {current?.roundNumber??state.sheet.roundNumber??1} 轮 · 安排本轮师傅</h2>
 {stale?<p>此链接属于第 {round} 轮，当前已是第 {current?.roundNumber} 轮。旧轮安排不能在这里改写。<a href={`${controller.urls.pageUrl('ui/digital-production')}?development=${sourceId}&round=${round}`}>查看原轮资料</a> · <a href={`${controller.urls.pageUrl('ui/digital-production')}?arrangement=${sourceId}&round=${current?.roundNumber}`}>打开当前轮安排</a></p>:<DevelopmentAssignmentTable controller={controller} editing onDirtyChange={setArrangementDirty}/>}
 {!stale&&state.canConfirmExecution&&state.patternOrder&&<details className="development-special-execution"><summary>返工金额、已有执行段换人及原执行处理</summary><p>首次正常车板沿冻结执行价和真实前置自动衔接。以下仅提供本账号原有权限的特殊办理，金额、工时和历史按原执行记录保留。</p>{arrangementDirty?<p role="status">人员安排有未保存修改，请先保存或核对本页人员选择，再处理原执行。</p>:<PatternRoomExecutionWorkspace developmentContext={current?{sourceId,plan:current}:undefined} orderId={state.patternOrder.orderId} disabled={busy||controller.uncertainWrite} onChanged={()=>void controller.recheck()}/>}</details>}

 </Surface>}</div>;
}
