import {createHash} from 'node:crypto';
import type {PoolClient,QueryResult} from 'pg';
import {journeyCacheHit} from '../platform/journey-diagnostic.js';
import {JOURNEY_ORDER_BATCH_TEMPLATES} from './journey-batch-templates.js';

const BATCH_SIZE=32,MAX_BYTES=4*1024*1024,MAX_GROUPS=128;
const INDEX='__dx_journey_batch_index',ROW='__dx_journey_row_index';
type Batch={promise:Promise<{result:QueryResult;rows:Map<string,QueryResult['rows']>;unsupported?:boolean}>;bytes:number};
const plain=(value:unknown):boolean=>value===null||typeof value!=='object'||value instanceof Date||Array.isArray(value)&&value.every(plain)||Object.getPrototypeOf(value)===Object.prototype&&Object.values(value).every(plain);
/** Created only by Journey's existing single-actor readonly snapshot proxy. */
export function journeySnapshotBatches(client:PoolClient){
 let ids:readonly string[]=[],generation=0,retained=0;
 const groups=new Map<string,Batch>(),oversized=new Set<string>();
 const remove=(key:string)=>{retained-=groups.get(key)?.bytes??0;groups.delete(key);};
 const clear=()=>{groups.clear();oversized.clear();ids=[];retained=0;generation++;};
 return {
  scope(orderIds:readonly string[]){clear();ids=[...new Set(orderIds)];},clear,
  read(text:string,values:unknown[]):Promise<QueryResult>|null{
   if(values.length!==1||typeof values[0]!=='string'||!ids.includes(values[0]))return null;
   const hash=createHash('sha256').update(text).digest('hex'),type=JOURNEY_ORDER_BATCH_TEMPLATES.get(hash);if(!type||oversized.has(hash))return null;
   const index=ids.indexOf(values[0]),start=Math.floor(index/BATCH_SIZE)*BATCH_SIZE,batchIds=ids.slice(start,start+BATCH_SIZE),key=hash+':'+start;
   let entry=groups.get(key);
   if(entry){journeyCacheHit();groups.delete(key);groups.set(key,entry);}
   else{
    const begun=generation,statement=text.trim().replace(/;\s*$/,''),original=statement.replace(/\$1\b/g,'requested.id');
    const sql=`SELECT requested.ordinal AS "${INDEX}",facts.* FROM unnest($1::${type}[]) WITH ORDINALITY AS requested(id,ordinal) CROSS JOIN LATERAL (SELECT original.*,row_number() OVER () AS "${ROW}" FROM (${original}) AS original) AS facts ORDER BY requested.ordinal,facts."${ROW}"`;
    const current:Batch={bytes:0,promise:Promise.resolve(null as never)};entry=current;
    // Queue immediately, as the original client does. Deferring this call could
    // move it behind a later session-context statement on the same connection.
    let requested:Promise<QueryResult>;try{requested=client.query(sql,[batchIds]);}catch(error){clear();throw error;}
    current.promise=requested.then(result=>{
     const rows=new Map<string,QueryResult['rows']>(batchIds.map(id=>[id,[]]));
     const fields=result.fields.filter(field=>field.name!==INDEX&&field.name!==ROW),value={result:{command:result.command,rowCount:0,oid:result.oid,fields,rows:[]} as QueryResult,rows};
     if(!plain(result.rows)||result.fields.filter(field=>field.name===INDEX).length!==1||result.fields.filter(field=>field.name===ROW).length!==1){if(groups.get(key)===current)remove(key);oversized.add(hash);return {...value,unsupported:true};}
     for(const raw of result.rows){const ordinal=Number(raw[INDEX]);if(!Number.isInteger(ordinal)||ordinal<1||ordinal>batchIds.length)throw Error('Invalid original Journey batch row scope');const row={...raw};delete row[INDEX];delete row[ROW];rows.get(batchIds[ordinal-1]!)!.push(row);}
     let bytes:number;try{bytes=Buffer.byteLength(JSON.stringify([...rows]))+Buffer.byteLength(JSON.stringify(fields));}catch{if(groups.get(key)===current)remove(key);oversized.add(hash);return {...value,unsupported:true};}
     if(begun===generation&&groups.get(key)===current){if(bytes>MAX_BYTES){remove(key);oversized.add(hash);}else{current.bytes=bytes;retained+=bytes;while(retained>MAX_BYTES)remove(groups.keys().next().value!);}}
     return value;
    },error=>{clear();throw error;});
    while(groups.size>=MAX_GROUPS)remove(groups.keys().next().value!);groups.set(key,current);
   }
   const id=values[0];return entry.promise.then(value=>{if(value.unsupported)return client.query(text,[id]);const rows=structuredClone(value.rows.get(id)!);return {...value.result,rowCount:rows.length,rows};});
  }
 };
}
