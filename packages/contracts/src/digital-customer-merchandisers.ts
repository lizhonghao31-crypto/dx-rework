import {z} from 'zod';
export const CustomerMerchandiserQuerySchema=z.object({q:z.string().trim().max(200).default(''),page:z.coerce.number().int().min(1).max(100000).default(1)}).strict();
export const CustomerMerchandiserSelectionSchema=z.object({codes:z.array(z.string().trim().min(1).max(100)).min(1).max(1000)}).strict();
export const CustomerMerchandisersSaveSchema=z.object({
 customers:z.array(z.object({code:z.string().trim().min(1).max(100),expectedVersion:z.number().int().nonnegative()}).strict()).min(1).max(1000),
 primaryMerchandiserId:z.uuid(),secondaryMerchandiserIds:z.array(z.uuid()).max(200),mode:z.enum(['append','replace']),
}).strict().superRefine((v,c)=>{
 if(new Set(v.customers.map(row=>row.code)).size!==v.customers.length)c.addIssue({code:'custom',path:['customers'],message:'客户不能重复选择'});
 if(new Set(v.secondaryMerchandiserIds).size!==v.secondaryMerchandiserIds.length||v.secondaryMerchandiserIds.includes(v.primaryMerchandiserId))c.addIssue({code:'custom',path:['secondaryMerchandiserIds'],message:'主副跟单不能重复，副跟单也不能重复'});
});
export type CustomerMerchandisersSave=z.infer<typeof CustomerMerchandisersSaveSchema>;
export type CustomerMerchandiserDefault={code:string;name:string;version:number;primary:{id:string;name:string|null}|null;secondary:Array<{id:string;name:string|null}>};
export type CustomerMerchandisersPage={items:CustomerMerchandiserDefault[];page:number;pageSize:15;totalCount:number};
