import {readFile} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';

/** Current identity commands in focused/historical fixtures need these exact
 * relationship tables. This does not replay0285 or change historical clocks,
 * retirement rules, dirty triggers or the fixture's migration ledger.
 */
export async function applyOrderMerchandiserFixture(db:Pick<Pool|PoolClient,'query'>,sourcing=false){
 const sql=await readFile(new URL('../../apps/api/migrations/0285_order_time_settings_and_merchandisers.sql',import.meta.url),'utf8');
 for(const pattern of [/ALTER TABLE digital_production_customers ADD COLUMN[^;]+;/,/CREATE TABLE digital_customer_secondary_merchandisers[\s\S]*?\n\);/,/CREATE TABLE digital_order_secondary_merchandisers[\s\S]*?\n\);/]){
  const statement=sql.match(pattern)?.[0];if(!statement)throw Error('Current customer relationship fixture DDL is missing');await db.query(statement);
 }
 if(sourcing)for(const pattern of [/CREATE TABLE sourcing_case_secondary_merchandisers[\s\S]*?\n\);/,/CREATE FUNCTION sourcing_additional_merchandiser_ids[\s\S]*?\$\$;/]){
  const statement=sql.match(pattern)?.[0];if(!statement)throw Error('Current sourcing relationship fixture DDL is missing');await db.query(statement);
 }
}
