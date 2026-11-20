import type {BulkPatternCardPage,BulkWorkroomResult} from '@dx-rework/contracts/bulk-preparation';

/** Serve the requested contract while retaining old-data fixtures and original detail reads. */
export function bulkPatternFixtureResponse(result:BulkWorkroomResult,query:URLSearchParams):BulkWorkroomResult|BulkPatternCardPage{
  if(query.get('view')!=='cards')return result;
  return {...result,items:result.items.map(({sheet,...item})=>({...item,card:{
    preparationId:sheet.preparationId,
    reasons:sheet.reasons,
    facts:sheet.facts.map(({kind})=>({kind})),
    task:sheet.tasks.find(task=>task.taskKind==='bulk_pattern')??null,
    lines:sheet.cutting.lines.map(({lineId,poNumber,formalStyleNo,temporaryStyleNo,color})=>({lineId,poNumber,formalStyleNo,temporaryStyleNo,color})),
  }}))};
}
