import type {DigitalTask} from "@dx-rework/contracts/digital-production-tasks";
import type {InstructionSheet} from "@dx-rework/contracts/production-instruction";

export function developmentActionReceipt(path:string,body:{result?:unknown},submitted:DigitalTask|undefined,tasks:DigitalTask[]):string{
 const action:Record<string,string>={"reopen-materials":"已接回文员重新核料，尚未确认通过。",dispatch:"人员预派已保存；任务按原前置条件启动。","pattern-order":"打板执行准备已提交。",resubmit:"补料已提交复核。","fabric-reports":"面料报告已提交。","customer-sample":"本轮客户样板确认已记录。","supplement-check":"本轮补充核验已发起。","send-washing":"实际送洗已登记。"};
 if(action[path])return action[path];
 if(path==='material-verification')return '核料输入已保存，尚未完成本次核料。';
 if(path==='fabric-decisions')return '面料决定已保存，报告待办已处理；请核对当前质量结果，文员仍需提交核料。';
 if(path==='check'&&body.result==='缺项退回')return '面辅料缺项已记录，等待补充后复核。';
 if(body.result==='退回')return `${submitted?.label??'本任务'}退回已记录。`;
 const current=tasks.find(task=>task.taskId===submitted?.taskId);
 const receipt=current?.state==='completed'?`${current.label}已完成。`:`${submitted?.label??'本次办理'}已提交。`;
 if(!submitted)return receipt;
 const visible=tasks.filter(task=>task.taskId!==submitted.taskId&&task.routeVersion===submitted.routeVersion);
 const ready=visible.filter(task=>task.state==='ready'&&task.canExecute);
 return receipt+(ready.length?`当前可办理：${ready.map(task=>`${task.label}（${task.assigneeName??'等待分派'}）`).join('、')}。`:visible.some(task=>task.state==='pending')?'当前可见任务仍在等待前置或岗位安排。':'当前没有其他可见的可办理任务。');
}

export function taskWorkbenchFeedback(task:DigitalTask,{busy,dirty,notice,pendingFiles,unreadyFiles}:{busy:boolean;dirty:boolean;notice:string;pendingFiles:boolean;unreadyFiles?:boolean}):string{
 if(busy)return '正在处理，请勿重复提交';
 if(unreadyFiles)return '仍有附件尚未就绪，请核对上传状态';
 if(pendingFiles)return '附件已上传，尚未随本次办理提交';
 if(dirty)return '办理输入尚未提交，切换页签会保留';
 if(notice)return notice;
 if(task.state==='completed')return '本任务已完成，办理记录已保存';
 if(task.state==='cancelled')return '本任务已取消，记录仅供查看';
 return '当前没有未提交的办理输入';
}

export function taskAuxiliaryReceipt(action:string,body:{blocked?:unknown}={}):string{
 if(action==='feedback')return body.blocked===true?'问题已记录':'恢复办理已提交';
 const receipts:Record<string,string>={handover:'实际接收已登记',reassign:'当前岗位改派已保存',priority:'优先级已更新',lifecycle:'业务状态已保存'};
 return receipts[action]??'本次操作已提交';
}

export function instructionActionReceipt(path:string,method:string,sheet:Pick<InstructionSheet,'version'|'publishedVersion'>):string{
 if(path==='/publish')return sheet.publishedVersion&&sheet.publishedVersion===sheet.version?`有效制单版本 ${sheet.publishedVersion} 已发布。`:'发布请求已提交，请核对当前有效版本。';
 if(path===''&&method==='PUT')return `制单草稿已保存。${sheet.publishedVersion!==sheet.version?'当前草稿尚未发布。':''}`;
 if(path==='/source-review')return '采用的开发资料已核对并保存。';
 return '本次办理已提交。';
}
