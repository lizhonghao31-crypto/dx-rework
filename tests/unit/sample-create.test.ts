import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SampleBatchCreateSchema, SampleCreateSchema } from "../../packages/contracts/src/sample-create.js";
describe("sample creation boundary", () => {
  const item = {brand:"品牌",styleName:"名称",color:"蓝",department:"设计",purchaseDate:"2026-01-01",purchasePrice:"0.00",purchaserUserId:randomUUID(),receiptAttachmentIds:[randomUUID()]};
  it("requires procurement evidence and exact decimal money without trusting client status or code", () => {
    expect(SampleCreateSchema.parse(item).imageAttachmentIds).toEqual([]);
    for (const patch of [{receiptAttachmentIds:[]},{purchasePrice:1.23},{purchasePrice:"1.234"},{purchasePrice:"-1.00"},{purchaseDate:"2026-02-30"},{status:"in_stock"},{sampleCode:"YI-202609-0001"},{holderUserId:"同名员工"}]) expect(SampleCreateSchema.safeParse({...item,...patch}).success).toBe(false);
  });
  it("limits batches and prevents private receipts being mixed into public images", () => {
    expect(SampleBatchCreateSchema.safeParse({items:Array.from({length:50},()=>item)}).success).toBe(true);
    expect(SampleBatchCreateSchema.safeParse({items:Array.from({length:51},()=>item)}).success).toBe(false);
    expect(SampleCreateSchema.safeParse({...item,imageAttachmentIds:item.receiptAttachmentIds}).success).toBe(false);
    expect(SampleCreateSchema.safeParse({...item,receiptAttachmentIds:[...item.receiptAttachmentIds,...item.receiptAttachmentIds]}).success).toBe(false);
  });
});
