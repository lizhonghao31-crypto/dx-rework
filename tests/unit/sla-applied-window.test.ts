import {it,expect} from 'vitest';
import {digitalSlaDefaults,resolveDigitalSlaSnapshot} from '../../packages/contracts/src/digital-sla.js';
import {appliedSlaWindow,type SlaApplication} from '../../apps/api/src/production-platform/sla-applied-window.js';
const base=resolveDigitalSlaSnapshot({version:1,values:digitalSlaDefaults()});
const next=resolveDigitalSlaSnapshot({version:2,values:{...digitalSlaDefaults(),warehouse_preshrink:{kind:'duration',minutes:4320},development_printing:{kind:'duration',minutes:7200},warning_ratio:{kind:'ratio',percent:80}}});
const application:SlaApplication={eventId:'application',snapshotId:'v2',keys:['warehouse_preshrink','warning_ratio','development_printing'],excluded:['task:done'],snapshot:next};
it('changes a selected active window but retains a completed window and the base snapshot',()=>{
 expect(appliedSlaWindow(base,'warehouse_preshrink','task:active',[application]).snapshot.parameters.warehouse_preshrink!.value).toEqual({kind:'duration',minutes:4320});
 expect(appliedSlaWindow(base,'warehouse_preshrink','task:done',[application]).snapshot).toEqual(base);
 expect(base.parameters.warehouse_preshrink!.value).toEqual({kind:'duration',minutes:2160});
});
it('retains trusted exceptions and lets an included end target follow its applied parent window',()=>{
 const exception=structuredClone(base);exception.parameters.warehouse_preshrink={value:{kind:'duration',minutes:3000},source:'order',sourceVersion:1};
 expect(appliedSlaWindow(exception,'warehouse_preshrink','task:active',[application]).snapshot.parameters.warehouse_preshrink).toEqual(exception.parameters.warehouse_preshrink);
 const child=appliedSlaWindow(base,'development_craft_return','task:child',[{...application,keys:['development_printing']}]);
 expect(child.snapshot.parameters.development_printing!.value).toEqual({kind:'duration',minutes:7200});expect(child.snapshot.parameters.development_craft_return!.value).toEqual({kind:'included',minutes:30});
});
