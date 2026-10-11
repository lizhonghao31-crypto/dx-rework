import type {WorkflowNodeKey} from './rework-detail-page.js';
export function reworkResultNode(status:string,kind:string|undefined,node:WorkflowNodeKey|undefined):WorkflowNodeKey|undefined {
 return kind==='inhouse_finishing'&&status==='completed'&&(node===undefined||node==='settlement_followup')?'final_quantity_ie_review':node;
}
