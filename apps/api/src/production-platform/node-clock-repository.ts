import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Database = Pick<Pool | PoolClient, "query">;

export type ProductionOrderNodeClock = Readonly<{
  nodeInstanceId: string;
  productionOrderId: string;
  nodeKey: string;
  occurrence: number;
  enteredAt: Date;
  warningAt: Date;
  dueAt: Date;
  deadlinePolicyKey: string;
  deadlinePolicyVersion: number;
  completedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}>;

export type EnterProductionNodeClock = Readonly<{
  productionOrderId: string;
  nodeKey: string;
  occurrence: number;
  enteredAt: Date;
  warningAt: Date;
  dueAt: Date;
  deadlinePolicyKey: string;
  deadlinePolicyVersion: number;
  createdBy: string;
  nodeInstanceId?: string;
}>;

type Row = Readonly<{
  node_instance_id: string;
  production_order_id: string;
  node_key: string;
  occurrence: number;
  entered_at: Date;
  warning_at: Date;
  due_at: Date;
  deadline_policy_key: string;
  deadline_policy_version: number;
  completed_at: Date | null;
  created_by: string;
  created_at: Date;
}>;

const dto = (row: Row): ProductionOrderNodeClock => ({
  nodeInstanceId: row.node_instance_id,
  productionOrderId: row.production_order_id,
  nodeKey: row.node_key,
  occurrence: row.occurrence,
  enteredAt: row.entered_at,
  warningAt: row.warning_at,
  dueAt: row.due_at,
  deadlinePolicyKey: row.deadline_policy_key,
  deadlinePolicyVersion: row.deadline_policy_version,
  completedAt: row.completed_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

export class ProductionOrderNodeClockRepository {
  constructor(private readonly database: Database) {}

  async enter(input: EnterProductionNodeClock): Promise<ProductionOrderNodeClock> {
    const result = await this.database.query<Row>(
      `INSERT INTO production_order_node_clocks(
         node_instance_id,production_order_id,node_key,occurrence,
         entered_at,warning_at,due_at,deadline_policy_key,deadline_policy_version,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        input.nodeInstanceId ?? randomUUID(),
        input.productionOrderId,
        input.nodeKey,
        input.occurrence,
        input.enteredAt,
        input.warningAt,
        input.dueAt,
        input.deadlinePolicyKey,
        input.deadlinePolicyVersion,
        input.createdBy,
      ],
    );
    return dto(result.rows[0]!);
  }

  async complete(nodeInstanceId: string, completedAt: Date): Promise<ProductionOrderNodeClock> {
    const result = await this.database.query<Row>(
      `UPDATE production_order_node_clocks
       SET completed_at=$2
       WHERE node_instance_id=$1
       RETURNING *`,
      [nodeInstanceId, completedAt],
    );
    if (!result.rows[0]) throw new Error("Production node clock not found");
    return dto(result.rows[0]);
  }

  async listForOrder(productionOrderId: string): Promise<readonly ProductionOrderNodeClock[]> {
    const result = await this.database.query<Row>(
      `SELECT *
       FROM production_order_node_clocks
       WHERE production_order_id=$1
       ORDER BY entered_at,node_key,occurrence,node_instance_id`,
      [productionOrderId],
    );
    return result.rows.map(dto);
  }
}
