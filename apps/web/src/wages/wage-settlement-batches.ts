export class WageSettlementBatchError extends Error {
  constructor(readonly markedCount:number,readonly uncertainFrom:number,readonly uncertainTo:number,readonly notAttemptedCount:number,cause:unknown) {
    super(`${cause instanceof Error ? cause.message : "工资结算标记失败"}。已完成的标记会保留：确认成功新增 ${markedCount} 条；第 ${uncertainFrom}–${uncertainTo} 条本次结果未确认，尚有 ${notAttemptedCount} 条未发送。请刷新后对剩余明细重试。`);
    this.name="WageSettlementBatchError";
  }
}
// The confirmed snapshot may exceed a single HTTP request; never reselect IDs between batches.
export async function settleWageBatches(lineIds: readonly string[], send: (ids: string[]) => Promise<{markedCount:number}>): Promise<{markedCount:number}> {
  let markedCount=0;
  for(let offset=0;offset<lineIds.length;offset+=10000){
    const end=Math.min(offset+10000,lineIds.length);
    try {markedCount+=(await send(lineIds.slice(offset,end))).markedCount;}
    catch(error){throw new WageSettlementBatchError(markedCount,offset+1,end,lineIds.length-end,error);}
  }
  return {markedCount};
}
