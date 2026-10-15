import {useState} from 'react';
import {Button} from '@dx-rework/ui';
import {useDevelopmentExecution} from './digital-development-execution-panel.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
export function DevelopmentFabricReport({controller}:{controller:ReturnType<typeof useDevelopmentExecution>}){
 const [note,setNote]=useState(''),[recommendation,setRecommendation]=useState('正常');
 const {busy,reportFiles,upload,run,writing}=controller;
 useDigitalDetailNavigationGuard(Boolean(note||reportFiles.length),busy,writing,'检测报告尚未提交，确定离开？');
 return <form onSubmit={event=>{event.preventDefault();void run('fabric-reports',{recommendation,note,attachmentIds:reportFiles}).then(result=>{if(result)setNote('');});}}><fieldset disabled={busy}><legend>面料检测报告</legend>{controller.previews.view}<label>检测报告<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value='';void upload(files,'面料报告');}}/></label><p>本次已上传 {reportFiles.length} 个文件，尚未提交报告事实。</p><label>建议<select aria-label="报告建议" value={recommendation} onChange={event=>setRecommendation(event.target.value)}><option>正常</option><option>建议停用</option></select></label><label>检测说明 *<input value={note} onChange={event=>setNote(event.target.value)} required maxLength={1000}/></label><Button type="submit" disabled={!reportFiles.length}>保存检测报告</Button><p>保存报告不替代总监的实际决定。</p></fieldset></form>;
}
export function DevelopmentFabricReportEntry({sourceId,round,onSaved}:{sourceId:string;round?:number|undefined;onSaved:()=>void}){
 const controller=useDevelopmentExecution({sourceId,onChanged:onSaved});
 if(controller.error)return <p role="alert">{controller.error}</p>;
 const state=controller.state;
 if(!state)return <p role="status">正在核对报告权限…</p>;
 return state.canReportFabric&&state.sheet.status==='published'&&(!round||round===state.sheet.latestRoundNumber)?<DevelopmentFabricReport controller={controller}/>:null;
}
