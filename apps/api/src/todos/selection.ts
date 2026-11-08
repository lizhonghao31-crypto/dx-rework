import type {TodoResponse} from '@dx-rework/contracts';
/** Request-local selection only; no stored user result or shared permission cache. */
export type TodoSelectionKey=Pick<TodoResponse,'todoId'|'sourceAction'|'contentToken'|'unread'|'readAt'|'status'|'dueAt'|'createdAt'|'taskTitle'|'category'|'orderContext'|'recipientUserId'|'todoType'|'route'|'daysWithoutUpdate'>;
export type TodoSelection={key:TodoSelectionKey;load:()=>Promise<TodoResponse>};
export type TodoProjection={todoId?:string;countOnly?:boolean;select?:(key:TodoSelectionKey,load:TodoSelection['load'])=>void};
export function appendSelectedTodo(result:TodoResponse[],projection:TodoProjection|undefined,key:TodoSelectionKey,create:()=>TodoResponse){
 if(projection?.todoId&&projection.todoId!==key.todoId)return;
 if(projection?.select)projection.select(key,async()=>create());else result.push(create());
}

export function todoSelectionKey(todo:TodoResponse):TodoSelectionKey{
 const {todoId,sourceAction,contentToken,unread,readAt,status,dueAt,createdAt,taskTitle,category,orderContext,recipientUserId,todoType,route,daysWithoutUpdate}=todo;
 return {todoId,sourceAction,...(contentToken?{contentToken}:{}),...(unread===undefined?{}:{unread}),...(readAt===undefined?{}:{readAt}),status,dueAt,createdAt,...(taskTitle?{taskTitle}:{}),category,orderContext,recipientUserId,todoType,route,...(daysWithoutUpdate===undefined?{}:{daysWithoutUpdate})};
}

export async function appendSelectedTodoAsync(result:TodoResponse[],projection:TodoProjection|undefined,key:TodoSelectionKey,create:()=>Promise<TodoResponse>){
 if(projection?.todoId&&projection.todoId!==key.todoId)return;
 if(projection?.select)projection.select(key,create);else result.push(await create());
}
