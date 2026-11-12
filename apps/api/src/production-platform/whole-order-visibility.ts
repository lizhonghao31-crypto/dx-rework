import type {Pool,PoolClient} from 'pg';
import {ApplicationError} from '../platform/errors.js';

type DB=Pick<Pool|PoolClient,'query'>;
/** Schema capability only. No actor result, object state or authorization is cached. */
const installed=new WeakSet<DB>();
export async function wholeOrderDeletionAvailable(db:DB){
 if(installed.has(db))return true;
 const exists=Boolean((await db.query("SELECT to_regclass('digital_whole_order_deleted_objects') AS relation")).rows[0]?.relation);
 if(exists)installed.add(db);return exists;
}
/** kind and expression are server-owned SQL constants, never request input. */
export async function wholeOrderActiveSql(db:DB,kind:string,expression:string){
 if(!/^[a-z_]+$/.test(kind))throw Error('Invalid internal deletion kind');
 return await wholeOrderDeletionAvailable(db)?`NOT EXISTS(SELECT 1 FROM digital_whole_order_deleted_objects whole_deleted WHERE whole_deleted.object_kind='${kind}' AND whole_deleted.object_id=${expression})`:'true';
}
export async function assertWholeOrderActive(db:DB,kind:string,id:string){
 if(!await wholeOrderDeletionAvailable(db))return;
 if((await db.query('SELECT 1 FROM digital_whole_order_deleted_objects WHERE object_kind=$1 AND object_id=$2',[kind,id])).rowCount)
  throw new ApplicationError('ORDER_DELETED','订单已删除，不能继续查看或办理',410);
}
