import { ownedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SampleCreateService } from "../../apps/api/src/samples/sample-create-service.js";
import { SampleAttachmentService } from "../../apps/api/src/samples/sample-attachments.js";
import { SampleCapabilitySchema } from "../../packages/contracts/src/samples.js";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
(url ? describe : describe.skip)("sample creation atomicity and attachment authority", () => {
  const schema = ownedPostgresSchema("sample");
  const admin = new pg.Pool({ connectionString: url! }), db = new pg.Pool({ connectionString: url!, options: `-c search_path=${schema}` });
  const service = new SampleCreateService(db, "sample-fixture-corp"), files = new SampleAttachmentService(db);
  const userId = randomUUID(), holderId = randomUUID(), foreignId = randomUUID(), disabledId = randomUUID();
  const actor = (role = "sample_finance", id = userId) => ({ actorId:id, actorRoles:[role], authorizationCapability:"sample:create", authorizationCapabilities:SampleCapabilitySchema.options, requestId:"sample-create-fixture" });
  const attachment = async (owner = userId, status = "ready") => {
    const id = randomUUID();
    await db.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'test.png','image/png',10,$3,$4,$5,$6)`, [id,`test/${id}`,"a".repeat(64),owner,status,status === "ready" ? new Date() : null]);
    return id;
  };
  const input = async () => ({ brand:"测试品牌",styleName:"测试样衣",color:"蓝",department:"设计",purchaseDate:"2020-01-01",purchasePrice:"123.45",purchaserUserId:userId,receiptAttachmentIds:[await attachment()] });
  const count = async () => Number((await db.query("SELECT count(*) FROM sample_items")).rows[0].count);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of ["0001_platform_foundation.sql","0002_dingtalk_identity_access.sql","0003_identity_union_continuity.sql","0004_public_tools_foundation.sql","0005_access_master_data.sql","0152_sample_domain_foundation.sql","0153_sample_read_indexes_snapshots.sql","0154_sample_write_control.sql","0155_sample_financial_audit.sql", "0157_sample_disposal_import.sql"]) {
      await db.query(await readFile(new URL(`../../apps/api/migrations/${name}`,import.meta.url),"utf8"));
    }
    // Only the directory table is relevant; unrelated access-policy triggers are covered by their own suite.
    const directory = await readFile(new URL("../../apps/api/migrations/0033_employee_access_management.sql",import.meta.url),"utf8");
    await db.query(directory.split("CREATE TABLE owner_bootstrap_consumptions")[0]!);
    for (const id of [userId,holderId,foreignId,disabledId]) {
      await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'样衣测试员工',$2)",[id,id !== disabledId]);
      await db.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
        VALUES($1,$2::uuid,'dingtalk',$3,($2::uuid)::text,($2::uuid)::text,true,true,CURRENT_TIMESTAMP)`,[randomUUID(),id,id === foreignId ? "foreign-corp" : "sample-fixture-corp"]);
    }
  });
  afterAll(async () => { await db.end(); await dropOwnedPostgresSchema(admin,schema); await admin.end(); });

  it("stays closed until explicit cutover and denies unrelated roles", async () => {
    const item = await input();
    expect((await service.availability(actor())).enabled).toBe(false);
    await expect(service.create(actor(),{items:[item]},randomUUID(),false)).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    for (const role of ["system_admin","sample_designer","sample_administrative","owner_group"]) await expect(service.create(actor(role),{items:[item]},randomUUID(),false)).rejects.toMatchObject({code:"FORBIDDEN"});
    expect(await count()).toBe(0);
    await db.query("UPDATE sample_write_control SET enabled=true,changed_by=$1,changed_at=CURRENT_TIMESTAMP,reason='isolated fixture cutover'",[userId]);
  });
  it("creates exact finance and first custody together, with purchaser as default holder", async () => {
    const item = await input(), key = randomUUID(), result = await service.create(actor(),{items:[item]},key,false), id = result.items[0]!.sampleId;
    const row = (await db.query(`SELECT s.*,f.purchase_price::text,c.initial_custody,c.requested_by,c.confirmed_by FROM sample_items s
      JOIN sample_financial_facts f USING(sample_id) JOIN sample_custody_records c USING(sample_id) WHERE sample_id=$1`,[id])).rows[0];
    expect(row).toMatchObject({status:"borrowed",holder_user_id:userId,purchaser_user_id:userId,purpose:"采购后直接开发/打板",purchase_price:"123.45",initial_custody:true,requested_by:userId,confirmed_by:null});
    expect(result.items[0]!.sampleCode).toMatch(/^YI-\d{6}-\d{4}$/);
    expect(await service.create(actor(),{items:[item]},key,false)).toEqual(result);
    await expect(service.create(actor(),{items:[{...item,color:"红"}]},key,false)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    expect(Number((await db.query("SELECT count(*) FROM operation_events WHERE entity_type='sample' AND entity_id=$1",[id])).rows[0].count)).toBe(1);
    const audit = JSON.stringify((await db.query("SELECT after_state FROM operation_events WHERE entity_type='sample' AND entity_id=$1",[id])).rows);
    expect(audit).not.toContain("123.45"); expect(audit).not.toContain(item.receiptAttachmentIds[0]);
    expect((await db.query("SELECT after_state FROM sample_financial_audit WHERE sample_id=$1",[id])).rows[0].after_state).toEqual({purchasePrice:"123.45",receiptAttachmentIds:item.receiptAttachmentIds});
    await expect(db.query("UPDATE sample_financial_audit SET after_state='{}' WHERE sample_id=$1",[id])).rejects.toMatchObject({code:"55000"});
  });
  it("allows shared batch receipts and distinct initial holders without exposing receipts", async () => {
    const item = await input(), image = await attachment();
    const result = await service.create(actor(),{items:[{...item,holderUserId:holderId,imageAttachmentIds:[image]},item]},randomUUID(),true);
    expect(result.items).toHaveLength(2); expect(new Set(result.items.map(item=>item.sampleCode)).size).toBe(2);
    const id = result.items[0]!.sampleId;
    expect((await db.query("SELECT holder_user_id FROM sample_items WHERE sample_id=$1",[id])).rows[0].holder_user_id).toBe(holderId);
    expect((await files.list(actor("sample_administrative"),id)).attachments.map(file=>file.attachmentId)).toEqual([image]);
    expect((await files.list(actor(),id)).attachments).toHaveLength(2);
    for (const role of ["sample_designer","sample_administrative","system_admin"]) expect(await files.canDownload(actor(role),{entityType:"sample_attachment",entityId:item.receiptAttachmentIds[0]!})).toBe(false);
    for (const role of ["sample_finance","owner_group","root_superuser"]) expect(await files.canDownload(actor(role),{entityType:"sample_attachment",entityId:item.receiptAttachmentIds[0]!})).toBe(true);
    expect(await files.canDownload(actor("sample_designer"),{entityType:"sample_attachment",entityId:image})).toBe(true);
    await expect(service.create(actor(),{items:[{...await input(),imageAttachmentIds:item.receiptAttachmentIds}]},randomUUID(),false)).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(service.create(actor(),{items:[item]},randomUUID(),false)).rejects.toMatchObject({code:"CONFLICT"});
    await expect(service.create(actor(),{items:[item,item]},randomUUID(),true)).rejects.toMatchObject({code:"CONFLICT"});
  });
  it("rolls back every row, first custody and attachment binding if a later batch item fails", async () => {
    const first = await input(), second = await input(), before = await count(), key = randomUUID();
    await expect(service.create(actor(),{items:[first,{...second,holderUserId:foreignId}]},key,true)).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    expect(await count()).toBe(before);
    expect((await db.query("SELECT entity_type FROM attachments WHERE attachment_id=$1",first.receiptAttachmentIds)).rows[0].entity_type).toBe(null);
    expect(Number((await db.query("SELECT count(*) FROM idempotency_records WHERE idempotency_key=$1",[key])).rows[0].count)).toBe(0);
    expect(Number((await db.query("SELECT count(*) FROM sample_attachment_bindings WHERE attachment_id=$1",first.receiptAttachmentIds)).rows[0].count)).toBe(0);
  });
  it("rejects future purchases, disabled people, unfinished uploads and foreign ownership", async () => {
    const item = await input(), before = await count();
    for (const invalid of [{...item,purchaseDate:"9999-01-01"},{...item,purchaserUserId:disabledId},{...item,receiptAttachmentIds:[await attachment(userId,"pending")]},{...item,receiptAttachmentIds:[await attachment(holderId)]}]) {
      await expect(service.create(actor(),{items:[invalid]},randomUUID(),false)).rejects.toBeDefined();
    }
    expect(await count()).toBe(before);
    const people = await service.people(actor(),"测试员工");
    expect(people.people.map(person=>person.userId).sort()).toEqual([userId,holderId].sort());
  });
  it("serializes concurrent numbering and duplicate submissions in PostgreSQL", async () => {
    const item = await input(), another = await input(), key = randomUUID(), before = await count();
    const results = await Promise.all([service.create(actor(),{items:[item]},key,false),service.create(actor(),{items:[item]},key,false),service.create(actor(),{items:[another]},randomUUID(),false)]);
    expect(results[0]).toEqual(results[1]); expect(results[2]!.items[0]!.sampleCode).not.toBe(results[0]!.items[0]!.sampleCode);
    expect(await count()).toBe(before+2);
  });
});
