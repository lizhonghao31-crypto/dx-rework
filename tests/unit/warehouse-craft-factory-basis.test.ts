import {describe,expect,it} from 'vitest';
import type {QuotationAssembly} from '@dx-rework/contracts/digital-quotation';
import {exactBulkCraftQuotationRow} from '../../apps/api/src/production-platform/warehouse-craft-factory-basis.js';

const step={stepId:'actual-step',craftKind:'special' as const,sequence:1,specialCraft:{id:'original-library',name:'TEST actual craft',version:3}};
const reference:QuotationAssembly['rows'][string]={kind:'craft',stage:'bulk',sourceRef:'craft:bulk:special:original-library',basis:'original',
 craftRef:{libraryId:'original-library',libraryVersion:3,stepId:null}};
const assembly=(rows:QuotationAssembly['rows']):QuotationAssembly=>({schemaVersion:1,sourceVersion:1,roundNumber:1,fingerprint:'TEST',rows});

describe('warehouse original bulk craft approval identity',()=>{
 it('recognizes the same bulk craft even if the commercial row predates adoption of its actual step ID',()=>{
  expect(exactBulkCraftQuotationRow(assembly({associated:reference}),step)).toBe('associated');
  expect(exactBulkCraftQuotationRow(assembly({associated:{...reference,craftRef:{...reference.craftRef!,stepId:step.stepId}}}),step)).toBe('associated');
 });
 it('does not choose a development, obsolete, other-step, or duplicate approval',()=>{
  expect(exactBulkCraftQuotationRow(assembly({development:{...reference,stage:'development'},
   stale:{...reference,craftRef:{...reference.craftRef!,libraryVersion:2}},other:{...reference,craftRef:{...reference.craftRef!,stepId:'other'}}}),step)).toBeNull();
  expect(exactBulkCraftQuotationRow(assembly({first:reference,second:reference}),step)).toBeNull();
 });
});
