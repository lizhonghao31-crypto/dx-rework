import {businessAnchorFixture} from "./business-anchor-fixture.js";
import {seedOwnTailHistory} from "../integration/own-tail-responsibility-history.cases.js";

/** Existing explicitly synthetic historical wage fixture, current native schema/permissions. */
export async function wagePageFixture(url:string){
 const f=await businessAnchorFixture(url),client=await f.db.connect();let released=false;
 try{
  const sources=[];
  for(let i=0;i<11;i++)sources.push(await seedOwnTailHistory(client));
  const periodId=(await client.query("SELECT period_id FROM rework_wage_items WHERE wage_item_id=$1",[sources[0]!.wageIds[0]])).rows[0].period_id as string;
  await client.query("BEGIN");
  try{
   // Initial metadata for this new owned synthetic READ dataset, not a payroll write.
   await client.query("ALTER TABLE rework_wage_periods DISABLE TRIGGER USER");
   await client.query(`UPDATE rework_wage_periods p SET source_item_count=s.count,person_count=s.people,original_total=s.total,final_total=s.total+p.adjustment_total
    FROM (SELECT count(*)::int count,count(DISTINCT person_id)::int people,sum(payable_amount) total FROM rework_wage_items WHERE period_id=$1 AND invalidated_at IS NULL) s WHERE p.period_id=$1`,[periodId]);
   await client.query("ALTER TABLE rework_wage_periods ENABLE TRIGGER USER");await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}
  return {...f,periodId,sources,reader:{...f.root,authorizationCapability:"wage:view",authorizationCapabilities:["wage:view","wage:export"]}};
 }catch(error){client.release();released=true;await f.dispose();throw error;}finally{if(!released)client.release();}
}
