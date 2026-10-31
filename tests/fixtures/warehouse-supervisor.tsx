// Actual application pages and navigation; requests use only isolated TEST fixtures.
import { createRoot } from 'react-dom/client';
import { CuttingOrderDetailSchema, CuttingOrderListItemSchema, PMC_READ_CAPABILITIES } from '@dx-rework/contracts';
import { App } from '../../apps/web/src/App.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const params = new URLSearchParams(location.search), role = params.get('role') ?? sessionStorage.getItem('testRole') ?? 'supervisor';
sessionStorage.setItem('testRole',role);
const recorded = params.get('recorded') === '1', now = '2026-10-13T00:00:00.000Z';
const roles = role === 'pm' ? ['production_management'] : role === 'pmc' ? ['pmc'] : role === 'root' ? ['root_superuser'] : role === 'mixed' ? ['warehouse_supervisor', 'cutting_worker']
  : role === 'receiver' ? ['warehouse_receiver'] : ['warehouse_supervisor'];
const capabilities = role === 'pm' ? [...PMC_READ_CAPABILITIES,'supplier_onboarding:approve','supplier_profile:write','tools:user'] : role === 'pmc' ? [...PMC_READ_CAPABILITIES] : ['receiving:create', 'receiving:packing_manage', 'tools:user',
  ...(role === 'receiver' ? [] : ['cutting:orders:view']), ...(role === 'mixed' ? ['cutting:records:create'] : [])];
const record = { cuttingRecordId: id(8), version: 1, pieceCount: 100, actualCutCount: 2020,
  initialPieceCount: 100, initialActualCutCount: 2020, recordedBy: id(2), recordedByName: 'TEST裁床工人',
  recordedAt: now, corrected: false, cuttingSheetPhotos: [{ attachmentId: id(9), filename: 'TEST裁床单.png', mimeType: 'image/png' }], corrections: [] };
let detail = CuttingOrderDetailSchema.parse({ cuttingOrderId: id(10), sourcingCaseId: id(11), sourcePosition: 1,
  formalStyleNo: 'TEST-WAREHOUSE-READ', alternateStyleNo: null, displayStyleNo: 'TEST-WAREHOUSE-READ',
  styleName: 'TEST只读权限', gender: '女装', color: '蓝', contractNumber: 'TEST合同', contractQuantity: 2020,
  supplierId: id(3), supplierName: 'TEST加工厂', merchandiserId: id(4), merchandiserName: 'TEST跟单',
  deliveryDate: '2026-10-22', cuttingProcess: 'in_house', cuttingProcessOther: null, processes: ['TEST车缝'],
  approvedAt: now, status: recorded ? 'recorded' : 'pending', pieceCount: recorded ? 100 : null,
  actualCutCount: recorded ? 2020 : null, recordedByName: recorded ? 'TEST裁床工人' : null,
  recordedAt: recorded ? now : null, outOfRange: recorded ? false : null, allowedRange: { min: 1919, max: 2121 },
  photos: [], record: recorded ? record : null, canRecord: !recorded && ['mixed', 'root'].includes(role), canCorrect: recorded && role === 'root' });
const requests: unknown[] = [];
Object.assign(window, { warehouseTestRequests: requests });
window.fetch = async (input, init) => {
  const path = String(input), method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  requests.push({ path, method, body });
  if (path.endsWith('auth/me')) return Response.json({ status: 'authorized', user: { id: id(1), displayName: 'TEST仓库账号', isRoot: role === 'root', businessRoles: roles, capabilities } });
  if (method === 'POST' && path.endsWith('/cutting/orders/' + id(10) + '/attachments/upload-intents'))
    return Response.json({ attachmentId: id(9), objectKey: 'TEST/sheet.png', uploadMethod: 'POST', uploadUrl: location.origin + '/__test/upload', uploadFields: {}, expiresAt: now });
  if (method === 'POST' && path.endsWith('/__test/upload')) return new Response(null, { status: 200 });
  if (method === 'POST' && path.endsWith('/attachments/' + id(9) + '/finalize')) return Response.json({ attachmentId: id(9), filename: 'TEST裁床单.png', mimeType: 'image/png', sizeBytes: 128, sha256: 'a'.repeat(64), status: 'ready', createdAt: now });
  if (method === 'POST' && path.endsWith('/cutting/orders/' + id(10) + '/records')) {
    detail = { ...detail, status: 'recorded', pieceCount: 100, actualCutCount: 2020, recordedByName: 'TEST裁床工人', recordedAt: now, outOfRange: false, record, canRecord: false };
    return Response.json({ outcome: 'created', item: detail });
  }
  if (method === 'GET' && path.includes('supplier-onboarding/requests')) {
    const profile = { supplierName:'TEST供应商申请',supplierType:'factory',notes:'TEST只读',supportedCrafts:['车缝'],dailyCapacity:100,contactPerson:'TEST联系人',contactPhone:'123456789',address:'TEST地址',contractEntityName:null,partyBRepresentative:null,payeeName:'TEST收款人',bankAccount:'001234567890',bankName:'TEST银行' };
    const item={requestId:id(30),applicantId:id(4),applicantName:'TEST跟单',supplierName:profile.supplierName,supplierType:'factory',status:'pending_approval',version:1,supplierId:null,createdAt:now,updatedAt:now};
    return Response.json(path.includes('/requests/'+id(30)) ? {...item,profile,versions:[{version:1,profile,submittedAt:now}],decisions:[],duplicateCheck:{formalSupplierCount:0,pendingRequestCount:0,checkedAt:now}} : [item]);
  }
  if (method !== 'GET') return Response.json({ error: { message: 'TEST unexpected mutation' } }, { status: 403 });
  if (path.includes('/cutting/orders/' + id(10))) return Response.json(detail);
  if (path.includes('/cutting/orders')) {
    const item = Object.fromEntries(Object.keys(CuttingOrderListItemSchema.shape).map(key => [key, detail[key as keyof typeof detail]]));
    return Response.json({ items: [item], page: 1, totalPages: 1, totalCount: 1 });
  }
  if (path.includes('/receiving/cutting-options')) return Response.json({ orders: [] });
  if (path.includes('/receiving/board')) return Response.json({ date: '2026-10-13', startDate: '2026-10-13', endDate: '2026-10-13',
    mode: 'range', status: 'all', insights: { pendingCount: 0, missingPackingCount: 0, staleCount: 0 },
    kpis: { orderCount: 0, receivedQuantity: 0, abnormalOrderCount: 0, differenceQuantity: 0, differenceRate: 0 },
    rows: [], page: 1, pageSize: 15, totalCount: 0, totalPages: 1 });
  return Response.json({ error: { message: 'TEST fixture route not mapped' } }, { status: 403 });
};
createRoot(document.getElementById('root')!).render(<App />);
