import { describe, expect, it, vi } from "vitest";
import { settleWageBatches } from "../../apps/web/src/wages/wage-settlement-batches.js";
describe("confirmed wage snapshot batches",()=>{
 it("submits every confirmed ID above 100000 without widening the snapshot",async()=>{
  const ids=Array.from({length:100001},(_,i)=>String(i));const sent:string[]=[];
  const result=await settleWageBatches(ids,async batch=>{expect(batch.length).toBeLessThanOrEqual(10000);sent.push(...batch);return {markedCount:batch.length};});
  expect(result.markedCount).toBe(100001);expect(sent).toEqual(ids);
 });
 it("stops on failure, explains retry and does not send later batches",async()=>{
  const send=vi.fn().mockResolvedValueOnce({markedCount:10000}).mockRejectedValueOnce(new Error('连接中断'));
  await expect(settleWageBatches(Array(25000).fill('id'),send)).rejects.toThrow('已完成的标记会保留');expect(send).toHaveBeenCalledTimes(2);
 });
 it("counts newly marked rows only on retry",async()=>{
  expect(await settleWageBatches(['old','new'],async()=>({markedCount:1}))).toEqual({markedCount:1});
 });
});
