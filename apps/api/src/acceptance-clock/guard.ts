import type {Pool} from 'pg';
import {assertAcceptanceServerDatabase} from '../auth/acceptance-server-guard.js';
const brand=Symbol('verified Acceptance clock runtime');
export type AcceptanceServerProof=Readonly<{corporationId:string;[brand]:true}>;
const verified=new WeakMap<object,AcceptanceServerProof>();
/** Boot-time only: requests cannot manufacture a proof or enable this runtime. */
export async function verifyAcceptanceClockServer(database:Pool,databaseUrl:string,environment:NodeJS.ProcessEnv=process.env):Promise<AcceptanceServerProof>{
 verified.delete(database);
 if(environment.NODE_ENV==='production'||environment.ACCEPTANCE_LAB_ENABLED!=='true')throw new Error('Production or disabled runtime refuses Acceptance clock');
 await assertAcceptanceServerDatabase(databaseUrl,database,environment);
 const proof=Object.freeze({corporationId:environment.DINGTALK_CORP_ID!.trim(),[brand]:true as const});
 verified.set(database,proof);return proof;
}
export function assertAcceptanceServerProof(database:object,proof:AcceptanceServerProof){
 if(verified.get(database)!==proof)throw new Error('Acceptance clock requires the verified server runtime');
}
