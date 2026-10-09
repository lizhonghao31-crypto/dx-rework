import { describe, expect, it } from "vitest";
import { changePoDate, inheritPoDate, removePoDateOverride } from "../../apps/web/src/po-date-input-defaults.js";
const lines=()=>Array.from({length:3},(_,index)=>({customerWarehouseArrivalDate:null as string|null,factoryDeliveryDate:`2026-11-${10+index}`,color:String(index)}));
describe('PO date entry defaults',()=>{
  it('copies the first date only within its column and preserves later manual exceptions',()=>{
    const rows=changePoDate(lines(),'customerWarehouseArrivalDate',0,'2026-11-20',new Set());
    const manual=changePoDate(rows,'customerWarehouseArrivalDate',1,'2026-11-21',new Set([1]));
    const later=changePoDate(manual,'customerWarehouseArrivalDate',0,'2026-11-22',new Set([1]));
    expect(later.map(row=>row.customerWarehouseArrivalDate)).toEqual(['2026-11-22','2026-11-21','2026-11-22']);
    expect(later.map(row=>row.factoryDeliveryDate)).toEqual(lines().map(row=>row.factoryDeliveryDate));
  });
  it('preserves an explicitly edited PO even when the chosen date equals the default',()=>{
    const rows=changePoDate(lines(),'factoryDeliveryDate',0,'2026-11-10',new Set());
    expect(changePoDate(rows,'factoryDeliveryDate',0,'2026-11-11',new Set([1])).map(row=>row.factoryDeliveryDate)).toEqual(['2026-11-11','2026-11-10','2026-11-11']);
  });
  it('uses the first current date for a new PO without copying the other date column',()=>{
    const first={...lines()[0]!,customerWarehouseArrivalDate:'2026-11-20'};
    expect(inheritPoDate(lines()[1]!,first,'customerWarehouseArrivalDate')).toEqual({...lines()[1]!,customerWarehouseArrivalDate:'2026-11-20'});
    expect(inheritPoDate(lines()[1]!,undefined,'customerWarehouseArrivalDate')).toEqual(lines()[1]);
  });
  it('retains manual overrides on the surviving PO after a row is removed',()=>{
    expect([...removePoDateOverride(new Set([1,2]),1)]).toEqual([1]);
    const rows=lines().slice(1);
    expect(changePoDate(rows,'factoryDeliveryDate',0,'2026-11-15',removePoDateOverride(new Set([2]),0)).map(row=>row.factoryDeliveryDate)).toEqual(['2026-11-15','2026-11-12']);
  });
  it('edits saved independent dates without propagating the first row',()=>{
    expect(changePoDate(lines(),'factoryDeliveryDate',0,'2026-11-09',new Set(),false).map(row=>row.factoryDeliveryDate)).toEqual(['2026-11-09','2026-11-11','2026-11-12']);
  });
});
