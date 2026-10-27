import {describe,expect,it} from 'vitest';
import {buildWorkflow,type ReworkBusinessDetail} from '../../apps/web/src/rework-detail-page.js';
const detail=(status:ReworkBusinessDetail['status'],history:ReworkBusinessDetail['workflowHistory']=[])=>({status,createdBy:{userId:'original',displayName:'TEST发起人'},processConfigurationCreatedBy:null,tailInspectionRequired:false,workflowHistory:history}) as ReworkBusinessDetail;
const visitor={id:'visitor',displayName:'TEST当前访问者',isRoot:true,capabilities:[],businessRoles:[]};
const n05=(value:ReworkBusinessDetail)=>buildWorkflow(value,visitor,'whole_order_review').flatMap(stage=>stage.nodes).find(node=>node.key==='whole_order_review')!;
describe('N05 separates prerequisites and actual people',()=>{
 it('does not infer an assignee from the current visitor or a todo route',()=>{const node=n05(detail('pending_order_review'));expect(node.ownerRole).toBe('尾部主管');expect(node.ownerName).toBe('未记录具体负责人');expect(node).toHaveProperty('prerequisite','执行报数已完成，可办理最终数量确认');});
 it('keeps the future prerequisite out of the person field',()=>{const node=n05(detail('in_progress'));expect(node.ownerName).toBe('未记录具体负责人');expect(node).toHaveProperty('prerequisite','待全部执行报数完成');});
 it('uses only a completed N05 handling fact, not a prior configuration actor',()=>{const node=n05(detail('pending_final_quantity_ie_review',[{action:'rework.tail_completion.confirm',handledBy:'TEST原办理人',handledAt:'2026-10-26T09:00:00Z',remark:null}]));expect(node.ownerName).toBe('TEST原办理人');});
 it('does not treat an earlier confirmation as an assignment after IE returns N05',()=>{expect(n05(detail('pending_order_review',[{action:'rework.tail_completion.confirm',handledBy:'TEST上轮办理人',handledAt:'2026-10-26T09:00:00Z',remark:null}])).ownerName).toBe('未记录具体负责人');});
 it('leaves ambiguous same-time completed handlers unknown',()=>{expect(n05(detail('pending_final_quantity_ie_review',['A','B'].map(handledBy=>({action:'rework.tail_completion.confirm',handledBy,handledAt:'2026-10-26T09:00:00Z',remark:null})))).ownerName).toBe('未记录具体负责人');});
 it('does not describe a cancelled order as waiting for new work',()=>{expect(n05(detail('cancelled'))).toHaveProperty('prerequisite','订单已取消，不可办理');});
});
