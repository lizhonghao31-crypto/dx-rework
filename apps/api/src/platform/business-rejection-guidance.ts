import {businessValue} from '@dx-rework/contracts/business-display';
const sourcing:Record<string,string>={pending_merchandiser_correction:'待跟单修改',pending_ie_quote:'待IE报价',pending_management_decision:'待生产管理选厂',pending_owner_approval:'待老板审批',pending_contract:'待合同办理',pending_finance_reconciliation:'待财务核对',pending_factory_change_verification:'待转厂核实',pending_exception_verification:'待差异核实',closed:'已关闭'};
/** Current/expected state labels only; no amounts, staff names or raw error details. */
export function workflowStateLabel(state:string){const label=sourcing[state]??businessValue('status',state);return label===state?'状态待核实':label;}
export function workflowStateRejection(subject:string,current:string,expected:readonly string[],entry:string){
 return `${subject}当前为「${workflowStateLabel(current)}」，此操作仅适用于${expected.map(state=>`「${workflowStateLabel(state)}」`).join('或')}。请在${entry}重新读取当前记录，由该节点原负责岗位继续办理；不要重复提交旧页面操作。`;
}
export function reworkTransitionRejection(message:string){
 const match=/^Cannot transition from ([a-z_]+) to ([a-z_]+)$/.exec(message);
 if(!match||workflowStateLabel(match[1]!)==='状态待核实'||workflowStateLabel(match[2]!)==='状态待核实')return '返工操作未通过当前流程校验，系统未提供可确认的具体原因；请重新读取本单当前办理页，仍被阻断时提供订单链接给管理员核查';
 return `返工单当前为「${workflowStateLabel(match[1]!)}」，不能直接改为「${workflowStateLabel(match[2]!)}」。请从本单当前办理页或我的待办核对当前轮次，由原负责岗位完成当前事项后继续；未改变原记录。`;
}
