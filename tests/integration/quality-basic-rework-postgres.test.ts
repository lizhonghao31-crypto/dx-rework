import { ownedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { canDownloadBasicReworkAttachment, readBasicRework } from "../../apps/api/src/reporting/basic-rework-reader.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)("quality basic rework whitelist",()=>{
 const schema=ownedPostgresSchema("quality_basic"),quality=randomUUID(),other=randomUUID();
 const admin=new pg.Pool({connectionString:url}),db=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const actor=(id=quality,cap=true):TrustedActorContext=>({actorId:id,actorRoles:["quality_control"],requestId:randomUUID(),authorizationCapability:"tools:user",authorizationCapabilities:cap?["rework:basic:view"]:[]});
 const receiving=randomUUID(),activePhoto=randomUUID(),retiredPhoto=randomUUID(),listedOrder=randomUUID(),reworkPhoto=randomUUID();
 beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.query(`CREATE TABLE app_users(id uuid,display_name text);
   CREATE TABLE supplier_catalog_versions(supplier_id uuid,version int,supplier_name text);
   CREATE TABLE rework_orders(rework_order_id uuid,rework_no text,style_no text,order_no text,
    processing_factory_type text,processing_factory_supplier_id uuid,processing_factory_supplier_version int,
    merchandiser_user_id uuid,rework_quantity numeric,rework_reason text,problem_part text,problem_description text,
    status text,updated_at timestamptz,source_receiving_batch_id uuid,secret_wage numeric);
   CREATE TABLE attachments(attachment_id uuid,original_filename text,entity_type text,entity_id text,status text,mime_type text,created_at timestamptz);
   CREATE TABLE receiving_attachment_retirements(attachment_id uuid);
   CREATE TABLE test_grants(id uuid);
   CREATE FUNCTION access_authorized_actor_roles(target uuid,requested text) RETURNS text[] LANGUAGE plpgsql AS $$ BEGIN
    IF requested<>'rework:basic:view' OR NOT EXISTS(SELECT 1 FROM test_grants WHERE id=target) THEN RAISE EXCEPTION 'forbidden'; END IF;
    RETURN ARRAY['quality_control']; END $$;`);
  await db.query("INSERT INTO test_grants VALUES($1)",[quality]);await db.query("INSERT INTO app_users VALUES($1,'跟单张三')",[other]);
  for(let i=0;i<17;i++)await db.query(`INSERT INTO rework_orders VALUES($1,$2,'S1','ORDER1','own_factory',null,null,$3,100,'断线','袖口','开线',$4,CURRENT_TIMESTAMP,$5,9999)`,[i===0?listedOrder:randomUUID(),`RW${i}`,other,i===16?'deleted':'completed',receiving]);
  await db.query("INSERT INTO attachments VALUES($1,'返工图','rework_order',$2,'ready','image/jpeg',CURRENT_TIMESTAMP)",[reworkPhoto,listedOrder]);
  for(const [id,mime] of [[activePhoto,'image/jpeg'],[retiredPhoto,'image/png'],[randomUUID(),'application/pdf']])await db.query("INSERT INTO attachments VALUES($1,'凭证','receiving_batch',$2,'ready',$3,CURRENT_TIMESTAMP)",[id,receiving,mime]);
  await db.query("INSERT INTO receiving_attachment_retirements VALUES($1)",[retiredPhoto]);
 });
 afterAll(async()=>{await db.end();await dropOwnedPostgresSchema(admin,schema);await admin.end();});
 it("reads unrelated orders with accurate pagination and no financial or node detail fields",async()=>{
  const first=await readBasicRework(db,actor(),{q:'跟单张三',page:1});expect(first.totalCount).toBe(16);expect(first.items).toHaveLength(15);
  expect(Object.keys(first.items[0]!).sort()).toEqual(['reworkOrderId','reworkNo','styleNo','orderNo','processingFactory','merchandiser','quantity','reason','problemPart','problemDescription','status','nodeLabel','photos'].sort());
  expect(first.items[0]).toMatchObject({quantity:'100',processingFactory:'本厂',reason:'断线',photos:[{attachmentId:activePhoto,filename:'凭证'}]});
  expect(await readBasicRework(db,actor(),{q:'跟单张三',page:99})).toMatchObject({page:2,totalCount:16,totalPages:2});
  expect(await readBasicRework(db,actor(),{q:'不存在',page:99})).toMatchObject({page:1,totalCount:0,items:[]});
 });
 it("uses the same basic-view grant for image downloads and rejects retired receipt evidence",async()=>{
  await expect(canDownloadBasicReworkAttachment(db,actor(),{attachmentId:reworkPhoto,entityType:'rework_order',entityId:listedOrder,mimeType:'image/jpeg'})).resolves.toBe(true);
  await expect(canDownloadBasicReworkAttachment(db,actor(),{attachmentId:activePhoto,entityType:'receiving_batch',entityId:receiving,mimeType:'image/jpeg'})).resolves.toBe(true);
  await expect(canDownloadBasicReworkAttachment(db,actor(),{attachmentId:retiredPhoto,entityType:'receiving_batch',entityId:receiving,mimeType:'image/png'})).resolves.toBe(false);
  await expect(canDownloadBasicReworkAttachment(db,actor(quality,false),{attachmentId:reworkPhoto,entityType:'rework_order',entityId:listedOrder,mimeType:'image/jpeg'})).resolves.toBe(false);
 });
 it("rejects absent and forged grants while a mixed-role reader retains the same basic whitelist",async()=>{
  await expect(readBasicRework(db,actor(quality,false),{page:1})).rejects.toMatchObject({statusCode:403});
  await expect(readBasicRework(db,actor(other),{page:1})).rejects.toThrow('forbidden');
  const mixed={...actor(),actorRoles:['quality_control','ie_reviewer']};
  expect((await readBasicRework(db,mixed,{page:1})).items).toEqual((await readBasicRework(db,actor(),{page:1})).items);
 });
});
