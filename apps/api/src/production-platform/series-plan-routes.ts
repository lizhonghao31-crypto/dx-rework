import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {businessActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {DigitalIdentityDependencies} from './identity-routes.js';
import type {SeriesPlanService} from './series-plan-service.js';
import type {ShortLeadService} from './short-lead-service.js';
export function registerSeriesPlanRoutes(app:FastifyInstance,deps:DigitalIdentityDependencies,plans:SeriesPlanService,short:ShortLeadService){
 const actor=async(request:FastifyRequest)=>{const token=request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('dx_rework_session='))?.slice(18);return businessActor(deps.root,await deps.authenticate(token),request.id,'digital_production:view');};
 const id=(request:FastifyRequest,key='id')=>{const p=z.uuid().safeParse((request.params as Record<string,string>)[key]);if(!p.success)throw new ApplicationError('VALIDATION_ERROR','资料编号无效',400);return p.data;};
 const key=(request:FastifyRequest)=>{if(!deps.creationEnabled)throw new ApplicationError('DIGITAL_WRITE_DISABLED','当前配置暂未开放资料修改',503);return typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:'';};
 const base='/digital-production/orders/:id/series-plan';
 app.get('/digital-production/series-candidate',async r=>{const q=z.object({customerCode:z.string().max(100),salesYear:z.coerce.number().int(),salesSeries:z.string(),requiresColorMatching:z.enum(['true','false','']).transform(v=>v===''?null:v==='true')}).strict().safeParse(r.query);if(!q.success)throw new ApplicationError('VALIDATION_ERROR','请核对销售年份和系列',400);return plans.creationPreview(await actor(r),q.data);});
 app.get(base,async r=>plans.read(await actor(r),id(r)));
 app.post(`${base}/preview`,async r=>plans.preview(await actor(r),id(r),r.body));
 app.put(`${base}/context`,async r=>plans.context(await actor(r),id(r),r.body,key(r)));
 app.post(`${base}/requests`,async r=>plans.request(await actor(r),id(r),r.body,key(r)));
 app.post(`${base}/apply`,async r=>plans.apply(await actor(r),id(r),r.body,key(r)));
 app.post(`${base}/requests/:requestId/reject`,async r=>plans.reject(await actor(r),id(r),id(r,'requestId'),r.body,key(r)));
 app.get('/digital-production/series-profiles',async r=>plans.profiles(await actor(r)));
 app.put('/digital-production/series-profiles',async r=>plans.saveProfile(await actor(r),r.body,key(r)));
 app.get('/digital-production/short-lead-requests',async r=>short.read(await actor(r)));
 app.post('/digital-production/short-lead-requests',async r=>short.request(await actor(r),null,r.body,key(r)));
 app.post('/digital-production/short-lead-requests/:requestId/decision',async r=>short.decide(await actor(r),null,id(r,'requestId'),r.body,key(r)));
 const source='/digital-production/sources/:id/short-lead-requests';
 app.get(source,async r=>short.read(await actor(r),id(r)));
 app.post(source,async r=>short.request(await actor(r),id(r),r.body,key(r)));
 app.post(`${source}/:requestId/decision`,async r=>short.decide(await actor(r),id(r),id(r,'requestId'),r.body,key(r)));
}
