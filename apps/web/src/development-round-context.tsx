import {useEffect,useState} from 'react';
import {Button} from '@dx-rework/ui';
import {digitalRequest} from './digital-production-api.js';
export const developmentInheritedLabels:Record<string,string>={development_materials:'核配',development_pattern:'纸样',development_cutting:'裁板',development_printing:'印花',development_embroidery:'绣花',development_print_embroidery:'印绣花',development_craft_confirmation:'工艺确认',development_sewing:'车板',development_washing:'洗水',development_tail_check:'尾查',development_confirmation:'最终设计确认',development_shipping:'寄样',development_craft_dispatch:'发工艺',development_sewing_transfer:'转交车板',development_washing_dispatch:'送洗'};
type Round={roundNumber:number;origin:string;customerComment:string;internalProblem:string;explanation:string;affectedNodes:string[];inherited:Record<string,{taskId:string;roundNumber:number}>};
type ReadState={kind:'loading'}|{kind:'error';message:string}|{kind:'ready';round:Round|undefined};
/** Read the saved round; never derive redo/inheritance from the current task list. */
export function DevelopmentRoundContext({sourceId,roundNumber}:{sourceId:string;roundNumber:number}){
 const [state,setState]=useState<ReadState>({kind:'loading'}),[retry,setRetry]=useState(0);
 useEffect(()=>{if(roundNumber<=1)return;const abort=new AbortController();setState({kind:'loading'});void digitalRequest<{rounds:Round[]}>(`sources/${sourceId}/development/rounds`,'GET',undefined,undefined,{signal:abort.signal}).then(value=>{if(!abort.signal.aborted)setState({kind:'ready',round:value.rounds.find(round=>round.roundNumber===roundNumber)});}).catch(error=>{if(!abort.signal.aborted)setState({kind:'error',message:error instanceof Error?error.message:'本轮修改依据读取失败'});});return()=>abort.abort();},[sourceId,roundNumber,retry]);
 if(roundNumber<=1)return null;
 return <section aria-label="本轮退回与复版依据"><h3>本轮修改依据</h3>{state.kind==='loading'?<p role="status">正在读取本轮修改依据…</p>:state.kind==='error'?<p role="alert">{state.message} <Button type="button" onClick={()=>setRetry(value=>value+1)}>重读本轮修改依据</Button></p>:!state.round?<p>本轮修改依据未记录。</p>:<><p>{state.round.origin} · {state.round.customerComment||state.round.internalProblem||'原说明未记录'}</p>{state.round.explanation&&<p>{state.round.explanation}</p>}<p>重做：{state.round.affectedNodes.join('、')||'未记录重做节点'}；沿用：{Object.entries(state.round.inherited).map(([kind,reference])=>`${developmentInheritedLabels[kind]??'已完成节点'}（第${reference.roundNumber}轮）`).join('、')||'未记录沿用项'}</p></>}</section>;
}
