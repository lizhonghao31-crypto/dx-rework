import {isDevelopmentMaterialPlaceholder,type DevelopmentDocument,type DevelopmentMaterialSupplierOption} from '@dx-rework/contracts/digital-development';
import type {Pool,PoolClient} from 'pg';
import {ApplicationError} from '../platform/errors.js';

type Queryable=Pick<Pool|PoolClient,'query'>;
type SupplierRow={supplier_id:string;supplier_code:string;supplier_name:string;version:number};
const eligibleMaterials=`SELECT supplier_id,supplier_code,supplier_name,version
 FROM current_supplier_catalog WHERE supplier_type='fabric' AND active=true`;
const option=(row:SupplierRow):DevelopmentMaterialSupplierOption=>({supplierId:row.supplier_id,code:row.supplier_code,name:row.supplier_name,version:row.version});

/** The caller must authenticate at the original designer creation scope. */
export async function readDevelopmentMaterialSuppliers(db:Queryable,search:string){
 const {rows}=await db.query<SupplierRow>(eligibleMaterials+` AND
  ($1='' OR strpos(lower(supplier_code||' '||supplier_name),lower($1))>0)
  ORDER BY supplier_name,supplier_code,supplier_id LIMIT 20`,[search.trim()]);
 return rows.map(option);
}

const missing=(name:string):never=>{throw new ApplicationError('VALIDATION_ERROR',`${name}请选择有效的面辅料供应商`,400);};
const stale=(name:string):never=>{throw new ApplicationError('DEVELOPMENT_CONFLICT',`${name}的面辅料供应商已更新、停用或不符合本页类别，请重新搜索选择，原资料未修改`,409);};

/** Check only new selections, without rewriting unchanged historical names/versions. */
export async function validateDevelopmentMaterialSuppliers(db:PoolClient,document:DevelopmentDocument,basis?:DevelopmentDocument,options:{catalog:boolean;publish?:boolean}={catalog:false}){
 const previous=new Map(basis?.materials.map(row=>[row.materialId,row]));
 const selections=document.materials.filter(row=>{
  const saved=previous.get(row.materialId),reference=row.supplierReference;
  if(reference)return !(saved?.supplierReference?.supplierId===reference.supplierId&&saved.supplierReference.version===reference.version&&saved.supplier===row.supplier);
  if(!options.catalog||isDevelopmentMaterialPlaceholder(row))return false;
  if(row.supplier.trim()&&saved?.supplier===row.supplier&&!saved.supplierReference)return false;
  if(row.supplier.trim()||saved?.supplierReference||options.publish)missing(row.label||row.name||row.category);
  return false;
 });
 if(!selections.length)return;
 const ids=[...new Set(selections.map(row=>row.supplierReference!.supplierId))].sort();
 // The catalog writes take an exclusive lock on the same stable item row.
 await db.query(`SELECT supplier_id FROM supplier_catalog_items
  WHERE supplier_type='fabric' AND supplier_id=ANY($1::uuid[]) ORDER BY supplier_id FOR SHARE`,[ids]);
 const {rows}=await db.query<SupplierRow>(eligibleMaterials+' AND supplier_id=ANY($1::uuid[])',[ids]);
 const active=new Map(rows.map(row=>[row.supplier_id,row]));
 for(const row of selections){
  const reference=row.supplierReference!,current=active.get(reference.supplierId);
  if(!current||current.version!==reference.version||current.supplier_name!==row.supplier)
   stale(row.label||row.name||row.category);
 }
}
