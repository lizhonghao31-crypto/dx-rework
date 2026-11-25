import type {PoolClient} from 'pg';

type ProblemLocator={orderId:string;preparationId:string;stepRef:string;returnFactId:string;lineId:string;checkId:string};
type CountedCraftCheck={inspectedQuantity:number;qualifiedQuantity:number;problemQuantity:number;unit:'片'};
type OriginalCheck={check_id:string;result:string;quantity_scope:unknown;returned_payload:unknown};

/** Legacy 「需处理」 never implies a quantity, even if the whole PO or
 * original return size is known. Quality and warehouse share actual pieces. */
export function countedCraftCheck(input:unknown,actualReturned:number):CountedCraftCheck|null{
 if(!input||typeof input!=='object'||!Number.isSafeInteger(actualReturned)||actualReturned<=0)return null;
 const {inspectedQuantity,qualifiedQuantity,problemQuantity,unit}=input as Partial<CountedCraftCheck>;
 if(unit!=='片'||typeof inspectedQuantity!=='number'||typeof qualifiedQuantity!=='number'||typeof problemQuantity!=='number'||
  ![inspectedQuantity,qualifiedQuantity,problemQuantity].every(Number.isSafeInteger)||inspectedQuantity<=0||
  inspectedQuantity>actualReturned||qualifiedQuantity<0||problemQuantity<0||qualifiedQuantity+problemQuantity!==inspectedQuantity)return null;
 return {inspectedQuantity,qualifiedQuantity,problemQuantity,unit};
}

export function qualifyCurrentCraftProblem(raw:OriginalCheck,locator:ProblemLocator){
 if(raw.check_id!==locator.checkId||raw.result!=='需处理'||!raw.returned_payload||typeof raw.returned_payload!=='object')return null;
 const returned=raw.returned_payload as {stepRef?:string;sendFactId?:string;lines?:readonly {lineId:string;quantity:number}[];warehouseMotion?:{factoryId?:string}};
 if(returned.stepRef!==locator.stepRef||!returned.sendFactId||!returned.warehouseMotion?.factoryId||!Array.isArray(returned.lines))return null;
 const quantities=returned.lines.filter(row=>row.lineId===locator.lineId);
 const count=quantities.length===1?countedCraftCheck(raw.quantity_scope,quantities[0]!.quantity):null;
 if(!count?.problemQuantity)return null;
 return {...locator,problemScopeId:locator.checkId,sourceSendFactId:returned.sendFactId,factoryId:returned.warehouseMotion.factoryId,
  ...count,actualReturned:quantities[0]!.quantity};
}

/** No broad authorization shortcut here. The original QC/rework command
 * supplies an already authorized order and uses its original lifecycle lock.
 * Only the latest native check for this exact return/PO can occupy pieces. */
export async function readCurrentCraftProblem(db:Pick<PoolClient,'query'>,locator:ProblemLocator){
 const {rows}=await db.query<OriginalCheck>(`SELECT q.check_id,q.result,to_jsonb(q)->'quantity_scope' AS quantity_scope,f.payload AS returned_payload
  FROM digital_factory_routes route JOIN digital_factory_facts f USING(preparation_id)
  JOIN digital_factory_facts outgoing ON outgoing.preparation_id=f.preparation_id AND outgoing.fact_id::text=f.payload->>'sendFactId'
   AND outgoing.kind='工艺发出' AND outgoing.payload->>'stepRef'=f.payload->>'stepRef'
   AND outgoing.payload#>>'{warehouseMotion,factoryId}'=f.payload#>>'{warehouseMotion,factoryId}'
  JOIN LATERAL (SELECT check_row.* FROM digital_factory_qc check_row
   WHERE check_row.preparation_id=route.preparation_id AND check_row.return_fact_id=f.fact_id AND check_row.line_id=$5
   ORDER BY check_row.sequence DESC LIMIT 1) q ON q.check_id=$6
  WHERE route.production_order_id=$1 AND route.preparation_id=$2 AND f.payload->>'stepRef'=$3
   AND f.fact_id=$4 AND f.kind='工艺回仓'`,
 [locator.orderId,locator.preparationId,locator.stepRef,locator.returnFactId,locator.lineId,locator.checkId]);
 return rows.length===1?qualifyCurrentCraftProblem(rows[0]!,locator):null;
}
