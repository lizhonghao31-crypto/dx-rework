import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {z} from 'zod';
import {DeliveryCalendarFiltersSchema,DeliveryYearQuerySchema,DeliveryMonthQuerySchema,DeliveryDayQuerySchema,DeliveryMissingQuerySchema} from '@dx-rework/contracts/delivery-calendar';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {DeliveryCalendarQuery} from './delivery-calendar-query.js';
export function registerDeliveryCalendarRoutes(app:FastifyInstance,dependencies:DigitalIdentityDependencies,service:DeliveryCalendarQuery){
 const actor=async(request:FastifyRequest)=>{const token=request.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('dx_rework_session='))?.slice(18);return businessActor(dependencies.root,await dependencies.authenticate(token),request.id,'digital_production:tasks');};
 const parse=<T>(schema:z.ZodType<T>,input:unknown):T=>{const result=schema.safeParse(input);if(!result.success)throw new ApplicationError('VALIDATION_ERROR','请核对交付年月日、筛选和页码',400);return result.data;};
 const filters=(query:ReturnType<typeof DeliveryYearQuerySchema.parse>|ReturnType<typeof DeliveryMonthQuerySchema.parse>|ReturnType<typeof DeliveryDayQuerySchema.parse>|ReturnType<typeof DeliveryMissingQuerySchema.parse>)=>DeliveryCalendarFiltersSchema.parse({search:query.search,...query.customer?{customer:query.customer}:{},...query.status?{status:query.status}:{},scope:query.scope});
 app.get('/digital-production/delivery-calendar/year',async request=>{const current=await actor(request),query=parse(DeliveryYearQuerySchema,request.query);return service.year(current,filters(query),query.year,query.snapshotId);});
 app.get('/digital-production/delivery-calendar/month',async request=>{const current=await actor(request),query=parse(DeliveryMonthQuerySchema,request.query);return service.month(current,filters(query),query.month,query.snapshotId,query.selectedDate,query.page,query.pageSize);});
 app.get('/digital-production/delivery-calendar/day',async request=>{const current=await actor(request),query=parse(DeliveryDayQuerySchema,request.query);return service.day(current,filters(query),query.date,query.page,query.pageSize,query.snapshotId,query.group);});
 app.get('/digital-production/delivery-calendar/missing',async request=>{const current=await actor(request),query=parse(DeliveryMissingQuerySchema,request.query);return service.missing(current,filters(query),{...query.year?{year:query.year}:{},...query.month?{month:query.month}:{}},query.page,query.pageSize,query.snapshotId,query.kind);});
}
