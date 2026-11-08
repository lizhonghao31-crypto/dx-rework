import {QueuePageQuerySchema,type QueuePageQuery} from '@dx-rework/contracts';
import {ApplicationError} from '../platform/errors.js';

export function queuePage(input?:QueuePageQuery){
 if(input===undefined)return undefined;
 const parsed=QueuePageQuerySchema.safeParse(input);
 if(!parsed.success)throw new ApplicationError('VALIDATION_ERROR','请检查队列页码或搜索内容',400);
 const page=parsed.data.page??1;
 return {page,search:parsed.data.search??'',offset:(page-1)*15};
}
export const queuePageMetadata=(query:ReturnType<typeof queuePage>,total:number)=>query?{page:query.page,pageSize:15 as const,totalCount:total}:{};
