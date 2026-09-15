import { ACCEPTANCE_ROLE_MATRIX } from "../../apps/web/src/acceptance-matrix.js";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canUsePatternPrice } from "@dx-rework/contracts/pattern-room";
import { canUseSampleCapability } from "../../apps/api/src/samples/sample-authority.js";
import { canReadSupplierContactData, canReadSupplierPaymentData, canReadDaxingPrice } from "../../apps/api/src/access/permission-sensitive-field-policy.js";
import { canAccessSamples, canAccessProduction, canAccessProductionReporting } from "../../apps/web/src/platform-modules.js";
import { canAccessPatternRoomPrices } from "../../apps/web/src/pattern-room-access.js";
import { canReadProductionAnalysis } from "../../apps/web/src/production-analysis-model.js";
import { canReadSampleAnalysis } from "../../apps/web/src/sample-analysis-model.js";
import type { AuthorizedUser } from "../../apps/web/src/auth.js";

const capabilities=['sample:view_basic','sample:view_finance','sample:view_audit','sourcing:view','pattern_room:prices:read','pattern_room:catalog:read','pattern_room:misc:quote'];
const user=(role:string):AuthorizedUser=>({id:'read-test',businessRoles:[role],capabilities});
describe('finance business read parity',()=>{
  it('opens the same sample, production and price read entries as the director',()=>{
    for(const check of [canAccessSamples,canAccessProduction,canReadProductionAnalysis,canReadSampleAnalysis,canAccessPatternRoomPrices]) {
      expect(check(user('finance_read'))).toBe(true);expect(check(user('finance_read'))).toBe(check(user('finance_director')));
    }
    expect(canAccessProductionReporting(user('finance_read'))).toBe(false);
  });
  it('keeps sample writes and price changes closed even with forged capabilities',()=>{
    const actor={actorId:'read-test',actorRoles:['finance_read'],authorizationCapability:'sample:create',authorizationCapabilities:[...capabilities,'sample:create','sample:dispose_approve'],requestId:'test'};
    expect(canUseSampleCapability(actor,'sample:view_finance')).toBe(true);
    expect(canUseSampleCapability(actor,'sample:create')).toBe(false);
    expect(canUseSampleCapability(actor,'sample:dispose_approve')).toBe(false);
    expect(canUsePatternPrice(['finance_read'],[...capabilities,'pattern_room:prices:write'],'pattern_room:prices:write')).toBe(false);
    expect(canUseSampleCapability({...actor,actorRoles:['finance_read','sample_finance']},'sample:create')).toBe(true);
    expect(canUsePatternPrice(['finance_read','owner_group'],[...capabilities,'pattern_room:prices:write'],'pattern_room:prices:write')).toBe(true);
  });
  it('matches the director for supplier finance fields and keeps restricted fields hidden',()=>{
    for(const role of ['finance_read','finance_director']) {
      expect(canReadSupplierPaymentData([role],false)).toBe(true);
      expect(canReadSupplierContactData([role],false)).toBe(false);
      expect(canReadDaxingPrice([role],false)).toBe(false);
    }
  });
  it('keeps the live acceptance matrix aligned with approved finance reads and existing write limits',()=>{
    const row=ACCEPTANCE_ROLE_MATRIX.find(entry=>entry.alias==='finance-read')!;
    for(const cap of [...capabilities,'supplier_profile:read','supplier_contract_data:read','rework:finance_nodes:read','wage:settlement_mark']) {
      expect(row.requiredCapabilities).toContain(cap);expect(row.forbiddenCapabilities).not.toContain(cap);
    }
    for(const module of ['rework','sourcing','suppliers','production','samples','finance','pattern_room']) {
      expect(row.allowedModules).toContain(module);expect(row.forbiddenModules).not.toContain(module);
    }
    for(const id of ['sourcing-list','supplier-list','production-dashboard','sample-list','pattern-room-prices']) expect(row.probes!.find(probe=>probe.id===id)?.expectedStatus).toBe(200);
    for(const cap of ['sample:create','external_deduction:special_approve','pattern_room:prices:write','report:export','receiving:export']) expect(row.forbiddenCapabilities).toContain(cap);
    expect(row.ruleRefs!['http:pattern-room-prices'].ruleId).toBe('PERM-ROLE-FINANCE-READ-001');
  });
  it('includes saved legacy closure and follow-up proof in the read-only history',async()=>{
    const source=await readFile('apps/web/src/external-responsibility-panel.tsx','utf8');
    expect(source).toContain('attachmentIds={caseItem.closure.evidenceAttachmentIds}');
    expect(source).toContain('attachmentIds={follow.attachmentIds}');
  });

});
