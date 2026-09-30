import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export const DIGITAL_PRODUCTION_WORKFLOW_GENERATION = "digital_production_v1" as const;

type Database = Pick<Pool | PoolClient, "query">;

export type ProductionOrderRoot = Readonly<{
  productionOrderId: string;
  workflowGeneration: typeof DIGITAL_PRODUCTION_WORKFLOW_GENERATION;
  createdBy: string;
  createdAt: Date;
}>;

type Row = Readonly<{
  production_order_id: string;
  workflow_generation: typeof DIGITAL_PRODUCTION_WORKFLOW_GENERATION;
  created_by: string;
  created_at: Date;
}>;

const dto = (row: Row): ProductionOrderRoot => ({
  productionOrderId: row.production_order_id,
  workflowGeneration: row.workflow_generation,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

export class ProductionOrderRootRepository {
  constructor(private readonly database: Database) {}

  async create(createdBy: string, productionOrderId = randomUUID()): Promise<ProductionOrderRoot> {
    const result = await this.database.query<Row>(
      `INSERT INTO production_order_roots(production_order_id,workflow_generation,created_by)
       VALUES($1,$2,$3)
       RETURNING production_order_id,workflow_generation,created_by,created_at`,
      [productionOrderId, DIGITAL_PRODUCTION_WORKFLOW_GENERATION, createdBy],
    );
    return dto(result.rows[0]!);
  }

  async read(productionOrderId: string): Promise<ProductionOrderRoot | null> {
    const result = await this.database.query<Row>(
      `SELECT production_order_id,workflow_generation,created_by,created_at
       FROM production_order_roots
       WHERE production_order_id=$1`,
      [productionOrderId],
    );
    return result.rows[0] ? dto(result.rows[0]) : null;
  }
}
