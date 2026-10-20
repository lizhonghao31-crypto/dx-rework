import {Button,Surface} from '@dx-rework/ui';
import {PageHeader} from '@dx-rework/ui/production';
import {DevelopmentAssignmentTable} from './development-assignment-table.js';
import {useDevelopmentExecution} from './digital-development-execution-panel.js';
import {DigitalReadFailure} from './digital-read-failure.js';
export function DevelopmentArrangementPage({sourceId,round,onClose}:{sourceId:string;round?:number|undefined;onClose:()=>void}){
 const controller=useDevelopmentExecution({sourceId}),{state,busy}=controller;
 const current=state?.arrangement,stale=Boolean(round&&current&&round!==current.roundNumber);
 const receipt=typeof sessionStorage!=='undefined'&&sessionStorage.getItem(`development-check:${sourceId}:${round??current?.roundNumber}`)==='completed';
 return <><PageHeader title={state?.sheet.designStyleNo??'本轮人员安排'} description="核料后一次安排本轮实际流程；各工序仍按真实前置开始。"/><Button disabled={busy} onClick={onClose}>返回我的待办 / 来源</Button>
 {receipt&&<p role="status">核料已完成。本页可一次安排本轮师傅。</p>}
 {controller.readError&&<DigitalReadFailure error={controller.readError} onRetry={()=>void controller.recheck()} busy={busy}/>}
 {!state&&!controller.readError&&<p role="status">正在读取本轮安排…</p>}
 {state&&<Surface><h2>第 {current?.roundNumber??state.sheet.roundNumber??1} 轮 · 安排本轮师傅</h2>
 {stale?<p>此链接属于第 {round} 轮，当前已是第 {current?.roundNumber} 轮。旧轮安排不能在这里改写。<a href={`${controller.urls.pageUrl('ui/digital-production')}?development=${sourceId}&round=${round}`}>查看原轮资料</a> · <a href={`${controller.urls.pageUrl('ui/digital-production')}?arrangement=${sourceId}&round=${current?.roundNumber}`}>打开当前轮安排</a></p>:<DevelopmentAssignmentTable controller={controller} editing/>}
 {state.patternPreparation&&<section><h3>车板执行归属</h3><p>{state.patternPreparation.roundType==='rework'?'本轮返工金额及执行归属由技术主管核定。':state.patternPreparation.workerName?`当前执行归属：${state.patternPreparation.workerName}。已有执行段换人由技术主管办理。`:state.patternPreparation.categorySaved&&state.patternPreparation.priceSaved?'首次执行依据已保存，人员和真实前置齐备后自动衔接。':'本单品类或冻结执行价资料待补齐，请原设计师核实执行资料。'}</p>{state.canConfirmExecution&&state.patternOrder&&<a href={`${controller.urls.pageUrl(`ui/pattern-room/orders/${state.patternOrder.orderId}`)}?returnTo=${encodeURIComponent(window.location.pathname+window.location.search)}`}>打开本单原执行记录，处理返工金额 / 已有执行段换人</a>}</section>}
 </Surface>}</>;
}
