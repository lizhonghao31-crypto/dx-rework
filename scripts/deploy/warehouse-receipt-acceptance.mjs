import {createRequire} from 'node:module';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [root,action,sha,operator]=process.argv.slice(2);
if(!['status','activate','safe-read'].includes(action)||!/^[a-f0-9]{40}$/.test(sha??'')||
 root!=='/opt/dx-rework-acceptance/current'||realpathSync(root)!=='/opt/dx-rework-acceptance/releases/'+sha)
 throw Error('Warehouse receipt candidate identity mismatch');
const packed=readFileSync(0,'utf8');
if(Buffer.byteLength(packed)>262144)throw Error('Warehouse receipt approval file is too large');
const input=JSON.parse(packed);
const connection=new URL(process.env.DATABASE_URL);
if(!['postgres:','postgresql:'].includes(connection.protocol)||!['127.0.0.1','localhost','[::1]'].includes(connection.hostname)||
 connection.pathname!=='/dx_rework_acceptance'||connection.username!=='dx_rework_acceptance_app')
 throw Error('Warehouse receipt action is Acceptance-only');
const {Pool}=createRequire(resolve(root,'apps/api/package.json'))('pg');
const pool=new Pool({connectionString:connection.toString(),max:1,connectionTimeoutMillis:8000});
try{
 const {rows:[identity]}=await pool.query(`SELECT current_database() AS database,current_user AS role,
  session_user AS session_role,inet_server_addr()::text AS address,to_regclass('public.digital_warehouse_receipt_cutovers') IS NOT NULL AS ready`);
 if(identity.database!=='dx_rework_acceptance'||identity.role!=='dx_rework_acceptance_app'||
  identity.session_role!==identity.role||!['127.0.0.1/32','::1/128','127.0.0.1','::1'].includes(identity.address)||!identity.ready)
  throw Error('Warehouse receipt database identity/schema mismatch');
 const {warehouseReceiptCutover}=await import(pathToFileURL(resolve(root,'apps/api/dist/production-platform/warehouse-receipt-cutover-service.js')).href);
 console.log(JSON.stringify(await warehouseReceiptCutover(pool,action,sha,operator,input),null,2));
}finally{await pool.end();}
