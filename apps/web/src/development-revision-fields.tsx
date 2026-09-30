import {DEVELOPMENT_PROBLEM_CATEGORIES,DEVELOPMENT_REVISION_NODES,type DevelopmentRevision} from '@dx-rework/contracts/digital-development-rounds';
export type RevisionFields=Omit<DevelopmentRevision,'document'>;
export function DevelopmentRevisionFields({value,onChange,disabled}:{value:RevisionFields;onChange:(value:RevisionFields)=>void;disabled:boolean}){
 const edit=(patch:Partial<RevisionFields>)=>onChange({...value,...patch});
 return <fieldset disabled={disabled}><legend>第 {value.basedOnRound+1} 轮修改依据</legend>
  <label>修改来源<select value={value.origin} onChange={event=>edit({origin:event.target.value as RevisionFields['origin'],customerComment:'',internalProblem:''})}><option>客户新增要求</option><option>未达原要求</option><option>内部发现</option></select></label>
  {value.origin==='内部发现'?<label>内部问题<textarea value={value.internalProblem} required maxLength={4000} onChange={event=>edit({internalProblem:event.target.value})}/></label>:<label>客户原评语<textarea value={value.customerComment} required maxLength={4000} onChange={event=>edit({customerComment:event.target.value})}/></label>}
  <label>补充说明<textarea value={value.explanation} maxLength={4000} onChange={event=>edit({explanation:event.target.value})}/></label>
  <label>本轮交付<select value={value.outputKind} onChange={event=>edit({outputKind:event.target.value as RevisionFields['outputKind']})}><option>整件样板</option><option>工艺布片</option></select></label>
  <fieldset><legend>问题分类（可多选）</legend>{DEVELOPMENT_PROBLEM_CATEGORIES.map(item=><label key={item}><input type="checkbox" checked={value.categories.includes(item)} onChange={event=>edit({categories:event.target.checked?[...value.categories,item]:value.categories.filter(old=>old!==item)})}/>{item}</label>)}</fieldset>
  <fieldset><legend>需要重做的节点</legend>{DEVELOPMENT_REVISION_NODES.map(item=><label key={item}><input type="checkbox" checked={value.affectedNodes.includes(item)} onChange={event=>edit({affectedNodes:event.target.checked?[...value.affectedNodes,item]:value.affectedNodes.filter(old=>old!==item)})}/>{item}</label>)}</fieldset>
  <p>下方修改本轮制作资料；客户图片可在附件中选择“局部图”上传。未受影响且已完成的工作将保留原记录。</p>
 </fieldset>;
}
