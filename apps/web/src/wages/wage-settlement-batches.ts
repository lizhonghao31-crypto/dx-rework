// The confirmed snapshot may exceed a single HTTP request; never reselect IDs between batches.
export async function settleWageBatches(lineIds: readonly string[], send: (ids: string[]) => Promise<{markedCount:number}>): Promise<{markedCount:number}> {
  let markedCount=0;
  for(let offset=0;offset<lineIds.length;offset+=10000){
    try {markedCount+=(await send(lineIds.slice(offset,offset+10000))).markedCount;}
    catch(error){throw new Error(`${error instanceof Error?error.message:"工资结算标记失败"}。已完成的标记会保留，请刷新后对剩余明细重试。`);}
  }
  return {markedCount};
}
