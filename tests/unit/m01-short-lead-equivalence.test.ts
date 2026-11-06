import {describe,it,expect} from 'vitest';
import {initialDevelopmentDocument,sameDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {shortLeadDocumentHash} from '../../apps/api/src/production-platform/short-lead-evidence.js';
const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
describe('M01 unchanged document save boundary',()=>{
 it('aligns the form save decision with the original complete approval fingerprint across JSONB object ordering',()=>{const before=initialDevelopmentDocument(),after=reorder(before) as typeof before;expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));expect(shortLeadDocumentHash(before)).toBe(shortLeadDocumentHash(after));expect(sameDevelopmentDocument(before,after)).toBe(true);});
 it('never ignores changed approved fields or array ordering',()=>{const before=initialDevelopmentDocument();for(const patch of [{quantity:2},{interlining:'changed'},{orderDate:'2026-11-06'},{sizes:['S','M']},{instructions:'changed approved technical content'}])expect(sameDevelopmentDocument(before,{...before,...patch})).toBe(false);const withSizes={...before,sizes:['S','M']};expect(sameDevelopmentDocument(withSizes,{...withSizes,sizes:['M','S']})).toBe(false);expect(sameDevelopmentDocument(null,before)).toBe(false);});
});
