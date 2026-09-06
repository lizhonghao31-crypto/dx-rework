import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SampleBatchCreateSchema, SampleCreateResultSchema, SamplePeopleResponseSchema } from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import { canUseSampleCapability, requireSampleCapability } from "./sample-authority.js";
import { bindSampleAttachments } from "./sample-attachments.js";
import { sampleSourceHash } from "./sample-migration.js";

export async function requireSampleWrites(client: PoolClient): Promise<void> {
  const state = await client.query<{ enabled: boolean }>("SELECT enabled FROM sample_write_control WHERE singleton=true FOR SHARE");
  if (!state.rows[0]?.enabled) throw new ApplicationError("INVALID_STATE_TRANSITION", "样衣登记与流转尚未开放", 409);
}
export class SampleCreateService {
  constructor(private readonly database: Pool, private readonly corporationId: string,
    private readonly idempotency = new IdempotencyService(), private readonly events = new OperationEventRepository()) {}

  async availability(actor: TrustedActorContext) {
    requireSampleCapability(actor, "sample:view_basic");
    const result = await this.database.query<{ enabled: boolean }>("SELECT enabled FROM sample_write_control WHERE singleton=true");
    return { enabled: result.rows[0]?.enabled === true,
      canCreate: canUseSampleCapability(actor, "sample:create"), canBatchCreate: canUseSampleCapability(actor, "sample:batch_create") };
  }

  async people(actor: TrustedActorContext, search: string) {
    requireSampleCapability(actor, "sample:create");
    const result = await this.database.query(`SELECT DISTINCT u.id AS "userId",u.display_name AS name,
      COALESCE(array_to_string(p.department_names,' / '),'') AS department
      FROM app_users u JOIN identity_mappings i ON i.user_id=u.id
      LEFT JOIN employee_directory_profiles p ON p.user_id=u.id
      WHERE u.enabled AND i.provider='dingtalk' AND i.corp_id=$1 AND i.active AND i.employed
        AND u.display_name ILIKE $2 ORDER BY name,"userId" LIMIT 15`,
    [this.corporationId, `%${search.replace(/[\\%_]/g, "\\$&")}%`]);
    return SamplePeopleResponseSchema.parse({ people: result.rows });
  }

  private async person(client: PoolClient, id: string) {
    const result = await client.query<{ id: string; display_name: string }>(`SELECT u.id,u.display_name FROM app_users u
      JOIN identity_mappings i ON i.user_id=u.id WHERE u.id=$1 AND u.enabled
        AND i.provider='dingtalk' AND i.corp_id=$2 AND i.active AND i.employed FOR SHARE OF u,i`, [id, this.corporationId]);
    if (!result.rows[0]) throw new ApplicationError("VALIDATION_ERROR", "采购人或持有人不是当前企业的有效员工", 400);
    return result.rows[0];
  }

  async create(actor: TrustedActorContext, input: unknown, key: string, batch: boolean) {
    requireSampleCapability(actor, batch ? "sample:batch_create" : "sample:create");
    const parsed = SampleBatchCreateSchema.safeParse(input);
    if (!parsed.success || (!batch && parsed.data.items.length !== 1)) throw new ApplicationError("VALIDATION_ERROR", "请完整填写样衣资料、采购价和采购小票", 400);
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApplicationError("VALIDATION_ERROR", "缺少有效提交编号，请刷新后重试", 400);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await requireSampleWrites(client);
      const result = await this.idempotency.execute(client, { scope: "sample:create", actorKey: actor.actorId, key,
        requestHash: sampleSourceHash({ batch, input: parsed.data }), expiresAt: new Date("9999-12-31T00:00:00Z") }, async () => {
        const clock = (await client.query<{ period: string; today: string; now: string }>(`SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai','YYYYMM') AS period,
          to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS today,CURRENT_TIMESTAMP::text AS now`)).rows[0]!;
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`sample-number:${clock.period}`]);
        const current = await client.query<{ maximum: number }>("SELECT COALESCE(max(right(sample_code,4)::int),0) AS maximum FROM sample_items WHERE sample_code ~ $1", [`^YI-${clock.period}-[0-9]{4}$`]);
        let number = current.rows[0]!.maximum;
        if (number + parsed.data.items.length > 9999) throw new ApplicationError("CONFLICT", "本月样衣编号已用完，请联系负责人", 409);
        const items: { sampleId: string; sampleCode: string; version: 1 }[] = [];
        // One global lock order for all batch attachments avoids cross-batch deadlocks.
        const ids = [...new Set(parsed.data.items.flatMap(item => [...item.receiptAttachmentIds, ...item.imageAttachmentIds]))].sort();
        await client.query("SELECT attachment_id FROM attachments WHERE attachment_id=ANY($1::uuid[]) ORDER BY attachment_id FOR UPDATE", [ids]);
        for (const item of parsed.data.items) {
          if (item.purchaseDate > clock.today) throw new ApplicationError("VALIDATION_ERROR", "采购日期不能晚于今天", 400);
          const purchaser = await this.person(client, item.purchaserUserId), holder = await this.person(client, item.holderUserId ?? item.purchaserUserId);
          const sampleId = randomUUID(), sampleCode = `YI-${clock.period}-${String(++number).padStart(4, "0")}`;
          await client.query(`INSERT INTO sample_items(sample_id,sample_code,status,brand,style_name,style_no,category,color,size,department,
            purchase_date,purchaser_user_id,purchaser_name,holder_user_id,holder_name,purpose,borrowed_at,remark,created_by)
            VALUES($1,$2,'borrowed',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'采购后直接开发/打板',$15,$16,$17)`,
          [sampleId,sampleCode,item.brand,item.styleName,item.styleNo,item.category,item.color,item.size,item.department,item.purchaseDate,
            purchaser.id,purchaser.display_name,holder.id,holder.display_name,clock.now,item.remark,actor.actorId]);
          await client.query("INSERT INTO sample_financial_facts(sample_id,purchase_price) VALUES($1,$2)", [sampleId,item.purchasePrice]);
          await bindSampleAttachments(client, actor, sampleId, item.receiptAttachmentIds, "purchase_receipt");
          await bindSampleAttachments(client, actor, sampleId, item.imageAttachmentIds, "sample_image");
          await client.query(`INSERT INTO sample_custody_records(custody_id,sample_id,holder_user_id,holder_name,department,purpose,borrowed_at,requested_by,initial_custody)
            VALUES($1,$2,$3,$4,$5,'采购后直接开发/打板',$6,$7,true)`, [randomUUID(),sampleId,holder.id,holder.display_name,item.department,clock.now,actor.actorId]);
          await this.events.append(client, { ...actor, authorizationCapability: batch ? "sample:batch_create" : "sample:create" }, {
            action: "sample.created", entityType: "sample", entityId: sampleId,
            after: { sampleCode,status:"borrowed",version:1,purchaserUserId:purchaser.id,holderUserId:holder.id,purchasePrice:item.purchasePrice,
              receiptAttachmentIds:item.receiptAttachmentIds,imageAttachmentIds:item.imageAttachmentIds },
          });
          items.push({ sampleId, sampleCode, version: 1 });
        }
        return { statusCode: 201, response: SampleCreateResultSchema.parse({ items }) };
      });
      await client.query("COMMIT");
      return result.response;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
