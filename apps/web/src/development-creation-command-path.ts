import type {DevelopmentSubmissionOperation} from '@dx-rework/contracts/digital-development';

export const NUMBERED_DRAFT_PATH='sources/numbered-drafts';
export const isDraftReservationPath=(path:string)=>path==='sources/drafts'||path===NUMBERED_DRAFT_PATH;

export function developmentSubmissionPath(sourceId:string,operation:DevelopmentSubmissionOperation){
 return `sources/${sourceId}/${operation==='confirm'?'confirm':operation==='publish_preorder'?'development/publish-preorder':'development/publish'}`;
}
