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
});
