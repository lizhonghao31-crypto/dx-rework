import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import type {useDevelopmentExecution} from './digital-development-execution-panel.js';
/** One result uploader shared by the legacy task adapter and confirmed workbench. */
export function DevelopmentResultUpload({controller,task}:{controller:ReturnType<typeof useDevelopmentExecution>;task:DigitalTask}){
 if(!task.canExecute||task.state!=='ready'||!['development_pattern','development_sewing','development_tail_check'].includes(task.taskKind))return null;
 const paper=task.taskKind==='development_pattern',tail=task.taskKind==='development_tail_check',purpose=paper?'纸样成果':tail?'尾查照片':'车板成果';
 if(tail&&!controller.state?.slaEnrolled)return null;
 const {busy,upload}=controller,files=paper?controller.craftFiles:tail?controller.tailFiles:controller.sewingFiles;
 return <>{controller.previews.view}<label>{paper?'纸样成果（工艺开发板 / 照片）':tail?'尾查照片':'车板成果'}<input type="file" disabled={busy} multiple accept={tail?'image/jpeg,image/png,image/webp':'image/jpeg,image/png,image/webp,application/pdf'} onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value='';void upload(files,purpose,task.taskId);}}/></label><p>{files.length?`已上传 ${files.length} 份，返回当前办理提交后正式引用。`:'没有待提交的上传文件。'}</p></>;
}
