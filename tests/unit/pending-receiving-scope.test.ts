import {describe, expect, it} from "vitest";
import {projectPendingReceivingScope,type PendingReceivingIdentity} from "../../apps/api/src/receiving/pending-receiving-scope.js";

const identity = {orderId:"order",productionId:"production",factoryAllocationKey:"factory-a",lineId:"blue-po",cuttingOrderId:"blue-cut"};
const dispatch = (factId: string, scope: PendingReceivingIdentity = identity, kind = "仓库实际发厂", dispatchedQuantity=500) => ({
  factId, identity:scope, kind, actualDispatchedAt:"2026-11-24T02:00:00+08:00",dispatchedQuantity,
});
const receipt = (receiptId: string, actualQuantity: number, changed: Partial<{[K in keyof PendingReceivingIdentity]: string | null}> = {}) => ({
  receiptId, actualQuantity, quantityVersion: `${receiptId}-current`, identity:{...identity, ...changed},
});

describe("X4 receiving quantities from a proven native factory allocation", () => {
  it("keeps 220 pending after a partial receipt and never spends another factory or PO's actual evidence", () => {
    const ownReceipt = receipt("original", 280);
    const result = projectPendingReceivingScope({identity, expectedQuantity:500,
      dispatches:[dispatch("shipment-first",identity,undefined,300),dispatch("shipment-second",identity,undefined,200)], effectiveReceipts:[
        ownReceipt,receipt("other-factory",350,{factoryAllocationKey:"factory-b"}),
        receipt("other-po",100,{lineId:"red-po"}), receipt("other-cut",300,{cuttingOrderId:"blue-cut-2"}),
      ]});
    expect(result).toMatchObject({status:"pending",actualDispatched:500,received:280,remaining:220,difference:-220,receipts:[ownReceipt]});
    expect(result?.dispatches.map(fact=>fact.factId)).toEqual(["shipment-first","shipment-second"]);
  });

  it("does not turn production planning, a different plant, or craft dispatch into pending garments", () => {
    expect(projectPendingReceivingScope({identity,expectedQuantity:500,dispatches:[
      dispatch("engineered",identity,"计划"),dispatch("craft",identity,"裁片发往二次工艺"),
      dispatch("wired",{...identity,factoryAllocationKey:"factory-b"}), {...dispatch("date-only"),actualDispatchedAt:"2026-11-24"},
    ],effectiveReceipts:[]})).toBeNull();
    expect(projectPendingReceivingScope({identity,expectedQuantity:500,dispatches:[],effectiveReceipts:[receipt("legacy",280)]})).toBeNull();
  });

  it("does not infer the historical factory if a possible receipt lacks its decision", () => {
    const proven=receipt("matched",280);
    expect(projectPendingReceivingScope({identity,expectedQuantity:500,dispatches:[dispatch("shipment")],effectiveReceipts:[
      proven,receipt("unassigned",100,{factoryAllocationKey:null}),
    ]})).toMatchObject({status:"unresolved",received:null,provenReceived:280,remaining:null,difference:null,receipts:[proven]});
  });

  it("matches a proven original factory allocation without treating a missing allocation as original", () => {
    const originalFactory={...identity,factoryAllocationKey:"verified-original-allocation"};
    const scope={identity:originalFactory,expectedQuantity:500,dispatches:[dispatch("shipment",originalFactory)]};
    const originalReceipt=receipt("native-original",280,{factoryAllocationKey:originalFactory.factoryAllocationKey});
    expect(projectPendingReceivingScope({...scope,effectiveReceipts:[originalReceipt]})).toMatchObject({status:"pending",received:280,remaining:220});
    expect(projectPendingReceivingScope({...scope,effectiveReceipts:[originalReceipt,receipt("unresolved",100,{factoryAllocationKey:null})]})).toMatchObject({status:"unresolved",received:null,provenReceived:280});
  });

  it("counts a duplicated effective lookup row once, but refuses two incompatible versions of the same receipt", () => {
    const ownReceipt = receipt("original",280);
    const scope={identity,expectedQuantity:500,dispatches:[dispatch("shipment"),dispatch("shipment")]};
    expect(projectPendingReceivingScope({...scope,effectiveReceipts:[ownReceipt,ownReceipt]})).toMatchObject({
      status:"pending",actualDispatched:500,received:280,remaining:220,receipts:[ownReceipt],dispatches:[{factId:"shipment",dispatchedQuantity:500}],
    });
    expect(projectPendingReceivingScope({...scope,effectiveReceipts:[ownReceipt,{...ownReceipt,actualQuantity:300,quantityVersion:"next"}]})).toMatchObject({
      status:"unresolved",received:null,provenReceived:0,remaining:null,receipts:[],
    });
  });

  it("keeps real over-receipt distinct from precise collection and does not count zero as received", () => {
    const scope={identity,expectedQuantity:500,dispatches:[dispatch("shipment")]};
    expect(projectPendingReceivingScope({...scope,effectiveReceipts:[receipt("record-no-actual",0)]})).toMatchObject({status:"pending",received:0,remaining:500});
    expect(projectPendingReceivingScope({...scope,effectiveReceipts:[receipt("partial",280),receipt("append",220)]})).toMatchObject({status:"collected",received:500,remaining:0,difference:0});
    expect(projectPendingReceivingScope({...scope,effectiveReceipts:[receipt("partial",280),receipt("append",240)]})).toMatchObject({status:"over_received",received:520,remaining:0,difference:20});
  });

  it("retains the shipment reference but does not manufacture a missing expected scope quantity", () => {
    expect(projectPendingReceivingScope({identity,expectedQuantity:null,dispatches:[dispatch("shipment")],effectiveReceipts:[]})).toMatchObject({
      status:"unresolved",actualDispatched:500,received:null,provenReceived:0,remaining:null,difference:null,dispatches:[{factId:"shipment",dispatchedQuantity:500}],
    });
  });

  it("keeps actual dispatch quantity separate from the original expected return; a conflicting lot is not summed twice",()=>{
    const first=dispatch("shipment",identity,undefined,300);
    const scope={identity,expectedQuantity:500,effectiveReceipts:[receipt("received",280)]};
    expect(projectPendingReceivingScope({...scope,dispatches:[first]})).toMatchObject({actualDispatched:300,received:280,remaining:220});
    expect(projectPendingReceivingScope({...scope,dispatches:[first,{...first,dispatchedQuantity:310}]})).toMatchObject({status:"unresolved",actualDispatched:null,provenReceived:280,remaining:null});
  });
});
