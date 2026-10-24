import {z} from 'zod';
// Read projections check renderable types only. They neither rewrite historical
// fields nor apply current publication limits/business validation to old records.
const text=z.string(),nullable=text.nullable(),strings=z.array(text),quantity=z.number();
const orderLine=z.object({lineId:text,color:text,sizes:z.array(z.object({size:text,quantity}).passthrough()),poNumber:nullable.optional(),formalStyleNo:nullable.optional(),temporaryStyleNo:nullable.optional()}).passthrough();
const instructionDocument=z.object({
 styleName:text,category:text,season:text,fabricType:text,composition:text,date:nullable,process:text,secondaryCraft:text.optional(),remarks:text,patternMaker:text,preshrink:text,shipSample:text,sewingRequirements:text,comments:text,unit:text,sizes:strings,
 fabrics:z.array(z.object({id:text,name:text,part:text,colors:z.record(text,text),remarks:text}).passthrough()),
 accessories:z.array(z.object({id:text,group:text,garmentColors:text,materialColor:text,name:text,category:text,part:text,specification:text,consumption:text,remarks:text}).passthrough()),
 images:z.array(z.object({attachmentId:text,kind:text,description:text}).passthrough()),
 measurements:z.array(z.object({id:text,name:text,tolerance:text,method:text,values:strings}).passthrough()),
}).passthrough();
export const instructionFeedbackProjection=z.object({order:z.object({productionOrderId:text,lines:z.array(orderLine)}).passthrough(),version:z.number().int().nonnegative(),document:instructionDocument,canEdit:z.boolean(),cutStarted:z.boolean()}).passthrough();
const receipt=z.object({receiptId:text,receivedAt:text.nullable(),actualQuantity:quantity,defectiveQuantity:quantity}).passthrough();
const rework=z.object({reworkId:text,canView:z.boolean().optional(),reworkNo:nullable,status:text,problem:text,quantity:quantity.nullable(),wageItemCount:quantity}).passthrough();
const closureLine=z.object({lineId:text,poNumber:nullable,color:text,orderedQuantity:quantity,actualQuantity:quantity,documentQuantity:quantity,defectiveQuantity:quantity,receiptCount:quantity,packingQuantity:quantity.nullable(),receivingBatchId:nullable,receivingResolution:nullable.optional(),packingResolution:nullable.optional(),receipts:z.array(receipt),reworks:z.array(rework)}).passthrough();
export const closureFeedbackProjection=z.object({orderId:text,revision:text.regex(/^[a-f0-9]{64}$/),stage:z.enum(['等待回货与装箱','本期装箱完成','特殊结案']),lines:z.array(closureLine),outstanding:strings,canClose:z.boolean(),canOpenReceiving:z.boolean(),canOpenRework:z.boolean(),canOpenWages:z.boolean(),closed:z.object({reason:text,outstanding:strings,closedBy:text,closedAt:text}).passthrough().nullable(),shipmentStatus:text,customerReceiptStatus:text}).passthrough();
