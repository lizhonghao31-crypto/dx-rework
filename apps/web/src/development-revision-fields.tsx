import {DEVELOPMENT_PROBLEM_CATEGORIES,DEVELOPMENT_REVISION_NODES,type DevelopmentRevision} from '@dx-rework/contracts/digital-development-rounds';
import type {DevelopmentTechnicalState} from '@dx-rework/contracts/digital-development-technical';
import {Selector} from '@astryxdesign/core/Selector';
import {Button} from '@astryxdesign/core/Button';
import {useCallback} from 'react';
import {digitalRequest} from './digital-production-api.js';
import {useForegroundRead} from './use-foreground-read.js';
import {useForegroundWait} from './foreground-loading.js';
export type RevisionFields=Omit<DevelopmentRevision,'document'>;
function OriginalCommentChoice({sourceId,value,edit,disabled}:{sourceId:string;value:RevisionFields;edit:(change:Partial<RevisionFields>)=>void;disabled:boolean}){
 const load=useCallback(async(signal:AbortSignal)=>{
  const data=await digitalRequest<DevelopmentTechnicalState>(`sources/${sourceId}/execution/technical?roundNumber=${value.basedOnRound}`,'GET',undefined,undefined,{signal});
  if(!data||data.roundNumber!==value.basedOnRound||!Array.isArray(data.comments))throw Error('未能核实本单本轮客户评语，请重试。');
  return data.comments.filter(row=>row.roundNumber===value.basedOnRound&&row.scopeRef===data.scopeRef&&(row.decision==='changes_required'||!row.isFinal&&row.decision==='noted'));
 },[sourceId,value.basedOnRound]);
 const read=useForegroundRead(sourceId,`${value.basedOnRound}:revision-comments`,load);
 useForegroundWait(read.foregroundKey);
 const selected=value.customerCommentRef;
 if(read.error)return <><p role="alert">{read.error.message}</p><Button label="重新读取原评语" onClick={read.retry}/></>;
 const comments=read.value??[];
 if(!read.waiting&&!comments.length&&!selected)return <p>本轮没有要求修改的原客户评语。</p>;
 return <Selector label="采用本轮原客户评语" value={selected?.commentId??''} isDisabled={disabled||read.waiting}
  options={[{value:'',label:'请选择原客户评语'},...comments.map(item=>({value:item.commentId,label:`v${item.version} · ${item.text.slice(0,44)}`}))]}
  onChange={next=>{const item=comments.find(row=>row.commentId===next);edit(item?{customerComment:item.text,customerCommentRef:{
   sourceId,roundNumber:item.roundNumber,scopeRef:item.scopeRef,commentId:item.commentId,version:item.version,
  }}:{customerComment:'',customerCommentRef:undefined});}}/>;
}
export function DevelopmentRevisionFields({value,onChange,disabled,sourceId}:{value:RevisionFields;onChange:(value:RevisionFields)=>void;disabled:boolean;sourceId?:string}){
 const edit=(patch:Partial<RevisionFields>)=>onChange({...value,...patch});
 return <fieldset disabled={disabled}><legend>第 {value.basedOnRound+1} 轮修改依据</legend>
  <label>修改来源<select value={value.origin} onChange={event=>edit({origin:event.target.value as RevisionFields['origin'],customerComment:'',internalProblem:'',customerCommentRef:undefined,repeatOriginalComment:undefined})}><option>客户新增要求</option><option>未达原要求</option><option>内部发现</option></select></label>
  {value.origin!=='内部发现'&&sourceId&&!value.repeatOriginalComment&&<OriginalCommentChoice sourceId={sourceId} value={value} edit={edit} disabled={disabled}/>}
  {value.origin==='内部发现'?<label>内部问题 *<textarea value={value.internalProblem} required maxLength={4000} onChange={event=>edit({internalProblem:event.target.value})}/></label>:<label>客户原评语 *<textarea value={value.customerComment} readOnly={Boolean(value.customerCommentRef)} required maxLength={4000} onChange={event=>edit({customerComment:event.target.value})}/></label>}
  <label>补充说明<textarea value={value.explanation} maxLength={4000} onChange={event=>edit({explanation:event.target.value})}/></label>
  <label>本轮交付<select value={value.outputKind} onChange={event=>edit({outputKind:event.target.value as RevisionFields['outputKind']})}><option>整件样板</option><option>工艺布片</option></select></label>
  <fieldset><legend>问题分类（可多选）</legend>{DEVELOPMENT_PROBLEM_CATEGORIES.map(item=><label key={item}><input type="checkbox" checked={value.categories.includes(item)} onChange={event=>edit({categories:event.target.checked?[...value.categories,item]:value.categories.filter(old=>old!==item)})}/>{item}</label>)}</fieldset>
  <fieldset><legend>需要重做的节点</legend>{DEVELOPMENT_REVISION_NODES.map(item=><label key={item}><input type="checkbox" checked={value.affectedNodes.includes(item)} onChange={event=>edit({affectedNodes:event.target.checked?[...value.affectedNodes,item]:value.affectedNodes.filter(old=>old!==item)})}/>{item}</label>)}</fieldset>
  <p>下方修改本轮制作资料；客户图片可在附件中选择“局部图”上传。未受影响且已完成的工作将保留原记录。</p>
 </fieldset>;
}
