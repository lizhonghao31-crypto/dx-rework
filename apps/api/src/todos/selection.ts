import type {TodoResponse} from '@dx-rework/contracts';
import type {RushIdentity} from '../production-platform/development-order-rush.js';
/** Request-local selection only; no stored user result or shared permission cache. */
export type TodoSelectionKey=Pick<TodoResponse,'todoId'|'sourceAction'|'contentToken'|'unread'|'readAt'|'status'|'dueAt'|'createdAt'|'taskTitle'|'category'|'orderContext'|'recipientUserId'|'todoType'|'route'|'daysWithoutUpdate'> & {
 requiredRole?:TodoResponse['requiredRole'];
 /** Only the current original preorder handover recipient can get these fields. */
 preorderSearch?:{customer:string|null;poNumbers:readonly string[]};
};
export type TodoSelection={key:TodoSelectionKey;load:()=>Promise<TodoResponse>;rushIdentity?:RushIdentity};
export type MerchandiserTodoSelection=Pick<TodoSelection,'key'|'rushIdentity'>;
export type TodoProjection={todoId?:string;countOnly?:boolean;merchandiserSelection?:boolean;select?:(key:TodoSelectionKey,load:TodoSelection['load'],rushIdentity?:RushIdentity)=>void};
export function appendSelectedTodo(result:TodoResponse[],projection:TodoProjection|undefined,key:TodoSelectionKey,create:()=>TodoResponse,rushIdentity?:RushIdentity){
 if(projection?.todoId&&projection.todoId!==key.todoId)return;
 if(projection?.select)projection.select(key,async()=>create(),rushIdentity);else result.push(create());
}

export function todoSelectionKey(todo:TodoResponse):TodoSelectionKey{
 const {todoId,sourceAction,contentToken,unread,readAt,status,dueAt,createdAt,taskTitle,category,orderContext,recipientUserId,todoType,route,daysWithoutUpdate}=todo;
 return {todoId,sourceAction,...(contentToken?{contentToken}:{}),...(unread===undefined?{}:{unread}),...(readAt===undefined?{}:{readAt}),status,dueAt,createdAt,...(taskTitle?{taskTitle}:{}),category,orderContext,recipientUserId,todoType,route,requiredRole:todo.requiredRole,...(daysWithoutUpdate===undefined?{}:{daysWithoutUpdate})};
}

export async function appendSelectedTodoAsync(result:TodoResponse[],projection:TodoProjection|undefined,key:TodoSelectionKey,create:()=>Promise<TodoResponse>,rushIdentity?:RushIdentity){
 if(projection?.todoId&&projection.todoId!==key.todoId)return;
 if(projection?.select)projection.select(key,create,rushIdentity);else result.push(await create());
}
