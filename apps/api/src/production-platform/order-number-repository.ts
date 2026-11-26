import type { PoolClient } from 'pg';
import { pinyin } from 'pinyin-pro';
import { digitalPoKey } from '@dx-rework/contracts/digital-production';
import type { OrderNumberContext, OrderNumberPreview, OrderNumberSettings } from '@dx-rework/contracts/digital-order-number';
import { ApplicationError } from '../platform/errors.js';

type Reader = Pick<PoolClient, 'query'>;
type NumberContext = OrderNumberContext & { designerId: string };
type Customer = { code: string; name: string; productGroups: string[] };
type Designer = { userId: string; name: string };
const groups = ['男装', '女装', '男童', '女童'] as const;
const emptySettings: OrderNumberSettings = { boys: null, girls: null, designers: [] };
const settingLock = 'digital-order-number-settings';

export const orderNumberConflict = (message: string): never => {
  throw new ApplicationError('DIGITAL_ORDER_NUMBER_CONFLICT', message, 409);
};

export function designerCodeSuggestion(name: string) {
  const text = name.trim();
  const initials = /^[\p{Script=Han}]{1,12}$/u.test(text)
    ? pinyin(text, { surname: 'head', pattern: 'first', toneType: 'none', type: 'array' }).join('').toUpperCase()
    : '';
  const suggestion = /^[A-Z]{1,12}$/.test(initials) ? initials : null;
  const ambiguous = suggestion !== null && [...text].some(character => new Set(
    pinyin(character, { toneType: 'none', multiple: true, type: 'array' }),
  ).size > 1);
  return { suggestion, needsReview: !suggestion || ambiguous };
}

const productCodes = (values: OrderNumberSettings) =>
  ({ 男装: 'M', 女装: 'W', 男童: values.boys, 女童: values.girls });

function normalizedCustomerCode(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{0,39}$/.test(normalized) || normalized === 'DEV')
    orderNumberConflict('客户主数据代码不能用于发号，请核对格式或保留代码 DEV');
  return normalized;
}

const formatNumber = (prefix: string, number: bigint) => prefix + '-' + String(number).padStart(3, '0');

type IssuedSource={source_id:string;design_style_no:string;workbench_generated_number?:boolean;workbench_number_root_id?:string|null};
type IssuedOrder={source_id:string|null;design_style_no:string};
type IssuedNumberCandidate={source:IssuedSource|null;order:IssuedOrder|null};

/** Resolve only already authorized candidates, with one lookup for all requested revision roots. */
export async function issuedOrderNumbers(db:Reader,candidates:readonly IssuedNumberCandidate[]){
  const roots=new Map<string,string>();
  for(const {source,order} of candidates){
    if(source&&!order&&!source.workbench_generated_number&&source.workbench_number_root_id)
      roots.set(source.source_id,source.workbench_number_root_id);
  }
  const linked=roots.size?(await db.query<{source_id:string;root_id:string;design_style_no:string}>(`
    SELECT revision.source_id,root.source_id AS root_id,root.design_style_no
    FROM jsonb_to_recordset($1::jsonb) AS target(source_id uuid,root_id uuid)
    JOIN digital_development_revision_sources revision ON revision.source_id=target.source_id AND revision.root_source_id=target.root_id
    JOIN digital_production_sources root ON root.source_id=revision.root_source_id AND root.workbench_generated_number
  `,[JSON.stringify([...roots].map(([source_id,root_id])=>({source_id,root_id})))] )).rows:[];
  const bySource=new Map(linked.map(row=>[row.source_id,row]));
  return candidates.map(({source,order})=>{
    if(!source||order&&(order.source_id!==source.source_id||order.design_style_no!==source.design_style_no))return null;
    if(source.workbench_generated_number)return source.design_style_no||null;
    const root=order?undefined:bySource.get(source.source_id);
    return root&&root.root_id===source.workbench_number_root_id?root.design_style_no:null;
  });
}

export async function issuedOrderNumber(db:Reader,source:IssuedSource|null,order:IssuedOrder|null){
  return (await issuedOrderNumbers(db,[{source,order}]))[0]??null;
}

export class OrderNumberRepository {
  constructor(private readonly db: Reader) {}

  /** A previously unnumbered draft may bind its initial customer later. The
   * number claim and its immutable prefix components prove the actual customer
   * without rewriting the original source row or inferring it from the text. */
  async boundCustomer(sourceId:string,orderNumber:string){
    const result=await this.db.query<{customer_code:string|null}>(`SELECT series.components->>'customerCode' AS customer_code
      FROM digital_order_number_claims claim JOIN digital_order_number_series series
        ON series.prefix=regexp_replace($2::text,'-[0-9]+$','')
      WHERE claim.source_id=$1 AND claim.code_key=$3`,[sourceId,orderNumber,digitalPoKey(orderNumber)]);
    return result.rows[0]?.customer_code??null;
  }

  /** Read the original saved numbering dimensions for this exact claim. */
  async boundSales(sourceId:string,orderNumber:string){
    const row=(await this.db.query<{year:string|null;series:string|null}>(`SELECT series.components->>'salesYear' AS year,
      series.components->>'salesSeries' AS series FROM digital_order_number_claims claim
      JOIN digital_order_number_series series ON series.prefix=regexp_replace($2::text,'-[0-9]+$','')
      WHERE claim.source_id=$1 AND claim.code_key=$3`,[sourceId,orderNumber,digitalPoKey(orderNumber)])).rows[0];
    return row?.year&&/^\d{4}$/.test(row.year)?{year:Number(row.year),series:row.series}:undefined;
  }

  async lockSettings(write = false) {
    await this.db.query(write
      ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))'
      : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [settingLock]);
  }

  async current() {
    const row = (await this.db.query<{ version: number; values_json: OrderNumberSettings }>(
      'SELECT version,values_json FROM digital_order_number_settings ORDER BY version DESC LIMIT 1',
    )).rows[0];
    return { version: row?.version ?? 0, values: row?.values_json ?? emptySettings };
  }

  async customers() {
    return (await this.db.query<Customer>(`SELECT code,name,product_groups AS "productGroups"
      FROM digital_production_customers WHERE enabled ORDER BY code`)).rows;
  }

  async designers() {
    return (await this.db.query<Designer>(`SELECT u.id AS "userId",u.display_name AS name FROM app_users u
      WHERE u.enabled AND NOT coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)
        AND EXISTS(SELECT 1 FROM user_role_assignments a JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
          WHERE a.user_id=u.id AND a.role_code='sample_designer' AND a.revoked_at IS NULL)
        AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)
      ORDER BY u.display_name,u.id`)).rows;
  }

  async readSettings() {
    const current = await this.current();
    const customers = await this.customers();
    const designers = (await this.designers()).map(designer => ({ ...designer, ...designerCodeSuggestion(designer.name) }));
    const counts = new Map<string, number>();
    for (const { suggestion } of designers) if (suggestion) counts.set(suggestion, (counts.get(suggestion) ?? 0) + 1);
    return { ...current, customers, designers: designers.map(designer => ({
      ...designer, needsReview: designer.needsReview || Boolean(designer.suggestion && (counts.get(designer.suggestion) ?? 0) > 1),
    })) };
  }

  async saveSettings(expectedVersion: number, values: OrderNumberSettings, actorId: string) {
    await this.lockSettings(true);
    const current = await this.current();
    if (current.version !== expectedVersion) orderNumberConflict('订单ID设置已更新，请读取最新设置后重试');
    const assignedGroups = Object.values(productCodes(values)).filter(Boolean);
    if (new Set(assignedGroups).size !== assignedGroups.length) orderNumberConflict('产品分类代码必须互不重复');
    if (new Set(values.designers.map(item => item.userId)).size !== values.designers.length
      || new Set(values.designers.map(item => item.code)).size !== values.designers.length)
      orderNumberConflict('设计师账号及代码必须唯一');
    const activeDesigners = new Set((await this.designers()).map(item => item.userId));
    for (const designer of values.designers) {
      if (!activeDesigners.has(designer.userId)
        && !current.values.designers.some(item => item.userId === designer.userId && item.code === designer.code))
        orderNumberConflict('只能为当前有效的设计师配置新代码');
    }
    const stems = new Map<string, string>();
    const customerCodes = (await this.customers()).map(customer =>
      ({ key: customer.code, code: normalizedCustomerCode(customer.code), groups: customer.productGroups }));
    customerCodes.push({ key: '', code: 'DEV', groups: [...groups] });
    for (const customer of customerCodes) {
      for (const group of groups) {
        const productCode = productCodes(values)[group];
        if (!productCode || !customer.groups.includes(group)) continue;
        for (const designer of values.designers) {
          const stem = customer.code + productCode + designer.code;
          const identity = JSON.stringify([customer.key, group, designer.userId]);
          if (stems.has(stem) && stems.get(stem) !== identity)
            orderNumberConflict(`客户、产品分类与设计师代码组合会生成相同前缀 ${stem}，请核对设置`);
          stems.set(stem, identity);
        }
      }
    }
    const used = (await this.db.query<{ prefix: string; components: { customerCode: string | null; productGroup: string; designerId: string } }>(
      'SELECT prefix,components FROM digital_order_number_series',
    )).rows;
    for (const { prefix, components } of used) {
      const stem = prefix.slice(0, -7);
      const next = stems.get(stem);
      if (next && next !== JSON.stringify([components.customerCode ?? '', components.productGroup, components.designerId]))
        orderNumberConflict(`生成前缀 ${stem} 已用于其他资料组合，请核对设置`);
    }
    const version = expectedVersion + 1;
    await this.db.query('INSERT INTO digital_order_number_settings(version,values_json,created_by) VALUES($1,$2,$3)',
      [version, JSON.stringify(values), actorId]);
    return { version, values };
  }

  private async prefix(input: NumberContext) {
    const { values } = await this.current();
    const missing: string[] = [];
    const group = input.productGroup;
    const productCode = group ? productCodes(values)[group] : null;
    if (!productCode) missing.push(group ? '产品分类代码' : '产品分类');
    const designer = values.designers.find(item => item.userId === input.designerId);
    if (!designer) missing.push('设计师代码');
    if (!input.salesYear) missing.push('销售年份');
    if (input.kind !== 'development') {
      if (!input.customerCode) missing.push('客户');
      if (!input.salesSeries) missing.push('销售系列');
    }
    let customerCode = 'DEV';
    if (input.customerCode) {
      const customer = (await this.db.query<{ code: string }>(`SELECT code FROM digital_production_customers
        WHERE code=$1 AND enabled AND ($2::text IS NULL OR $2=ANY(product_groups))`, [input.customerCode, group])).rows[0];
      if (!customer) return orderNumberConflict('客户或产品分组不可用');
      customerCode = normalizedCustomerCode(customer.code);
    }
    if (missing.length || !designer || !productCode) return { missing };
    const prefix = customerCode + productCode + designer.code + input.salesYear + (input.salesSeries ?? 'P00');
    // Kind is not part of identity. Changing from development to formal
    // does not create a different owner for a valid prefix.
    const components = JSON.stringify({
      customerCode: input.customerCode, productGroup: group, designerId: input.designerId,
      salesYear: input.salesYear, salesSeries: input.salesSeries,
    });
    return { prefix, components };
  }

  private async occupied(code: string) {
    return Boolean((await this.db.query(`SELECT 1 FROM digital_design_code_registry WHERE code_key=$1
      UNION ALL SELECT 1 FROM digital_order_number_claims WHERE code_key=$1
      UNION ALL SELECT 1 FROM digital_production_sources
        WHERE translate(btrim(design_style_no),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=$1
      UNION ALL SELECT 1 FROM digital_production_orders
        WHERE translate(btrim(design_style_no),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=$1 LIMIT 1`,
    [digitalPoKey(code)])).rowCount);
  }

  async preview(input: NumberContext): Promise<OrderNumberPreview> {
    const resolved = await this.prefix(input);
    if ('missing' in resolved) return { missing: resolved.missing };
    const existing = (await this.db.query<{ last_number: string; same: boolean }>(
      'SELECT last_number,components=$2::jsonb AS same FROM digital_order_number_series WHERE prefix=$1',
      [resolved.prefix, resolved.components],
    )).rows[0];
    if (existing && !existing.same) orderNumberConflict('此编号前缀已用于其他资料组合，请核对设置');
    let number = BigInt(existing?.last_number ?? '0') + 1n;
    while (await this.occupied(formatNumber(resolved.prefix, number))) number++;
    return { prefix: resolved.prefix, example: formatNumber(resolved.prefix, number) };
  }

  /** The caller holds the original source lock and its creation transaction. */
  async bind(sourceId: string, input: NumberContext) {
    await this.lockSettings();
    const resolved = await this.prefix(input);
    if ('missing' in resolved) return null;
    for (;;) {
      const counter = (await this.db.query<{ last_number: string }>(`INSERT INTO digital_order_number_series AS series
        (prefix,components,last_number) VALUES($1,$2,1) ON CONFLICT(prefix) DO UPDATE
        SET last_number=series.last_number+1 WHERE series.components=EXCLUDED.components RETURNING last_number`,
      [resolved.prefix, resolved.components])).rows[0];
      if (!counter) return orderNumberConflict('此编号前缀已用于其他资料组合，请核对设置');
      const code = formatNumber(resolved.prefix, BigInt(counter.last_number));
      if (await this.occupied(code)) continue;
      const key = digitalPoKey(code);
      const claim = await this.db.query('INSERT INTO digital_order_number_claims(code_key,source_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING code_key', [key, sourceId]);
      if (!claim.rowCount) continue;
      await this.db.query(`INSERT INTO digital_design_code_registry(code_key,source_id,code,created_by,workbench_generated_number)
        VALUES($1,$2,$3,$4,true)`, [key, sourceId, code, input.designerId]);
      const bound = await this.db.query('UPDATE digital_production_sources SET design_style_no=$2 WHERE source_id=$1 AND design_style_no IS NULL', [sourceId, code]);
      if (!bound.rowCount) orderNumberConflict('开发档案已经发号，请重新读取原档案');
      return code;
    }
  }
}
