import {todoSelectionKey,type TodoSelection} from './selection.js';
import {effectiveSourcingDueSql} from '../production-platform/sla-sourcing-deadline-sql.js';
import {sourcingTodoPresentation} from "./sla-presentation.js";
import {acceptanceBusinessContext,assertAcceptanceAssignee,businessNow} from '../acceptance-clock/business-time.js';
import {arrangementsAvailable} from "../production-platform/development-arrangement.js";
import {sourcingTodoSla} from "../production-platform/sourcing-todo-sla.js";
import {isDeepStrictEqual} from 'node:util';
import {MarkTodoReadSchema,type MarkTodoRead} from '@dx-rework/contracts';
import {nativeDevelopmentTodoExclusion} from "../production-platform/development-arrangement-todos.js";
import { globalTodoSearch } from "./global-search.js";
import { digitalTodoTarget } from "../production-platform/notification-policy.js";
import type { ProductionClosureService } from "../sourcing/production-closure-service.js";
import { memberCanReceiveFact } from "../access/member-module-policy.js";
import { randomUUID } from "node:crypto";

import {
  TodoRouteDescriptorSchema,
  type TodoListResponse,
  type TodoModule,
  type TodoModuleCounts,
  type TodoResponse,
  type TodoRouteDescriptor,
  type TodoCountIndicator,
  type TodoRoutingException,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  MessageOutboxRepository,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

type TodoRow = Readonly<{
  todo_id: string;
  todo_type: TodoResponse["todoType"];
  category: string;
  source_event_id: string;
  source_action: string;
  entity_type: string;
  entity_id: string;
  recipient_user_id: string;
  required_role: string | null;
  required_capability: string | null;
  delegation_id: string | null;
  delegation_scope_id: string | null;
  route_descriptor: TodoRouteDescriptor;
  policy_key: TodoResponse["policyKey"];
  due_at: Date | null;
  reminder_count: number;
  status: TodoResponse["status"];
  blocked_reason: string | null;
  rework_no?: string | null;
  order_no?: string | null;
  style_no?: string | null;
  rework_status?: string | null;
  rework_updated_at?: Date | null;
  supplier_request_status?: string | null;
  supplier_request_updated_at?: Date | null;
  sample_code?: string | null;
  sample_style_no?: string | null;
  sample_status?: string | null;
  sample_updated_at?: Date | null;
  pattern_order_no?: string | null;
  pattern_style_no?: string | null;
  pattern_status?: string | null;
  pattern_updated_at?: Date | null;
  sourcing_order_no?: string | null;
  sourcing_style_no?: string | null;
  sourcing_status?: string | null;
  sourcing_updated_at?: Date | null;
  supplier_name_snapshot?: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}>;

type TodoPageRow = TodoRow & Readonly<{
  status_rank: number;
  todo_module: TodoModule;
}>;

type TodoCountRow = Readonly<{
  todo_module: TodoModule;
  todo_count: number | string;
}>;

export type TodoListOptions = Readonly<{
  module?: TodoModule;
  query?: string;
  page?: number;
}>;

const TODO_LIST_PAGE_SIZE = 15;
const TODO_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TODO_ID_SQL_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const TODO_MODULES: readonly TodoModule[] = ["rework", "sourcing", "production", "samples", "pattern_room", "suppliers", "digital_production"];

const TODO_WITH_CONTEXT_SQL = `SELECT
  todos.todo_id,todos.todo_type,todos.category,todos.source_event_id,todos.source_action,
  todos.entity_type,todos.entity_id,todos.recipient_user_id,todos.required_role,
  todos.required_capability,todos.delegation_scope_id,todos.route_descriptor,todos.policy_key,
  todos.due_at,todos.reminder_count,todos.status,todos.blocked_reason,todos.version,
  todos.created_at,todos.updated_at,
  orders.rework_no,orders.order_no,orders.style_no,orders.status rework_status,
  orders.updated_at rework_updated_at,
  COALESCE(rework_merchandiser.display_name,sourcing_merchandiser.display_name) merchandiser_name,
  supplier_request.status supplier_request_status,supplier_request.updated_at supplier_request_updated_at,
  sample.sample_code,COALESCE(NULLIF(sample.style_no,''),sample.style_name) sample_style_no,
  sample.status sample_status,sample.updated_at sample_updated_at,
  pattern.order_no pattern_order_no,concat_ws(' · ',NULLIF(pattern.task_name,''),NULLIF(pattern.style_no,'')) pattern_style_no,
  pattern.deleted_at pattern_deleted_at,pattern.status pattern_status,pattern.updated_at pattern_updated_at,
  sourcing.erp_order_no sourcing_order_no,sourcing.style_no sourcing_style_no,
  sourcing.status sourcing_status,sourcing.updated_at sourcing_updated_at,
  COALESCE(
    supplier_version.profile->>'supplierName',
    sourcing_decision.supplier_name_snapshot,
    CASE
      WHEN orders.processing_factory_type='own_factory' THEN '本厂'
      ELSE rework_supplier.supplier_name
    END
  ) supplier_name_snapshot,
  CASE
    WHEN todos.entity_type='supplier_onboarding' THEN 'suppliers'
    WHEN todos.entity_type='pattern_room_order' THEN 'pattern_room'
    WHEN todos.entity_type='sample' THEN 'samples'
    WHEN todos.route_descriptor->>'routeName'='sourcing_detail'
      OR todos.entity_type='sourcing_case' THEN 'sourcing'
    ELSE 'rework'
  END todo_module,
  CASE todos.status WHEN 'pending' THEN 0 WHEN 'blocked_recipient' THEN 1 ELSE 2 END status_rank
FROM rework_todos todos
LEFT JOIN supplier_onboarding_requests supplier_request ON supplier_request.request_id=CASE
  WHEN todos.entity_type='supplier_onboarding' AND todos.entity_id~*'${TODO_ID_SQL_PATTERN}' THEN todos.entity_id::uuid END
LEFT JOIN supplier_onboarding_request_versions supplier_version ON (supplier_version.request_id,supplier_version.version)=(supplier_request.request_id,supplier_request.current_version)
LEFT JOIN pattern_room_orders pattern ON pattern.order_id=CASE
  WHEN todos.entity_type='pattern_room_order' AND todos.entity_id~*'${TODO_ID_SQL_PATTERN}' THEN todos.entity_id::uuid END
LEFT JOIN sample_items sample ON sample.sample_id=CASE
  WHEN todos.entity_type='sample' AND todos.entity_id~*'${TODO_ID_SQL_PATTERN}' THEN todos.entity_id::uuid END
LEFT JOIN rework_orders orders
  ON orders.rework_order_id=COALESCE(
    CASE WHEN NULLIF(todos.route_descriptor->>'reworkOrderId','')~*'${TODO_ID_SQL_PATTERN}'
      THEN (todos.route_descriptor->>'reworkOrderId')::uuid END,
    CASE WHEN todos.entity_type='rework_order' AND todos.entity_id~*'${TODO_ID_SQL_PATTERN}' THEN todos.entity_id::uuid END
  )
LEFT JOIN app_users rework_merchandiser ON rework_merchandiser.id=orders.merchandiser_user_id
LEFT JOIN supplier_catalog_versions rework_supplier
  ON rework_supplier.supplier_id=orders.processing_factory_supplier_id
 AND rework_supplier.version=orders.processing_factory_supplier_version
LEFT JOIN current_sourcing_cases sourcing
  ON sourcing.sourcing_case_id=CASE
    WHEN todos.entity_type='sourcing_case' AND todos.entity_id~*'${TODO_ID_SQL_PATTERN}' THEN todos.entity_id::uuid
  END
LEFT JOIN app_users sourcing_merchandiser ON sourcing_merchandiser.id=sourcing.created_by
LEFT JOIN LATERAL (
  SELECT decision.supplier_name_snapshot
  FROM sourcing_decisions decision
  WHERE decision.sourcing_case_id=sourcing.sourcing_case_id
  ORDER BY decision.decision_version DESC
  LIMIT 1
) sourcing_decision ON true`;

type ExistingTodoRow = TodoRow & Readonly<{
  delegation_id: string | null;
  dedupe_key: string;
}>;

type RoutingExceptionRow = Readonly<{
  routing_exception_id: string;
  todo_id: string;
  routing_todo_id: string;
  assigned_to_user_id: string;
  original_recipient_user_id: string;
  created_operation_event_id: string;
  status: "pending" | "resolved" | "cancelled";
}>;

type RoutingExceptionResponseRow = RoutingExceptionRow & Readonly<{
  original_recipient_user_id: string;
  reason: string;
  resolution_reason: string | null;
  created_at: Date;
  updated_at: Date;
}>;

export type TodoRouteTemplate = Readonly<Omit<TodoRouteDescriptor, "todoId">>;

export type CreateTodoInTransactionInput = Readonly<{
  todoType: "business_action" | "information";
  category: string;
  sourceEventId: string;
  sourceAction: string;
  entityType: string;
  entityId: string;
  recipientUserId: string;
  requiredRole?: string;
  requiredCapability?: string;
  delegationId?: string;
  delegationScopeId?: string;
  route: TodoRouteTemplate;
  policyKey?: "general" | "finance_return_or_wage_review" | "deduction_follow_up" | "sourcing_contract_return";
  authoritativeDueAt?: Date;
  dedupeKey: string;
  /** Required when an otherwise valid business action has no eligible recipient. */
  invalidRecipientRouting?: Readonly<{
    reason: string;
    assignedToUserId: string;
  }>;
}>;

export type TransferRoutingExceptionInput = Readonly<{
  routingExceptionId: string;
  recipientUserId: string;
  delegationId?: string;
  reason: string;
}>;

export type TimedTodoAction = Readonly<{
  todoId: string;
  operationEventId: string;
  category: string;
  recipientUserId: string;
  route: TodoRouteDescriptor;
  kind: "reminder" | "escalation";
}>;

const TODO_DELIVERY_TOPIC = "todo.delivery";

const emptyModuleCounts = (): TodoModuleCounts => ({ rework: 0, sourcing: 0 });

const todoResponse = (row: TodoRow): TodoResponse => {
  const contextStatus = row.rework_status ?? row.sourcing_status ?? row.sample_status ?? row.pattern_status ?? row.supplier_request_status;
  const contextUpdatedAt = row.rework_updated_at ?? row.sourcing_updated_at ?? row.sample_updated_at ?? row.pattern_updated_at ?? row.supplier_request_updated_at;
  return ({
  todoId: row.todo_id,
  todoType: row.todo_type,
  category: row.category,
  sourceEventId: row.source_event_id,
  sourceAction: row.source_action,
  entityType: row.entity_type,
  entityId: row.entity_id,
  recipientUserId: row.recipient_user_id,
  requiredRole: row.required_role,
  requiredCapability: row.required_capability,
  route: TodoRouteDescriptorSchema.parse({ ...row.route_descriptor, todoId: row.todo_id }),
  policyKey: row.policy_key,
  dueAt: row.due_at?.toISOString() ?? null,
  reminderCount: row.reminder_count,
  status: row.status,
  blockedReason: row.blocked_reason,
  orderContext: contextStatus && contextUpdatedAt
    ? {
        reworkNo: row.rework_no ?? null,
        orderNo: row.order_no ?? row.sourcing_order_no ?? row.sample_code ?? row.pattern_order_no ?? null,
        styleNo: row.style_no ?? row.sourcing_style_no ?? row.sample_style_no ?? row.pattern_style_no ?? null,
        supplierName: row.supplier_name_snapshot ?? null,
        status: contextStatus,
        updatedAt: contextUpdatedAt.toISOString(),
      }
    : null,
  version: row.version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  });
};

const validateCreateInput = (input: CreateTodoInTransactionInput): void => {
  if (!input.category.trim() || input.category.length > 120 || !input.dedupeKey.trim()) {
    throw new ApplicationError("VALIDATION_ERROR", "Todo category and dedupe key are required", 400);
  }
  if (input.todoType === "information") {
    if (input.requiredRole || input.requiredCapability || input.policyKey || input.authoritativeDueAt) {
      throw new ApplicationError("VALIDATION_ERROR", "Information notifications cannot carry an action policy", 400);
    }
    return;
  }
  if (!input.requiredRole || !input.requiredCapability || !input.policyKey) {
    throw new ApplicationError("VALIDATION_ERROR", "Business todos require role, capability and policy", 400);
  }
  if (input.policyKey === "deduction_follow_up" && !input.authoritativeDueAt) {
    throw new ApplicationError("VALIDATION_ERROR", "Deduction overdue todos require an authoritative deadline", 400);
  }
  if (input.policyKey !== "deduction_follow_up" && input.authoritativeDueAt) {
    throw new ApplicationError("VALIDATION_ERROR", "Only deduction overdue todos may supply a deadline", 400);
  }
};

export class TodoService {
  private slaAvailability?:Promise<boolean>;
  private async appliedSlaAvailable(db:Pick<Pool,"query">){return this.slaAvailability??=db.query("SELECT to_regclass('digital_sla_order_snapshots') AS relation").then(r=>!!r.rows[0]?.relation);}
  private async contextSql(){const sql=await this.appliedSlaAvailable(this.database)?TODO_WITH_CONTEXT_SQL.replace('todos.due_at,',`${effectiveSourcingDueSql('todos')} AS due_at,`):TODO_WITH_CONTEXT_SQL;return sql+(this.digital&&await arrangementsAvailable(this.database)?` WHERE ${nativeDevelopmentTodoExclusion}`:"");}
  constructor(
    private readonly database: Pool,
    private readonly events = new OperationEventRepository(),
    private readonly outbox = new MessageOutboxRepository(),
    private readonly production?: Pick<ProductionClosureService,"todos"> & Partial<Pick<ProductionClosureService,'markRead'|'todo'|'todoSelections'|'todoCounts'>>,
    private readonly digital?: {todos(actor:TrustedActorContext):Promise<TodoResponse[]>;todo?(actor:TrustedActorContext,id:string):Promise<TodoResponse|null>;todoSelections?(actor:TrustedActorContext,options?:{metadata?:boolean;todoId?:string}):Promise<TodoSelection[]>;todoCounts?(actor:TrustedActorContext):Promise<{totalCount:number;pendingCount:number;unreadCount:number}>},
  ) {}

  private async providerSelections(provider:{todos(actor:TrustedActorContext):Promise<TodoResponse[]>;todoSelections?(actor:TrustedActorContext,options?:{metadata?:boolean}):Promise<TodoSelection[]>}|undefined,actor:TrustedActorContext,metadata:boolean):Promise<TodoSelection[]> {
    if(!provider)return [];
    if(provider.todoSelections)return provider.todoSelections(actor,{metadata});
    return (await provider.todos(actor)).map(todo=>({key:todoSelectionKey(todo),load:async()=>todo}));
  }
  private async providerTodo(provider:{todos(actor:TrustedActorContext):Promise<TodoResponse[]>;todo?(actor:TrustedActorContext,id:string):Promise<TodoResponse|null>}|undefined,actor:TrustedActorContext,id:string){
    return provider?.todo?provider.todo(actor,id):(await provider?.todos(actor))?.find(todo=>todo.todoId===id)??null;
  }

  async listForActor(
    actor: TrustedActorContext,
    options: TodoListOptions = {},
  ): Promise<TodoListResponse> {
    this.requireCapability(actor, "todo:view");
    const normalizedQuery = options.query?.trim() ?? "";
    if (normalizedQuery.length > 100) {
      throw new ApplicationError("VALIDATION_ERROR", "搜索内容不能超过100个字符", 400);
    }
    if (options.module !== undefined && !TODO_MODULES.includes(options.module)) {
      throw new ApplicationError("VALIDATION_ERROR", "待办模块无效", 400);
    }
    const requestedPage = options.page ?? 1;
    if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 100_000) {
      throw new ApplicationError("VALIDATION_ERROR", "页码无效", 400);
    }

    const countResult = await this.database.query<TodoCountRow>(
      `WITH todo_view AS (${await this.contextSql()})
       SELECT todo_module,COUNT(*) todo_count
       FROM todo_view
       WHERE recipient_user_id=$1
         AND todo_type<>'information'
         AND status IN ('pending','blocked_recipient')
         AND category<>'wage_month_close'
         AND (rework_status IS NULL OR rework_status<>'deleted')
         AND pattern_deleted_at IS NULL
       GROUP BY todo_module`,
      [actor.actorId],
    );
    const moduleCounts = emptyModuleCounts();
    for (const row of countResult.rows) {
      moduleCounts[row.todo_module] = Number(row.todo_count);
    }
    const productionTodos = await this.providerSelections(this.production,actor,Boolean(normalizedQuery));
    if (this.production) moduleCounts.production = productionTodos.length;
    const digitalTodos = await this.providerSelections(this.digital,actor,Boolean(normalizedQuery));
    if (this.digital) moduleCounts.digital_production = digitalTodos.length;
    const activeModule = options.module
      ?? TODO_MODULES.find((module) => (moduleCounts[module] ?? 0) > 0)
      ?? "rework";
    if(normalizedQuery){
      const result=await globalTodoSearch(this.database,await this.contextSql(),actor.actorId,normalizedQuery,requestedPage,[
        ...productionTodos.map(item=>({module:"production",todo:item.key})),...digitalTodos.map(item=>({module:"digital_production",todo:item.key})),
      ]);
      const providers=new Map([...productionTodos,...digitalTodos].map(item=>[item.key.todoId,item]));
      const todos=await Promise.all(result.items.map(async item=>{
        if(item.kind==="provider"){
          const selected=providers.get(String(item.value.todoId));
          if(!selected)throw new ApplicationError('NOT_FOUND','待办信息已变化，请刷新当前列表',409);
          return selected.load();
        }
        const row={...item.value};
        for(const key of ["due_at","created_at","updated_at","rework_updated_at","sourcing_updated_at","sample_updated_at","pattern_updated_at","supplier_request_updated_at"]){if(row[key]!=null)row[key]=new Date(String(row[key]));}
        return todoResponse(row as unknown as TodoRow);
      }));
      return {todos:await sourcingTodoPresentation(this.database,todos),activeModule,moduleCounts,searchScope:"all",page:result.page,pageSize:15,totalCount:Number(result.total_count),totalPages:result.total_pages};
    }
    if (activeModule === "production" || activeModule === "digital_production") {
      const selected = activeModule === "production" ? productionTodos : digitalTodos;
      const totalCount = selected.length, totalPages = Math.ceil(totalCount / 15), page = totalPages ? Math.min(requestedPage,totalPages) : 1;
      return {todos:await Promise.all(selected.slice((page-1)*15,page*15).map(item=>item.load())),activeModule,moduleCounts,page,pageSize:15,totalCount,totalPages};
    }

    const totalResult = await this.database.query<{ total_count: number | string }>(
      `WITH todo_view AS (${await this.contextSql()})
       SELECT COUNT(*) total_count
       FROM todo_view
       WHERE recipient_user_id=$1
         AND todo_type<>'information'
         AND status IN ('pending','blocked_recipient')
         AND category<>'wage_month_close'
         AND (rework_status IS NULL OR rework_status<>'deleted')
         AND pattern_deleted_at IS NULL
         AND todo_module=$2
         AND (
           $3=''
           OR strpos(upper(COALESCE(style_no,sourcing_style_no,'')),upper($3))>0
           OR strpos(upper(COALESCE(sample_style_no,pattern_style_no,'')),upper($3))>0
           OR strpos(upper(COALESCE(supplier_name_snapshot,'')),upper($3))>0
           OR strpos(upper(COALESCE(sample_code,pattern_order_no,'')),upper($3))>0
           OR strpos(upper(COALESCE(merchandiser_name,'')),upper($3))>0
         )`,
      [actor.actorId, activeModule, normalizedQuery],
    );
    const totalCount = Number(totalResult.rows[0]?.total_count ?? 0);
    const totalPages = Math.ceil(totalCount / TODO_LIST_PAGE_SIZE);
    const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);

    const result = await this.database.query<TodoPageRow>(
      `WITH todo_view AS (${await this.contextSql()})
       SELECT todo_view.*
       FROM todo_view
       WHERE recipient_user_id=$1
         AND todo_type<>'information'
         AND status IN ('pending','blocked_recipient')
         AND category<>'wage_month_close'
         AND (rework_status IS NULL OR rework_status<>'deleted')
         AND pattern_deleted_at IS NULL
         AND todo_module=$2
         AND (
           $3=''
           OR strpos(upper(COALESCE(style_no,sourcing_style_no,'')),upper($3))>0
           OR strpos(upper(COALESCE(sample_style_no,pattern_style_no,'')),upper($3))>0
           OR strpos(upper(COALESCE(supplier_name_snapshot,'')),upper($3))>0
           OR strpos(upper(COALESCE(sample_code,pattern_order_no,'')),upper($3))>0
           OR strpos(upper(COALESCE(merchandiser_name,'')),upper($3))>0
         )
       ORDER BY status_rank ASC,due_at ASC NULLS LAST,created_at DESC,todo_id DESC
       LIMIT $4 OFFSET $5`,
      [
        actor.actorId,
        activeModule,
        normalizedQuery,
        TODO_LIST_PAGE_SIZE,
        (page - 1) * TODO_LIST_PAGE_SIZE,
      ],
    );
    return {
      todos: await sourcingTodoPresentation(this.database,result.rows.map(todoResponse)),
      activeModule,
      moduleCounts,
      page,
      pageSize: TODO_LIST_PAGE_SIZE,
      totalCount,
      totalPages,
    };
  }

  async getForActor(actor: TrustedActorContext, todoId: string): Promise<TodoResponse> {
    this.requireCapability(actor, "todo:view");
    if (!TODO_ID_PATTERN.test(todoId)) {
      throw new ApplicationError("VALIDATION_ERROR", "待办标识无效", 400);
    }
    const result = await this.database.query<TodoPageRow>(
      `WITH todo_view AS (${await this.contextSql()})
       SELECT todo_view.*
       FROM todo_view
       WHERE recipient_user_id=$1
         AND todo_id=$2
         AND (rework_status IS NULL OR rework_status<>'deleted')
         AND pattern_deleted_at IS NULL`,
      [actor.actorId, todoId],
    );
    const row = result.rows[0];
    if (!row && this.production) { const todo = await this.providerTodo(this.production,actor,todoId); if(todo)return todo; }
    if (!row && this.digital) { const todo = await this.providerTodo(this.digital,actor,todoId); if(todo)return todo; }
    if (!row) throw new ApplicationError("NOT_FOUND", "待办不存在或已不再分配给你", 404);
    return (await sourcingTodoPresentation(this.database,[todoResponse(row)]))[0]!;
  }

  async countIndicatorForActor(actor: TrustedActorContext): Promise<TodoCountIndicator> {
    this.requireCapability(actor, "todo:view");
    const result = await this.database.query<{ pending_count: number | string }>(
      `SELECT COUNT(*) pending_count
       FROM rework_todos todos
       LEFT JOIN rework_orders orders
         ON orders.rework_order_id=COALESCE(
           CASE WHEN NULLIF(todos.route_descriptor->>'reworkOrderId','')~*'${TODO_ID_SQL_PATTERN}'
             THEN (todos.route_descriptor->>'reworkOrderId')::uuid END,
           CASE WHEN todos.entity_type='rework_order' AND todos.entity_id~*'${TODO_ID_SQL_PATTERN}' THEN todos.entity_id::uuid END
         )
       LEFT JOIN pattern_room_orders pattern ON pattern.order_id=CASE
         WHEN todos.entity_type='pattern_room_order' AND todos.entity_id~*'${TODO_ID_SQL_PATTERN}' THEN todos.entity_id::uuid END
       WHERE pattern.deleted_at IS NULL AND todos.recipient_user_id=$1
         AND todos.todo_type<>'information'
         AND todos.status IN ('pending','blocked_recipient')
         AND todos.category<>'wage_month_close'
         AND (orders.rework_order_id IS NULL OR orders.status<>'deleted')
         ${this.digital&&await arrangementsAvailable(this.database)?`AND ${nativeDevelopmentTodoExclusion}`:''}`,
      [actor.actorId],
    );
    const counts=async(provider:typeof this.digital|typeof this.production,production:boolean)=>{
      if(!provider)return {pendingCount:0,unreadCount:0};
      if(provider.todoCounts)return provider.todoCounts(actor);
      const rows=await provider.todos(actor);
      return {pendingCount:production?rows.filter(todo=>todo.unread).length:rows.length,unreadCount:rows.filter(todo=>todo.contentToken&&todo.unread===true).length};
    };
    const production=await counts(this.production,true),digital=await counts(this.digital,false);
    return {pendingCount:Number(result.rows[0]?.pending_count??0)+production.pendingCount+digital.pendingCount,unreadCount:production.unreadCount+digital.unreadCount};
  }

  async markReadForActor(actor:TrustedActorContext,todoId:string,input:MarkTodoRead){
    this.requireCapability(actor,'todo:view');
    const parsed=MarkTodoReadSchema.safeParse(input);
    if(!TODO_ID_PATTERN.test(todoId)||!parsed.success)throw new ApplicationError('VALIDATION_ERROR','缺少有效事项、内容依据或阅读路由',400);
    const check=(todo:TodoResponse)=>{
      if(todo.recipientUserId!==actor.actorId||!todo.contentToken||todo.contentToken!==parsed.data.contentToken||!isDeepStrictEqual(todo.route,parsed.data.route))
        throw new ApplicationError('TODO_CONTENT_CHANGED','事项内容、轮次或收件人已变化，本次未标读；请重新打开当前事项',409);
      if(!['pending','blocked_recipient'].includes(todo.status))throw new ApplicationError('NOT_FOUND','事项已不在当前待办中',404);
    };
    const todo=await this.getForActor(actor,todoId);check(todo);
    if(todo.route.routeName==='production_detail'){
      if(!this.production?.markRead)throw new ApplicationError('READ_STATE_UNAVAILABLE','生产事项阅读服务尚未就绪，请管理员核实版本',503);
      await this.production.markRead(actor,todoId);
      const row=(await this.database.query('SELECT read_at FROM sourcing_production_alert_reads WHERE alert_id=$1 AND user_id=$2',[todoId,actor.actorId])).rows[0];
      if(!row)throw new ApplicationError('NOT_FOUND','该风险已解除或不再属于你，本次没有新增阅读记录',404);
      return{read:true as const,contentToken:todo.contentToken!,readAt:new Date(row.read_at).toISOString()};
    }
    const client=await this.database.connect();
    try{
      await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      // Re-resolve original provider membership after acquiring its lifecycle lock;
      // a stale read cannot mark a new return/reassignment/round as read.
      const current=await this.providerTodo(this.digital,actor,todoId);
      if(!current)throw new ApplicationError('NOT_FOUND','事项已结束、已改派或不再属于你，本次未标读',404);check(current);
      await client.query('INSERT INTO todo_content_reads(recipient_id,todo_id,content_token,read_route) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[actor.actorId,todoId,current.contentToken,JSON.stringify(current.route)]);
      const row=(await client.query('SELECT read_at FROM todo_content_reads WHERE recipient_id=$1 AND todo_id=$2 AND content_token=$3',[actor.actorId,todoId,current.contentToken])).rows[0];
      await client.query('COMMIT');return{read:true as const,contentToken:current.contentToken!,readAt:new Date(row.read_at).toISOString()};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  async listRoutingExceptionsForActor(
    actor: TrustedActorContext,
  ): Promise<TodoRoutingException[]> {
    if (actor.authorizationCapability === "todo:routing_exception_read") this.requireCapability(actor, "todo:routing_exception_read", "pmc");
    else this.requireCapability(actor, "todo:routing_exception_manage", "production_management");
    const result = await this.database.query<RoutingExceptionResponseRow>(
      `SELECT routing_exception_id,todo_id,routing_todo_id,original_recipient_user_id,
              assigned_to_user_id,status,reason,resolution_reason,created_at,updated_at
       FROM todo_recipient_routing_exceptions
       WHERE assigned_to_user_id=$1 AND status='pending'
       ORDER BY created_at DESC,routing_exception_id DESC`,
      [actor.actorId],
    );
    return result.rows.map((row) => ({
      routingExceptionId: row.routing_exception_id,
      todoId: row.todo_id,
      routingTodoId: row.routing_todo_id,
      originalRecipientUserId: row.original_recipient_user_id,
      assignedToUserId: row.assigned_to_user_id,
      status: row.status,
      reason: row.reason,
      resolutionReason: row.resolution_reason,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  /**
   * Must be called inside the already-open business transaction. It creates
   * only a platform todo fact; business-state changes remain in package 3.
   */
  async createInTransaction(
    client: PoolClient,
    actor: TrustedActorContext,
    input: CreateTodoInTransactionInput,
  ): Promise<TodoResponse> {
    validateCreateInput(input);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.dedupeKey]);
    const existing = await client.query<ExistingTodoRow>(
      `SELECT todo_id,todo_type,category,source_event_id,source_action,entity_type,entity_id,
              recipient_user_id,required_role,required_capability,delegation_id,delegation_scope_id,route_descriptor,
              policy_key,due_at,reminder_count,status,blocked_reason,version,created_at,updated_at,
              dedupe_key
       FROM rework_todos WHERE dedupe_key=$1 FOR UPDATE`,
      [input.dedupeKey],
    );
    if (existing.rows[0]) return this.ensureMatchingExisting(existing.rows[0], input);

    const source = await client.query<{ action: string; entity_type: string; entity_id: string }>(
      "SELECT action,entity_type,entity_id FROM operation_events WHERE event_id=$1 FOR KEY SHARE",
      [input.sourceEventId],
    );
    const sourceRow = source.rows[0];
    if (!sourceRow) throw new ApplicationError("NOT_FOUND", "Todo source event was not found", 404);
    if (sourceRow.action !== input.sourceAction || sourceRow.entity_type !== input.entityType || sourceRow.entity_id !== input.entityId) {
      throw new ApplicationError("CONFLICT", "Todo source event does not match its business fact", 409);
    }

    const todoId = randomUUID();
    const route = TodoRouteDescriptorSchema.parse({ ...input.route, todoId });
    if (input.todoType !== "information") {
      const policy = await client.query<{ policy_key: string }>(
        "SELECT policy_key FROM todo_policies WHERE policy_key=$1 AND enabled=true FOR KEY SHARE",
        [input.policyKey],
      );
      if (!policy.rows[0]) {
        throw new ApplicationError("CONFLICT", "Todo policy is not enabled", 409);
      }
    }
    const isEligible = input.todoType === "information"
      ? true
      : await this.isEligibleRecipient(client, input.recipientUserId, input.requiredRole!, input.requiredCapability!, input.delegationId, input.delegationScopeId ?? input.entityId);
    if (!isEligible && !input.invalidRecipientRouting) {
      throw new ApplicationError("CONFLICT", "Todo recipient is no longer eligible", 409);
    }

    const sourcingTiming = input.todoType === "business_action" ? await sourcingTodoSla(client,input) : undefined;
    const creationEventId = await this.events.append(client, actor, {
      action: "todo.create",
      entityType: "rework_todo",
      entityId: todoId,
      after: { sourceEventId: input.sourceEventId, sourceAction: input.sourceAction, todoType: input.todoType,
        ...(sourcingTiming ? {slaTiming: {snapshotId:sourcingTiming.snapshotId,dueAt:sourcingTiming.dueAt?.toISOString()??null}} : {}) },
    });
    await this.setTodoContext(client, creationEventId, actor.requestId);
    const created = await client.query<TodoRow>(
      `INSERT INTO rework_todos(
         todo_id,todo_type,category,source_event_id,source_action,entity_type,entity_id,
         recipient_user_id,required_role,required_capability,delegation_id,delegation_scope_id,route_descriptor,
         policy_key,due_at,dedupe_key,created_operation_event_id,created_request_id
       ) VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
         CASE
           WHEN $19::boolean THEN $15::timestamptz
           WHEN $14::text IS NULL THEN NULL
           WHEN $14='deduction_follow_up' THEN $15::timestamptz
           WHEN $14='sourcing_contract_return' THEN NULL
           ELSE COALESCE($20::timestamptz,CURRENT_TIMESTAMP) + (
             SELECT policy.due_after_seconds * interval '1 second'
             FROM todo_policies policy WHERE policy.policy_key=$14 AND policy.enabled=true
           )
         END,
         $16,$17,$18
       ) RETURNING todo_id,todo_type,category,source_event_id,source_action,entity_type,entity_id,
                   recipient_user_id,required_role,required_capability,delegation_scope_id,route_descriptor,policy_key,
                   due_at,reminder_count,status,blocked_reason,version,created_at,updated_at`,
      [
        todoId, input.todoType, input.category.trim(), input.sourceEventId, input.sourceAction,
        input.entityType, input.entityId, input.recipientUserId, input.requiredRole ?? null,
        input.requiredCapability ?? null, input.delegationId ?? null,
        input.todoType === "information" ? null : (input.delegationScopeId ?? input.entityId),
        route, input.policyKey ?? null, sourcingTiming ? sourcingTiming.dueAt : input.authoritativeDueAt ?? null,
        input.dedupeKey, creationEventId, actor.requestId,
        Boolean(sourcingTiming),acceptanceBusinessContext()?businessNow().toISOString():null,
      ],
    );
    const todo = created.rows[0];
    if (!todo) throw new ApplicationError("INTERNAL_ERROR", "Todo creation did not return a row", 500);

    if (!isEligible) {
      await this.blockInvalidRecipientInTransaction(client, actor, todo, input.invalidRecipientRouting!);
      const blocked = await this.todoById(client, todo.todo_id);
      return todoResponse(blocked);
    }
    await this.enqueueDelivery(client, todo, creationEventId, actor.requestId, input.todoType === "information" ? "information" : "create");
    return todoResponse(todo);
  }

  /** Internal transaction adapter for the existing mother personnel command; no public transfer endpoint. */
  async reassignDigitalSourcingWithClient(client:PoolClient,actor:TrustedActorContext,orderId:string,from:string|null,to:string,auditId:string):Promise<void>{
    if(!from||from===to||!(await client.query("SELECT to_regclass('rework_todos') AS relation")).rows[0]?.relation)return;
    const rows=(await client.query<TodoRow>(`SELECT t.* FROM rework_todos t
      JOIN digital_production_child_links l ON l.module='sourcing' AND l.child_id::text=t.entity_id
      JOIN sourcing_cases s ON s.sourcing_case_id=l.child_id AND to_jsonb(s)->>'workflow_generation'='digital_production_v1'
      WHERE l.production_order_id=$1 AND t.recipient_user_id=$2 AND t.status IN ('pending','blocked_recipient')
        AND t.todo_type='business_action' AND t.entity_type='sourcing_case' AND t.required_role='order_merchandiser'
        AND t.category IN ('sourcing_contract_return','sourcing_merchandiser_correction','sourcing_transfer_contract_return','sourcing_price_contract_return')
        AND (t.dedupe_key ~ ('^sourcing:'||t.entity_id||':(return|correction):[0-9]+$')
          OR t.dedupe_key ~ ('^sourcing:'||t.entity_id||':(transfer-return|price-return):[0-9a-f-]{36}:[0-9a-f-]{36}$'))
      ORDER BY t.todo_id FOR UPDATE OF t`,[orderId,from])).rows;
    for(const todo of rows){
      if(!todo.required_capability||!await this.isEligibleRecipient(client,to,"order_merchandiser",todo.required_capability,undefined,todo.delegation_scope_id??todo.entity_id))throw new ApplicationError("FORBIDDEN","新主跟单缺少原待办办理权限",403);
      const eventId=await this.events.append(client,actor,{action:"todo.transfer",entityType:"rework_todo",entityId:todo.todo_id,
        before:{recipientUserId:from,status:todo.status},after:{recipientUserId:to,status:"pending",digitalOrderId:orderId,handoverAuditId:auditId},reason:"母单主跟单交接，保留原待办与时钟"});
      await this.setTodoContext(client,eventId,actor.requestId);
      await client.query("UPDATE rework_todos SET recipient_user_id=$2,delegation_id=NULL,status='pending',blocked_at=NULL,blocked_reason=NULL WHERE todo_id=$1",[todo.todo_id,to]);
      const transferred=await this.todoById(client,todo.todo_id);
      if(todo.status==="blocked_recipient")await this.cancelPendingRoutingExceptionForTodo(client,actor,todo.todo_id,"母单已合法调整主跟单");
      await this.enqueueDelivery(client,transferred,eventId,actor.requestId,"create");
      if((await client.query("SELECT to_regclass('digital_production_notification_receipts') AS relation")).rows[0]?.relation)await client.query(`INSERT INTO digital_production_notification_receipts(event_id,recipient_id,source_event_id)
        SELECT receipt.event_id,$2,receipt.source_event_id FROM digital_production_notification_receipts receipt
        JOIN digital_production_notification_events event USING(event_id)
        WHERE event.todo_id=$1 AND receipt.recipient_id=$3 AND event.event_kind IN ('ready','overdue')
        ON CONFLICT DO NOTHING`,[todo.todo_id,to,from]);
    }
  }

  async transferRoutingException(
    actor: TrustedActorContext,
    input: TransferRoutingExceptionInput,
  ): Promise<TodoResponse> {
    this.requireCapability(actor, "todo:routing_exception_manage", "production_management");
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const routing = await client.query<RoutingExceptionRow>(
        `SELECT routing_exception_id,todo_id,routing_todo_id,assigned_to_user_id,status
         FROM todo_recipient_routing_exceptions
         WHERE routing_exception_id=$1 FOR UPDATE`,
        [input.routingExceptionId],
      );
      const exception = routing.rows[0];
      if (!exception) throw new ApplicationError("NOT_FOUND", "Todo routing exception was not found", 404);
      if (exception.status !== "pending") throw new ApplicationError("INVALID_STATE_TRANSITION", "Todo routing exception is no longer pending", 409);
      if (exception.assigned_to_user_id !== actor.actorId) throw new ApplicationError("FORBIDDEN", "This routing exception is assigned to another manager", 403);

      const todo = await this.todoById(client, exception.todo_id, true);
      if (todo.status !== "blocked_recipient" || !todo.required_role || !todo.required_capability) {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "Todo is not eligible for controlled transfer", 409);
      }
      const eligible = await this.isEligibleRecipient(
        client,
        input.recipientUserId,
        todo.required_role,
        todo.required_capability,
        input.delegationId,
        todo.delegation_scope_id ?? todo.entity_id,
      );
      if (!eligible) throw new ApplicationError("FORBIDDEN", "New recipient lacks the required active authority", 403);

      const transferEventId = await this.events.append(client, actor, {
        action: "todo.transfer",
        entityType: "rework_todo",
        entityId: todo.todo_id,
        before: { recipientUserId: todo.recipient_user_id, status: todo.status },
        after: { recipientUserId: input.recipientUserId, status: "pending" },
        reason: input.reason.trim(),
      });
      await this.setTodoContext(client, transferEventId, actor.requestId);
      await client.query(
        `INSERT INTO todo_recipient_transfers(
           transfer_id,routing_exception_id,todo_id,from_recipient_user_id,to_recipient_user_id,
           required_role,required_capability,delegation_id,delegation_scope_id,reason,transferred_by,
           operation_event_id,operation_request_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          randomUUID(), exception.routing_exception_id, todo.todo_id, todo.recipient_user_id,
          input.recipientUserId, todo.required_role, todo.required_capability,
          input.delegationId ?? null, todo.delegation_scope_id ?? todo.entity_id,
          input.reason.trim(), actor.actorId, transferEventId, actor.requestId,
        ],
      );
      await client.query(
        `UPDATE rework_todos
         SET recipient_user_id=$2,delegation_id=$3,status='pending',blocked_at=NULL,blocked_reason=NULL
         WHERE todo_id=$1`,
        [todo.todo_id, input.recipientUserId, input.delegationId ?? null],
      );
      await client.query(
        `UPDATE todo_recipient_routing_exceptions
         SET status='resolved',resolution_reason=$2,resolved_by=$3,resolved_at=CURRENT_TIMESTAMP,
             resolved_operation_event_id=$4
         WHERE routing_exception_id=$1`,
        [exception.routing_exception_id, input.reason.trim(), actor.actorId, transferEventId],
      );
      const transferred = await this.todoById(client, todo.todo_id);
      const routingTodo = await this.todoById(client, exception.routing_todo_id, true);
      if (routingTodo.status !== "pending") {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "Routing exception todo is no longer pending", 409);
      }
      const routingTodoCompletionEventId = await this.events.append(client, actor, {
        action: "todo.complete",
        entityType: "rework_todo",
        entityId: routingTodo.todo_id,
        before: { status: "pending", routingExceptionId: exception.routing_exception_id },
        after: { status: "completed", routingExceptionId: exception.routing_exception_id },
        reason: input.reason.trim(),
      });
      await this.setTodoContext(client, routingTodoCompletionEventId, actor.requestId);
      await client.query(
        `UPDATE rework_todos
         SET status='completed',completed_at=CURRENT_TIMESTAMP,completed_by=$2,
             completed_operation_event_id=$3
         WHERE todo_id=$1`,
        [routingTodo.todo_id, actor.actorId, routingTodoCompletionEventId],
      );
      await this.setTodoContext(client, transferEventId, actor.requestId);
      await this.enqueueDelivery(client, transferred, transferEventId, actor.requestId, "create");
      await client.query("COMMIT");
      return todoResponse(transferred);
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Internal projection closure only. The caller has already completed the
   * business transition in this transaction; this method records the separate,
   * append-only todo completion without granting a new business capability.
   */
  async completeOpenByDedupeKey(
    client: PoolClient,
    actor: TrustedActorContext,
    dedupeKey: string,
    reason: string,
  ): Promise<boolean> {
    return this.closeOpenByDedupeKey(client, actor, dedupeKey, "completed", reason);
  }

  /** See completeOpenByDedupeKey. Cancellation is used when a newer business
   * version supersedes the action represented by the old todo. */
  async cancelOpenByDedupeKey(
    client: PoolClient,
    actor: TrustedActorContext,
    dedupeKey: string,
    reason: string,
  ): Promise<boolean> {
    return this.closeOpenByDedupeKey(client, actor, dedupeKey, "cancelled", reason);
  }

  async cancelOpenByDedupePrefix(
    client: PoolClient,
    actor: TrustedActorContext,
    dedupePrefix: string,
    reason: string,
  ): Promise<number> {
    return this.closeOpenByDedupePrefix(
      client,
      actor,
      dedupePrefix,
      "cancelled",
      reason,
    );
  }

  /**
   * Closes every open task routed to an order without deleting the task fact.
   * This preserves audit history and emits terminal delivery for DingTalk.
   */
  async cancelOpenForReworkOrder(
    client: PoolClient,
    actor: TrustedActorContext,
    reworkOrderId: string,
    reason: string,
  ): Promise<number> {
    const result = await client.query<{ dedupe_key: string }>(
      `SELECT todo.dedupe_key
       FROM rework_todos todo
       LEFT JOIN rework_own_factory_approvals approval
         ON todo.entity_type='own_factory_approval' AND approval.approval_id::text=todo.entity_id
       LEFT JOIN rework_external_responsibility_cases external_case
         ON todo.entity_type='external_responsibility_case' AND external_case.case_id::text=todo.entity_id
       LEFT JOIN rework_responsibility_determinations determination
         ON todo.entity_type='responsibility_determination' AND determination.determination_id::text=todo.entity_id
       WHERE todo.status IN ('pending','blocked_recipient')
         AND (
           todo.route_descriptor->>'reworkOrderId'=$1
           OR (todo.entity_type='rework_order' AND todo.entity_id=$1)
           OR approval.rework_order_id=$1::uuid
           OR external_case.rework_order_id=$1::uuid
           OR determination.rework_order_id=$1::uuid
         )
       ORDER BY todo.created_at,todo.todo_id
       FOR UPDATE OF todo`,
      [reworkOrderId],
    );
    let cancelled = 0;
    for (const row of result.rows) {
      if (await this.closeOpenByDedupeKey(client, actor, row.dedupe_key, "cancelled", reason)) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /**
   * Applies at most one due action using the database clock and the persisted
   * policy row. The caller owns the scheduler cadence; this method owns the
   * durable state transition, audit event and outbox enqueue atomically.
   */
  async scheduleNextTimingInTransaction(
    client: PoolClient,
    actor: TrustedActorContext,
    todoId: string,
  ): Promise<TimedTodoAction | null> {
    if (!(await this.ensureOpenRecipientEligibleInTransaction(client, actor, todoId))) {
      return null;
    }
    const effectiveDue=await this.appliedSlaAvailable(client)?effectiveSourcingDueSql('todo'):'todo.due_at';
    const result = await client.query<TodoRow & {
      due_after_seconds: number | null;
      first_reminder_after_due_seconds: number | null;
      second_reminder_after_due_seconds: number | null;
      escalate_after_due_seconds: number | null;
      max_reminders: number;
      database_now: Date;
    }>(
      `SELECT todo.todo_id,todo.todo_type,todo.category,todo.source_event_id,todo.source_action,
              todo.entity_type,todo.entity_id,todo.recipient_user_id,todo.required_role,
              todo.required_capability,todo.delegation_id,todo.delegation_scope_id,todo.route_descriptor,todo.policy_key,
              ${effectiveDue} AS due_at,todo.reminder_count,todo.status,todo.blocked_reason,todo.version,
              todo.created_at,todo.updated_at,policy.due_after_seconds,
              policy.first_reminder_after_due_seconds,policy.second_reminder_after_due_seconds,
              policy.escalate_after_due_seconds,policy.max_reminders,COALESCE($2::timestamptz,CURRENT_TIMESTAMP) database_now
       FROM rework_todos todo
       JOIN todo_policies policy ON policy.policy_key=todo.policy_key AND policy.enabled=true
       WHERE todo.todo_id=$1 AND todo.status='pending' AND ${effectiveDue} IS NOT NULL
       FOR UPDATE OF todo,policy`,
      [todoId,acceptanceBusinessContext()?businessNow().toISOString():null],
    );
    const todo = result.rows[0];
    if (!todo || !todo.due_at) return null;
    const dueAt = todo.due_at;

    const passed = (seconds: number | null): boolean => seconds !== null
      && todo.database_now.getTime() >= dueAt.getTime() + seconds * 1_000;
    const dueReminder = todo.reminder_count === 0
      ? passed(todo.first_reminder_after_due_seconds)
      : todo.reminder_count === 1 && passed(todo.second_reminder_after_due_seconds);
    const kind: TimedTodoAction["kind"] | null = dueReminder
      && todo.reminder_count < todo.max_reminders
      ? "reminder"
      : passed(todo.escalate_after_due_seconds) && !(await this.isEscalated(client, todo.todo_id))
        ? "escalation"
        : null;
    if (!kind) return null;

    const action = kind === "reminder" ? "todo.remind" : "todo.escalate";
    const eventId = await this.events.append(client, actor, {
      action,
      entityType: "rework_todo",
      entityId: todo.todo_id,
      before: {
        reminderCount: todo.reminder_count,
        ...(kind === "escalation" ? { escalatedAt: null } : {}),
      },
      after: {
        ...(kind === "reminder" ? { reminderCount: todo.reminder_count + 1 } : {}),
        ...(kind === "escalation" ? { escalatedAt: "database_now" } : {}),
      },
    });
    await this.setTodoContext(client, eventId, actor.requestId);
    if (kind === "reminder") {
      await client.query(
        `UPDATE rework_todos
         SET reminder_count=reminder_count+1,last_reminded_at=CURRENT_TIMESTAMP
         WHERE todo_id=$1`,
        [todo.todo_id],
      );
    } else {
      await client.query(
        "UPDATE rework_todos SET escalated_at=CURRENT_TIMESTAMP WHERE todo_id=$1",
        [todo.todo_id],
      );
    }
    if (kind === "reminder") {
      await this.enqueueDelivery(client, todo, eventId, actor.requestId, kind);
    }
    return {
      todoId: todo.todo_id,
      operationEventId: eventId,
      category: todo.category,
      recipientUserId: todo.recipient_user_id,
      route: TodoRouteDescriptorSchema.parse(todo.route_descriptor),
      kind,
    };
  }

  /**
   * Revalidates the recipient immediately before a pending todo is delivered
   * or timed. A business action is never silently reassigned: it becomes
   * blocked and receives a separately audited routing exception. Information
   * and routing-exception todos instead close when their recipient is no
   * longer an active member of the primary DingTalk organisation.
   */
  async ensureOpenRecipientEligibleInTransaction(
    client: PoolClient,
    actor: TrustedActorContext,
    todoId: string,
  ): Promise<boolean> {
    const todo = await this.todoById(client, todoId, true);
    if (todo.status !== "pending") return false;
    if (!(await memberCanReceiveFact(client, todo.recipient_user_id, todo.source_action, todo.entity_type, todo.entity_id))) {
      await this.cancelTodoInTransaction(client, actor, todo, "成员模块权限调整：不再接收此模块待办");
      return false;
    }

    if (todo.todo_type === "information") {
      if (await this.isActivePrimaryOrganizationUser(client, todo.recipient_user_id)) return true;
      await this.cancelTodoInTransaction(
        client,
        actor,
        todo,
        "Information recipient is no longer an active primary-organisation member",
      );
      return false;
    }

    if (todo.todo_type === "recipient_routing_exception") {
      if (await this.isEligibleRecipient(
        client,
        todo.recipient_user_id,
        "production_management",
        "todo:routing_exception_manage",
        undefined,
        todo.delegation_scope_id ?? todo.entity_id,
      )) return true;
      await this.rerouteInvalidRoutingManagerInTransaction(client, actor, todo);
      return false;
    }

    if (!todo.required_role || !todo.required_capability) {
      throw new ApplicationError("INTERNAL_ERROR", "Actionable todo is missing authority facts", 500);
    }
    if (await this.isEligibleRecipient(
      client,
      todo.recipient_user_id,
      todo.required_role,
      todo.required_capability,
      todo.delegation_id ?? undefined,
      todo.delegation_scope_id ?? todo.entity_id,
    )) return true;

    await this.blockInvalidRecipientInTransaction(client, actor, todo, {
      reason: todo.delegation_id
        ? "recipient_delegation_no_longer_active"
        : "recipient_no_longer_directly_eligible",
      assignedToUserId: await this.uniqueRoutingManager(client),
    });
    return false;
  }

  /**
   * Information todos become complete when DingTalk acknowledges delivery.
   * The completion reuses the immutable delivery event's actor snapshot only
   * for audit attribution; it does not grant a business-action capability.
   */
  async completeInformationAfterSuccessfulDeliveryInTransaction(
    client: PoolClient,
    todoId: string,
    deliveryEventId: string,
    deliveryRequestId: string,
  ): Promise<boolean> {
    const result = await client.query<TodoRow & { created_operation_event_id: string }>(
      `SELECT todo_id,todo_type,category,source_event_id,source_action,entity_type,entity_id,
              recipient_user_id,required_role,required_capability,delegation_id,delegation_scope_id,route_descriptor,
              policy_key,due_at,reminder_count,status,blocked_reason,version,created_at,updated_at,
              created_operation_event_id
       FROM rework_todos WHERE todo_id=$1 FOR UPDATE`,
      [todoId],
    );
    const todo = result.rows[0];
    if (!todo || todo.status !== "pending") return false;
    if (todo.todo_type !== "information" || todo.created_operation_event_id !== deliveryEventId) {
      throw new ApplicationError("CONFLICT", "Only its creation delivery can complete an information todo", 409);
    }
    const source = await client.query<{
      actor_id: string;
      actor_roles: string[];
      authorization_capability: string;
    }>(
      `SELECT actor_id,actor_roles,authorization_capability
       FROM operation_events
       WHERE event_id=$1 AND request_id=$2`,
      [deliveryEventId, deliveryRequestId],
    );
    const actor = source.rows[0];
    if (!actor) {
      throw new ApplicationError("CONFLICT", "Information delivery event is missing its trusted actor", 409);
    }
    const completionEventId = await this.events.append(client, {
      actorId: actor.actor_id,
      actorRoles: actor.actor_roles,
      authorizationCapability: actor.authorization_capability,
      requestId: deliveryRequestId,
    }, {
      action: "todo.complete",
      entityType: "rework_todo",
      entityId: todo.todo_id,
      before: { status: "pending", deliveryEventId },
      after: { status: "completed", deliveryEventId },
      reason: "Information notification was acknowledged by DingTalk",
    });
    await this.setTodoContext(client, completionEventId, deliveryRequestId);
    await client.query(
      `UPDATE rework_todos
       SET status='completed',completed_at=CURRENT_TIMESTAMP,completed_by=$2,
           completed_operation_event_id=$3
       WHERE todo_id=$1`,
      [todo.todo_id, actor.actor_id, completionEventId],
    );
    return true;
  }

  async completeOpenByDedupePrefix(
    client: PoolClient,
    actor: TrustedActorContext,
    dedupePrefix: string,
    reason: string,
  ): Promise<number> {
    return this.closeOpenByDedupePrefix(
      client,
      actor,
      dedupePrefix,
      "completed",
      reason,
    );
  }

  private async closeOpenByDedupePrefix(
    client: PoolClient,
    actor: TrustedActorContext,
    dedupePrefix: string,
    status: "completed" | "cancelled",
    reason: string,
  ): Promise<number> {
    const result = await client.query<{ dedupe_key: string }>(
      `SELECT dedupe_key
       FROM rework_todos
       WHERE dedupe_key LIKE $1 ESCAPE '\\'
         AND status IN ('pending','blocked_recipient')
       ORDER BY todo_id
       FOR UPDATE`,
      [`${dedupePrefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`],
    );
    let closed = 0;
    for (const row of result.rows) {
      if (await this.closeOpenByDedupeKey(client, actor, row.dedupe_key, status, reason)) {
        closed += 1;
      }
    }
    return closed;
  }

  private async blockInvalidRecipientInTransaction(
    client: PoolClient,
    actor: TrustedActorContext,
    todo: TodoRow,
    routing: NonNullable<CreateTodoInTransactionInput["invalidRecipientRouting"]>,
  ): Promise<void> {
    const eventId = await this.events.append(client, actor, {
      action: "todo.recipient_blocked",
      entityType: "rework_todo",
      entityId: todo.todo_id,
      before: { recipientUserId: todo.recipient_user_id, status: "pending" },
      after: { recipientUserId: todo.recipient_user_id, status: "blocked_recipient" },
      reason: routing.reason.trim(),
    });
    await this.setTodoContext(client, eventId, actor.requestId);
    await client.query(
      `UPDATE rework_todos
       SET status='blocked_recipient',blocked_at=CURRENT_TIMESTAMP,blocked_reason=$2
       WHERE todo_id=$1`,
      [todo.todo_id, routing.reason.trim()],
    );
    await this.createRoutingExceptionForBlockedTodo(
      client,
      actor,
      todo,
      routing,
      eventId,
    );
  }

  private async createRoutingExceptionForBlockedTodo(
    client: PoolClient,
    actor: TrustedActorContext,
    todo: TodoRow,
    routing: NonNullable<CreateTodoInTransactionInput["invalidRecipientRouting"]>,
    blockedEventId: string,
  ): Promise<void> {
    const routingExceptionId = randomUUID();
    const routingTodoId = randomUUID();
    await client.query(
      `INSERT INTO todo_recipient_routing_exceptions(
         routing_exception_id,todo_id,routing_todo_id,original_recipient_user_id,assigned_to_user_id,reason,
         created_operation_event_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        routingExceptionId, todo.todo_id, routingTodoId, todo.recipient_user_id,
        routing.assignedToUserId, routing.reason.trim(), blockedEventId,
      ],
    );
    const routingTodoCreationEventId = await this.events.append(client, actor, {
      action: "todo.create",
      entityType: "rework_todo",
      entityId: routingTodoId,
      after: { routingExceptionId, originalTodoId: todo.todo_id },
    });
    await this.setTodoContext(client, routingTodoCreationEventId, actor.requestId);
    const route = TodoRouteDescriptorSchema.parse({
      ...TodoRouteDescriptorSchema.parse(todo.route_descriptor),
      todoId: routingTodoId,
    });
    const routingTodo = await client.query<TodoRow>(
      `INSERT INTO rework_todos(
         todo_id,todo_type,category,source_event_id,source_action,entity_type,entity_id,
         recipient_user_id,required_role,required_capability,delegation_scope_id,route_descriptor,policy_key,due_at,
         dedupe_key,created_operation_event_id,created_request_id
       ) VALUES(
         $1,'recipient_routing_exception','recipient_routing_exception',$2,'todo.recipient_blocked',$3,$4,
         $5,'production_management','todo:routing_exception_manage',$6,$7,'general',
         CURRENT_TIMESTAMP + (
           SELECT policy.due_after_seconds * interval '1 second'
           FROM todo_policies policy WHERE policy.policy_key='general' AND policy.enabled=true
         ),
         $8,$9,$10
       ) RETURNING todo_id,todo_type,category,source_event_id,source_action,entity_type,entity_id,
                   recipient_user_id,required_role,required_capability,delegation_scope_id,route_descriptor,policy_key,
                   due_at,reminder_count,status,blocked_reason,version,created_at,updated_at`,
      [
        routingTodoId, blockedEventId, todo.entity_type, todo.entity_id,
        routing.assignedToUserId, todo.delegation_scope_id, route,
        // A previous routing todo may have been cancelled because its manager
        // became ineligible. Keep that immutable history and give the
        // replacement a new dedupe identity tied to this blocked-event fact.
        `todo:${todo.todo_id}:routing-exception:${blockedEventId}`,
        routingTodoCreationEventId,
        actor.requestId,
      ],
    );
    const routingTodoRow = routingTodo.rows[0];
    if (!routingTodoRow) throw new ApplicationError("INTERNAL_ERROR", "Routing exception todo was not created", 500);
    await this.enqueueDelivery(client, routingTodoRow, routingTodoCreationEventId, actor.requestId, "create");
  }

  private async closeOpenByDedupeKey(
    client: PoolClient,
    actor: TrustedActorContext,
    dedupeKey: string,
    status: "completed" | "cancelled",
    reason: string,
  ): Promise<boolean> {
    const result = await client.query<Pick<TodoRow, "todo_id" | "status">>(
      `SELECT todo_id,status
       FROM rework_todos
       WHERE dedupe_key=$1
       FOR UPDATE`,
      [dedupeKey],
    );
    const candidate = result.rows[0];
    if (!candidate || (candidate.status !== "pending" && candidate.status !== "blocked_recipient")) {
      return false;
    }
    const todo = await this.todoById(client, candidate.todo_id, true);
    const action = status === "completed" ? "todo.complete" : "todo.cancel";
    const eventId = await this.events.append(client, actor, {
      action,
      entityType: "rework_todo",
      entityId: todo.todo_id,
      before: { status: todo.status },
      after: { status },
      reason,
    });
    await this.setTodoContext(client, eventId, actor.requestId);
    if (status === "completed") {
      await client.query(
        `UPDATE rework_todos
         SET status='completed',completed_at=CURRENT_TIMESTAMP,completed_by=$2,
             completed_operation_event_id=$3
         WHERE todo_id=$1`,
        [todo.todo_id, actor.actorId, eventId],
      );
      if (todo.status === "blocked_recipient") {
        await this.cancelPendingRoutingExceptionForTodo(client, actor, todo.todo_id, reason);
      }
    } else {
      await client.query(
        `UPDATE rework_todos
         SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,
             cancelled_reason=$2,cancelled_operation_event_id=$3
         WHERE todo_id=$1`,
        [todo.todo_id, reason, eventId],
      );
      if (todo.status === "blocked_recipient") {
        await this.cancelPendingRoutingExceptionForTodo(client, actor, todo.todo_id, reason);
      }
    }
    await this.enqueueDelivery(client, todo, eventId, actor.requestId, "complete");
    return true;
  }

  private async cancelTodoInTransaction(
    client: PoolClient,
    actor: TrustedActorContext,
    todo: TodoRow,
    reason: string,
  ): Promise<void> {
    const eventId = await this.events.append(client, actor, {
      action: "todo.cancel",
      entityType: "rework_todo",
      entityId: todo.todo_id,
      before: { status: todo.status },
      after: { status: "cancelled" },
      reason,
    });
    await this.setTodoContext(client, eventId, actor.requestId);
    await client.query(
      `UPDATE rework_todos
       SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,
           cancelled_reason=$2,cancelled_operation_event_id=$3,
           blocked_at=NULL,blocked_reason=NULL
       WHERE todo_id=$1`,
      [todo.todo_id, reason, eventId],
    );
    await this.enqueueDelivery(client, todo, eventId, actor.requestId, "complete");
  }

  private async cancelPendingRoutingExceptionForTodo(
    client: PoolClient,
    actor: TrustedActorContext,
    todoId: string,
    reason: string,
  ): Promise<void> {
    const result = await client.query<{
      routing_exception_id: string;
      routing_todo_id: string;
      status: "pending" | "resolved" | "cancelled";
    }>(
      `SELECT routing_exception_id,routing_todo_id,status
       FROM todo_recipient_routing_exceptions
       WHERE todo_id=$1 AND status='pending'
       FOR UPDATE`,
      [todoId],
    );
    const exception = result.rows[0];
    if (!exception) return;
    const routingTodo = await this.todoById(client, exception.routing_todo_id, true);
    if (routingTodo.status !== "pending" && routingTodo.status !== "blocked_recipient") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "Pending routing exception lacks an open routing todo", 409);
    }
    const eventId = await this.events.append(client, actor, {
      action: "todo.cancel",
      entityType: "rework_todo",
      entityId: routingTodo.todo_id,
      before: { status: routingTodo.status, routingExceptionId: exception.routing_exception_id },
      after: { status: "cancelled", routingExceptionId: exception.routing_exception_id },
      reason,
    });
    await this.setTodoContext(client, eventId, actor.requestId);
    await client.query(
      `UPDATE rework_todos
       SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,
           cancelled_reason=$2,cancelled_operation_event_id=$3,
           blocked_at=NULL,blocked_reason=NULL
       WHERE todo_id=$1`,
      [routingTodo.todo_id, reason, eventId],
    );
    await client.query(
      `UPDATE todo_recipient_routing_exceptions
       SET status='cancelled',resolution_reason=$2,cancelled_operation_event_id=$3
       WHERE routing_exception_id=$1`,
      [exception.routing_exception_id, reason, eventId],
    );
    await this.enqueueDelivery(client, routingTodo, eventId, actor.requestId, "complete");
  }

  private async rerouteInvalidRoutingManagerInTransaction(
    client: PoolClient,
    actor: TrustedActorContext,
    routingTodo: TodoRow,
  ): Promise<void> {
    const exception = await client.query<RoutingExceptionRow>(
      `SELECT routing_exception_id,todo_id,routing_todo_id,assigned_to_user_id,
              original_recipient_user_id,created_operation_event_id,status
       FROM todo_recipient_routing_exceptions
       WHERE routing_todo_id=$1 AND status='pending'
       FOR UPDATE`,
      [routingTodo.todo_id],
    );
    const row = exception.rows[0];
    if (!row) {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "Routing todo has no pending routing exception", 409);
    }
    await this.cancelPendingRoutingExceptionForTodo(
      client,
      actor,
      row.todo_id,
      "Routing manager is no longer an active direct production-management recipient",
    );
    const original = await this.todoById(client, row.todo_id, true);
    if (original.status !== "blocked_recipient") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "Routing exception original todo is no longer blocked", 409);
    }
    const reblockedEventId = await this.events.append(client, actor, {
      action: "todo.recipient_blocked",
      entityType: "rework_todo",
      entityId: original.todo_id,
      before: { recipientUserId: original.recipient_user_id, status: "blocked_recipient" },
      after: { recipientUserId: original.recipient_user_id, status: "blocked_recipient" },
      reason: "A replacement routing exception is required because its manager became ineligible",
    });
    await this.setTodoContext(client, reblockedEventId, actor.requestId);
    await this.createRoutingExceptionForBlockedTodo(client, actor, original, {
      reason: "routing_manager_no_longer_directly_eligible",
      assignedToUserId: await this.uniqueRoutingManager(client),
    }, reblockedEventId);
  }

  private async enqueueDelivery(
    client: PoolClient,
    todo: TodoRow,
    operationEventId: string,
    operationRequestId: string,
    deliveryKind: "create" | "complete" | "reminder" | "escalation" | "information",
  ): Promise<void> {
    const context=acceptanceBusinessContext();
    if(context){
      await assertAcceptanceAssignee(todo.recipient_user_id);
      await client.query(`INSERT INTO acceptance_sla_clock_receipts(receipt_id,scenario_id,native_kind,native_event_id,recipient_id,business_time,details_json)
        VALUES($1,$2,'todo',$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[randomUUID(),context.scenarioId,operationEventId,todo.recipient_user_id,context.time.now,JSON.stringify({kind:deliveryKind,todoId:todo.todo_id})]);
      return;
    }
    if (todo.route_descriptor.routeName === "digital_production_task" || await digitalTodoTarget(client, TodoRouteDescriptorSchema.parse(todo.route_descriptor))) return;
    // Version-bound transfer contract tasks (including their routing exceptions) are in-system only.
    if (todo.route_descriptor.transferContract || todo.route_descriptor.contractReturn) return;
    const outboxEventId = await this.outbox.enqueue(client, {
      topic: TODO_DELIVERY_TOPIC,
      aggregateType: "rework_todo",
      aggregateId: todo.todo_id,
      payload: {
        todoId: todo.todo_id,
        recipientUserId: todo.recipient_user_id,
        category: todo.category,
        deliveryKind,
        route: TodoRouteDescriptorSchema.parse(todo.route_descriptor),
        operationEventId,
        operationRequestId,
      },
      recipientKey: `user:${todo.recipient_user_id}`,
      idempotencyKey: `todo:${todo.todo_id}:delivery:${operationEventId}`,
    });
    await this.setTodoContext(client, operationEventId, operationRequestId);
    await client.query(
      `INSERT INTO todo_delivery_attempts(
         delivery_attempt_id,todo_id,message_outbox_event_id,attempt_no,delivery_kind,
         provider,outcome,operation_event_id,operation_request_id
       ) VALUES($1,$2,$3,0,$4,'dingtalk','queued',$5,$6)`,
      [randomUUID(), todo.todo_id, outboxEventId, deliveryKind, operationEventId, operationRequestId],
    );
  }

  private async isEscalated(client: PoolClient, todoId: string): Promise<boolean> {
    const result = await client.query<{ escalated_at: Date | null }>(
      "SELECT escalated_at FROM rework_todos WHERE todo_id=$1 FOR KEY SHARE",
      [todoId],
    );
    return result.rows[0]?.escalated_at !== null;
  }

  private async isEligibleRecipient(
    client: PoolClient,
    recipientUserId: string,
    role: string,
    capability: string,
    delegationId: string | undefined,
    reworkOrderId: string,
  ): Promise<boolean> {
    // Existing board execution todos keep their historical routing facts. Their
    // current eligibility follows the separate board role after the role split.
    const effectiveRole = role === "worker" && capability === "pattern_room:orders:complete" ? "pattern_room_worker" : role;
    const result = await client.query<{ eligible: boolean }>(
      `SELECT CASE
         WHEN $4::uuid IS NULL THEN todo_user_has_direct_role($1::uuid,$2::text,$3::text)
         ELSE EXISTS(
           SELECT 1
           FROM delegated_authorizations delegation
           JOIN app_users grantee
             ON grantee.id=delegation.grantee_user_id AND grantee.enabled=true
           JOIN identity_mappings identity
             ON identity.user_id=grantee.id AND identity.provider='dingtalk'
            AND identity.active=true AND identity.employed=true
           JOIN access_security_policy policy
             ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
           JOIN user_role_assignments grantor_assignment
             ON grantor_assignment.user_id=delegation.grantor_user_id
            AND grantor_assignment.role_code=$2
            AND grantor_assignment.revoked_at IS NULL
           WHERE delegation.delegation_id=$4::uuid
             AND delegation.grantee_user_id=$1
             AND delegation.capability=$3
             AND delegation.revoked_at IS NULL
             AND CURRENT_TIMESTAMP BETWEEN delegation.valid_from AND delegation.valid_until
             AND delegation.scope_type='rework_order' AND delegation.scope_id=$5
             AND todo_user_has_direct_role(delegation.grantor_user_id,$2,$3)
         )
       END AS eligible`,
      [recipientUserId, effectiveRole, capability, delegationId ?? null, reworkOrderId],
    );
    return result.rows[0]?.eligible === true;
  }

  private async isActivePrimaryOrganizationUser(
    client: PoolClient,
    userId: string,
  ): Promise<boolean> {
    const result = await client.query<{ active: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM app_users user_record
         JOIN identity_mappings identity
           ON identity.user_id=user_record.id AND identity.provider='dingtalk'
          AND identity.active=true AND identity.employed=true
         JOIN access_security_policy policy
           ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
         WHERE user_record.id=$1 AND user_record.enabled=true
       ) AS active`,
      [userId],
    );
    return result.rows[0]?.active === true;
  }

  private async uniqueRoutingManager(client: PoolClient): Promise<string> {
    const managers = await client.query<{ user_id: string }>(
      `SELECT DISTINCT assignment.user_id
       FROM user_role_assignments assignment
       WHERE assignment.role_code='production_management'
         AND assignment.revoked_at IS NULL
         AND todo_user_has_direct_role(
           assignment.user_id,'production_management','todo:routing_exception_manage'
         )
       ORDER BY assignment.user_id
       LIMIT 2`,
    );
    if (managers.rows.length !== 1) {
      throw new ApplicationError(
        "CONFLICT",
        "Recipient revalidation requires one direct production-management routing owner",
        409,
      );
    }
    return managers.rows[0]!.user_id;
  }

  private async todoById(client: PoolClient, todoId: string, lock = false): Promise<TodoRow> {
    const result = await client.query<TodoRow>(
      `SELECT todo_id,todo_type,category,source_event_id,source_action,entity_type,entity_id,
              recipient_user_id,required_role,required_capability,delegation_id,delegation_scope_id,route_descriptor,policy_key,
              due_at,reminder_count,status,blocked_reason,version,created_at,updated_at
       FROM rework_todos WHERE todo_id=$1${lock ? " FOR UPDATE" : ""}`,
      [todoId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "Todo was not found", 404);
    return row;
  }

  private ensureMatchingExisting(
    todo: ExistingTodoRow,
    input: CreateTodoInTransactionInput,
  ): TodoResponse {
    const same = todo.todo_type === input.todoType
      && todo.source_event_id === input.sourceEventId
      && todo.source_action === input.sourceAction
      && todo.entity_type === input.entityType
      && todo.entity_id === input.entityId
      && todo.recipient_user_id === input.recipientUserId
      && todo.required_role === (input.requiredRole ?? null)
      && todo.required_capability === (input.requiredCapability ?? null)
      && todo.delegation_id === (input.delegationId ?? null)
      && todo.delegation_scope_id === (input.todoType === "information" ? null : (input.delegationScopeId ?? input.entityId));
    if (!same) {
      throw new ApplicationError("IDEMPOTENCY_CONFLICT", "Todo dedupe key was reused with different semantics", 409);
    }
    return todoResponse(todo);
  }

  private requireCapability(
    actor: TrustedActorContext,
    capability: string,
    requiredRole?: string,
  ): void {
    if (
      actor.authorizationCapability !== capability
      || !actor.actorRoles.length
      || !actor.authorizationCapabilities?.includes(capability)
      || (requiredRole && !actor.actorRoles.includes(requiredRole))
    ) {
      throw new ApplicationError("FORBIDDEN", "Current actor lacks todo capability", 403);
    }
  }

  private async setTodoContext(
    client: PoolClient,
    operationEventId: string,
    operationRequestId: string,
  ): Promise<void> {
    await client.query(
      "SELECT set_config('dx_rework.todo_event_id',$1,true),set_config('dx_rework.todo_request_id',$2,true)",
      [operationEventId, operationRequestId],
    );
  }
}

export { TODO_DELIVERY_TOPIC };
