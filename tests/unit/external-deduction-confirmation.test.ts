import {describe,expect,it,vi} from "vitest";
import {confirmDeductionException} from "../../apps/web/src/external-deduction-confirmation.js";
const input={amount:6910n,actual:8000n,proposed:14810n,forceSpecial:false};
type Dialogs=Parameters<typeof confirmDeductionException>[1];
const dialogs=()=>({confirmInApp:vi.fn<Dialogs["confirmInApp"]>(async()=>true),promptInApp:vi.fn<Dialogs["promptInApp"]>(async()=>"实际超扣，已核实"),alertInApp:vi.fn<Dialogs["alertInApp"]>(async()=>{})});
describe("actual deduction confirmation",()=>{
  it.each([6000n,6810n])("keeps ordinary and exactly-full deductions on their existing path (%s)",async(amount)=>{
    const ui=dialogs();expect(await confirmDeductionException({...input,amount},ui)).toEqual({kind:"normal"});expect(ui.confirmInApp).not.toHaveBeenCalled();expect(ui.promptInApp).not.toHaveBeenCalled();
  });
  it("shows exact money before obtaining the mandatory over-deduction reason",async()=>{
    const ui=dialogs();expect(await confirmDeductionException(input,ui)).toEqual({kind:"special",reason:"实际超扣，已核实"});
    const message=ui.confirmInApp.mock.calls[0]![0] as string;for(const amount of ["¥69.1","¥149.1","¥148.1","¥1"])expect(message).toContain(amount);
    expect(ui.promptInApp).toHaveBeenCalledWith("请填写超额扣款原因");
  });
  it("cancels before a reason prompt when the real-deduction confirmation is declined",async()=>{
    const ui=dialogs();ui.confirmInApp.mockResolvedValue(false);expect(await confirmDeductionException(input,ui)).toEqual({kind:"cancelled"});expect(ui.promptInApp).not.toHaveBeenCalled();
  });
  it.each([null," ","字".repeat(501)])("cannot submit without a valid confirmed reason",async(reason)=>{
    const ui=dialogs();ui.promptInApp.mockResolvedValue(reason);expect(await confirmDeductionException(input,ui)).toEqual({kind:"cancelled"});
  });
  it("includes unsaved partial deductions in explicit special approval and blocks a zero-difference request",async()=>{
    const ui=dialogs();expect(await confirmDeductionException({...input,amount:1000n,forceSpecial:true},ui)).toMatchObject({kind:"special"});
    expect(ui.promptInApp).toHaveBeenCalledWith("请填写部分扣款原因");
    const exact=dialogs();expect(await confirmDeductionException({...input,amount:6810n,forceSpecial:true},exact)).toEqual({kind:"cancelled"});expect(exact.confirmInApp).not.toHaveBeenCalled();
  });
});
