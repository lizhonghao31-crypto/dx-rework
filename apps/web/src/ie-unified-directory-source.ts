import type {UnifiedIeDirectoryQuery} from '@dx-rework/contracts/digital-quotation';
import {digitalRequest} from './digital-production-api.js';

export type UnifiedDirectoryLoad=(query:UnifiedIeDirectoryQuery,signal:AbortSignal)=>Promise<unknown>;

export const readUnifiedIeDirectory:UnifiedDirectoryLoad=({kind,page,search,state='all'},signal)=>
 digitalRequest(`quotations/ie-directory?${new URLSearchParams({kind,page:String(page),search,state})}`,'GET',undefined,undefined,{signal});
