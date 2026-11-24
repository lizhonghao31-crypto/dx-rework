import type {Pool,PoolClient} from 'pg';

type Queryable=Pick<Pool|PoolClient,'query'>;
type SupplierRow={supplier_id:string;supplier_code:string;supplier_name:string};
const option=(row:SupplierRow)=>({supplierId:row.supplier_id,code:row.supplier_code,name:row.supplier_name});
const eligibleFactory=`SELECT supplier_id,supplier_code,supplier_name
 FROM current_supplier_catalog WHERE supplier_type='factory' AND active=true`;

/** Call only after authorizing access to the exact assigned craft. */
export async function readSecondaryCraftSupplierOptions(db:Queryable,search:string){
 const {rows}=await db.query<SupplierRow>(eligibleFactory+` AND
  ($1='' OR strpos(lower(supplier_code||' '||supplier_name),lower($1))>0)
  ORDER BY supplier_name,supplier_code,supplier_id LIMIT 20`,[search.trim()]);
 return rows.map(option);
}

/** Serialize an exact factory eligibility check with catalog revisions. */
export async function lockSecondaryCraftSupplier(db:PoolClient,id:string){
 const item=await db.query(`SELECT 1 FROM supplier_catalog_items
  WHERE supplier_id=$1 AND supplier_type='factory' FOR SHARE`,[id]);
 if(!item.rowCount)return null;
 const {rows:[row]}=await db.query<SupplierRow>(eligibleFactory+' AND supplier_id=$1',[id]);
 return row?option(row):null;
}
