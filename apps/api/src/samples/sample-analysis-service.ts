import type { Pool } from 'pg';
import { SampleAnalysisQuerySchema, SampleAnalysisResponseSchema, type SampleAnalysisQuery } from '@dx-rework/contracts';
import type { TrustedActorContext } from '../tools/repositories.js';
import { isRootActor } from '../access/business-authority.js';
import { requireSampleCapability } from './sample-authority.js';

export function sampleAnalysisFilter(q:SampleAnalysisQuery) {
 const values:unknown[]=[],conditions:string[]=[];
 const bind=(v:unknown)=>{values.push(v);return '$'+values.length;};
 for(const [key,column,operator,cast] of [
  ['purchaseFrom','s.purchase_date','>=','date'],['purchaseTo','s.purchase_date','<=','date'],
  ['purchaserUserId','s.purchaser_user_id','=','uuid'],['holderUserId','s.holder_user_id','=','uuid'],
  ['brandId','ba.dimension_id','=','uuid'],['departmentId','da.dimension_id','=','uuid'],
  ['brand','s.brand','=','text'],['department','s.department','=','text'],['category','s.category','=','text'],
  ['minPrice','f.purchase_price','>=','numeric'],['maxPrice','f.purchase_price','<=','numeric'],['status','s.status','=','text'],
 ] as const){const v=q[key];if(v!==undefined)conditions.push(`${column}${operator}${bind(v)}::${cast}`);}
 return {where:conditions.length?conditions.join(' AND '):'TRUE',values};
}
const held="holder_user_id IS NOT NULL AND status IN ('borrowed','return_pending','disposal_pending','loss_payment_pending')";
const money=(expression:string)=>`COALESCE(${expression},0)::numeric(24,2)::text`;
const dimensions=`LEFT JOIN LATERAL (SELECT a.dimension_id,a.version,d.display_name FROM sample_analysis_aliases a
 JOIN sample_analysis_dimensions d ON d.dimension_id=a.dimension_id WHERE a.kind='brand' AND a.raw_name=s.brand ORDER BY a.version DESC LIMIT 1) ba ON true
 LEFT JOIN LATERAL (SELECT a.dimension_id,a.version,d.display_name FROM sample_analysis_aliases a
 JOIN sample_analysis_dimensions d ON d.dimension_id=a.dimension_id WHERE a.kind='department' AND a.raw_name=s.department ORDER BY a.version DESC LIMIT 1) da ON true
 LEFT JOIN LATERAL (SELECT classification FROM sample_analysis_classifications c WHERE c.sample_id=s.sample_id AND s.status='archived' ORDER BY version DESC LIMIT 1) cl ON true`;
export class SampleAnalysisService {
 constructor(private readonly database:Pool){}
 async read(actor:TrustedActorContext,input:unknown){
  // Applies before parsing price filters or obtaining a database connection, for every response branch.
  requireSampleCapability(actor,'sample:view_finance');
  const q=SampleAnalysisQuerySchema.parse(input),filter=sampleAnalysisFilter(q),client=await this.database.connect();
  const base=`WITH matched AS MATERIALIZED (SELECT s.*,f.purchase_price,
   ba.dimension_id AS brand_id,ba.version AS brand_version,COALESCE(ba.display_name,s.brand) AS brand_name,
   da.dimension_id AS department_id,da.version AS department_version,COALESCE(da.display_name,s.department) AS department_name,cl.classification
   FROM sample_items s JOIN sample_financial_facts f ON f.sample_id=s.sample_id ${dimensions} WHERE ${filter.where}),
   b AS MATERIALIZED (SELECT * FROM matched WHERE classification IS DISTINCT FROM 'test_invalid' AND (status<>'archived' OR classification='formal_history'))`;
  const query=(sql:string,extra:unknown[]=[])=>client.query(base+' '+sql,[...filter.values,...extra]);
  // Event periods apply to event facts, never to purchase dates or a historical-inventory reconstruction.
  const eventValues:unknown[]=[],eventBind=(v:unknown)=>{eventValues.push(v);return '$'+(filter.values.length+eventValues.length);};
  const from=q.eventFrom?eventBind(q.eventFrom):null,to=q.eventTo?eventBind(q.eventTo):null;
  const period=(column:string)=>[column+' IS NOT NULL',...(from?[`${column}>=(${from}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`]:[]),...(to?[`${column}<((${to}::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')`]:[])].join(' AND ');
  try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const clock=await client.query('SELECT CURRENT_TIMESTAMP::text AS "asOf"');
   const coverage=await query(`SELECT count(*) FILTER(WHERE status='archived' AND classification IS NULL)::int AS "unclassifiedArchivedCount",
    count(*) FILTER(WHERE classification='test_invalid')::int AS "excludedTestCount",
    count(*) FILTER(WHERE status='archived' AND classification='formal_history')::int AS "formalArchivedCount",
    count(*) FILTER(WHERE brand_id IS NULL AND (status<>'archived' OR classification='formal_history') AND classification IS DISTINCT FROM 'test_invalid')::int AS "unmappedBrandCount",
    count(*) FILTER(WHERE department_id IS NULL AND (status<>'archived' OR classification='formal_history') AND classification IS DISTINCT FROM 'test_invalid')::int AS "unmappedDepartmentCount",
    count(*) FILTER(WHERE category='' AND (status<>'archived' OR classification='formal_history') AND classification IS DISTINCT FROM 'test_invalid')::int AS "missingCategoryCount" FROM matched`);
   const summary=await query(`SELECT count(*)::int AS "purchaseCount",${money('sum(purchase_price)')} AS "purchaseAmount",
    count(DISTINCT purchaser_user_id)::int AS "purchaserCount",${money('avg(purchase_price)')} AS "averagePrice",
    ${money("sum(purchase_price) FILTER(WHERE status<>'archived')")} AS "legacyScopeAmount",
    count(*) FILTER(WHERE ${held})::int AS "heldCount",${money(`sum(purchase_price) FILTER(WHERE ${held})`)} AS "heldAmount",
    count(*) FILTER(WHERE ${held} AND borrowed_at<CURRENT_TIMESTAMP-interval '90 days')::int AS "heldOver90Days" FROM b`);
   const review=await query(`SELECT count(*)::int AS count,${money('sum(purchase_price)')} AS amount FROM matched WHERE status='archived' AND classification IS NULL`);
   const custody=await query(`SELECT count(*) FILTER(WHERE c.initial_custody AND ${period('c.borrowed_at')})::int AS "initialCustodyCount",
    count(*) FILTER(WHERE NOT c.initial_custody AND ${period('c.borrowed_at')})::int AS "borrowCount",
    count(*) FILTER(WHERE ${period('c.returned_at')})::int AS "returnCount"
    FROM sample_custody_records c JOIN b ON b.sample_id=c.sample_id`,eventValues);
   const disposal=await query(`SELECT d.disposal_type AS type,count(*) FILTER(WHERE ${period('d.approved_at')})::int AS count,
    ${money(`sum(b.purchase_price) FILTER(WHERE ${period('d.approved_at')})`)} AS "originalValue",
    ${money(`sum(d.final_amount) FILTER(WHERE (d.disposal_type='sale' AND ${period('d.approved_at')}) OR (d.disposal_type='loss' AND ${period('d.paid_at')}))`)} AS "confirmedAmount"
    FROM sample_disposals d JOIN b ON b.sample_id=d.sample_id WHERE d.approved_at IS NOT NULL GROUP BY d.disposal_type ORDER BY d.disposal_type`,eventValues);
   const trend=await query(`SELECT to_char(purchase_date,'YYYY-MM') AS month,count(*)::int AS count,${money('sum(purchase_price)')} AS amount FROM b GROUP BY 1 ORDER BY 1`);
   const groupExpressions={
    purchaser:{key:'purchaser_user_id::text',person:'purchaser_user_id::text',name:'purchaser_name',dim:'NULL::text',dimName:'NULL::text'},
    holder:{key:'holder_user_id::text',person:'holder_user_id::text',name:'holder_name',dim:'NULL::text',dimName:'NULL::text'},
    brand:{key:"COALESCE(brand_id::text,'raw:'||brand)",person:'NULL::text',name:'NULL::text',dim:"COALESCE(brand_id::text,'raw:'||brand)",dimName:'brand_name'},
    department:{key:"COALESCE(department_id::text,'raw:'||department)",person:'NULL::text',name:'NULL::text',dim:"COALESCE(department_id::text,'raw:'||department)",dimName:'department_name'},
    category:{key:'category',person:'NULL::text',name:'NULL::text',dim:'category',dimName:"COALESCE(NULLIF(category,''),'未记录类别')"},
    purchaser_brand:{key:"purchaser_user_id::text||':'||COALESCE(brand_id::text,'raw:'||brand)",person:'purchaser_user_id::text',name:'purchaser_name',dim:"COALESCE(brand_id::text,'raw:'||brand)",dimName:'brand_name'},
   } as const;
   const g=groupExpressions[q.group],groupWhere=q.group==='holder'?`WHERE ${held}`:'';
   const groupSql=`SELECT ${g.key} AS key,${g.person} AS person_id,max(${g.name}) AS person_name,${g.dim} AS dimension_id,max(${g.dimName}) AS dimension_name,count(*)::int AS count,sum(purchase_price) AS amount FROM b ${groupWhere} GROUP BY ${g.key},${g.person},${g.dim}`;
   const groupTotal=await query(`SELECT count(*)::int AS total FROM (${groupSql}) groups`);
   const groups=await query(`SELECT key,CASE WHEN person_id IS NULL THEN NULL ELSE jsonb_build_object('id',person_id,'name',person_name) END AS person,
    CASE WHEN dimension_id IS NULL THEN NULL ELSE jsonb_build_object('id',dimension_id,'name',dimension_name) END AS dimension,
    count,amount::numeric(24,2)::text FROM (${groupSql}) groups ORDER BY amount DESC,key LIMIT 15 OFFSET $${filter.values.length+1}`,[(q.groupPage-1)*15]);
   const items=await query(`SELECT sample_id AS "sampleId",sample_code AS "sampleCode",style_name AS "styleName",style_no AS "styleNo",status,
    to_char(purchase_date,'YYYY-MM-DD') AS "purchaseDate",jsonb_build_object('id',purchaser_user_id,'name',purchaser_name) AS purchaser,
    CASE WHEN holder_user_id IS NULL THEN NULL ELSE jsonb_build_object('id',holder_user_id,'name',holder_name) END AS holder,
    brand,brand_id AS "brandId",brand_name AS "brandName",brand_version AS "brandVersion",
    department,department_id AS "departmentId",department_name AS "departmentName",department_version AS "departmentVersion",category,
    purchase_price::text AS "purchasePrice",borrowed_at::text AS "borrowedAt",
    CASE WHEN ${held} THEN GREATEST(0,floor(extract(epoch FROM CURRENT_TIMESTAMP-borrowed_at)/86400))::int ELSE NULL END AS "heldDays",
    (status<>'archived' OR $${filter.values.length+1}::boolean) AS "canOpenDetail"
    FROM b ORDER BY purchase_date DESC,sample_id LIMIT 15 OFFSET $${filter.values.length+2}`,[isRootActor(actor),(q.page-1)*15]);
   const options=await query(`SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id) FROM (SELECT id,max(name) AS name FROM (SELECT purchaser_user_id::text AS id,purchaser_name AS name FROM b UNION ALL SELECT holder_user_id::text,holder_name FROM b WHERE holder_user_id IS NOT NULL) names GROUP BY id) p),'[]') AS people,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id) FROM (SELECT DISTINCT COALESCE(brand_id::text,'raw:'||brand) AS id,brand_name AS name FROM b) p),'[]') AS brands,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id) FROM (SELECT DISTINCT COALESCE(department_id::text,'raw:'||department) AS id,department_name AS name FROM b) p),'[]') AS departments,
    ARRAY(SELECT DISTINCT category FROM b ORDER BY category) AS categories`);
   const sale=disposal.rows.find(r=>r.type==='sale'),loss=disposal.rows.find(r=>r.type==='loss');
   const result=SampleAnalysisResponseSchema.parse({asOf:clock.rows[0].asOf,filters:q,coverage:coverage.rows[0],
    summary:{...summary.rows[0],...custody.rows[0],saleReceipts:sale?.confirmedAmount??'0.00',confirmedLossCompensation:loss?.confirmedAmount??'0.00',disposalCount:disposal.rows.reduce((sum,r)=>sum+r.count,0)},
    trend:trend.rows,groups:groups.rows,groupTotal:groupTotal.rows[0].total,groupPage:q.groupPage,disposals:disposal.rows,
    items:items.rows,page:q.page,totalCount:summary.rows[0].purchaseCount,options:options.rows[0],archiveReview:review.rows[0]});
   await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
}
