import {describe,it,expect} from 'vitest';
import {readSupplierWorkspaceQuery,supplierWorkspaceSearch,supplierRequestListPath,supplierRequestReturnPath} from '../../apps/web/src/supplier-workspace-query.js';
const id='11111111-1111-4111-8111-111111111111';
describe('supplier work return context',()=>{
 it('restores selection and real directory filters without changing profile version',()=>{
  const value={q:'TEST厂',type:'factory' as const,status:'inactive' as const,craft:'洗水',completeness:'missing' as const,supplierId:id};
  expect(readSupplierWorkspaceQuery('?'+supplierWorkspaceSearch(value))).toEqual(value);
  expect(readSupplierWorkspaceQuery('?supplierId=invalid').supplierId).toBe('');
  expect(readSupplierWorkspaceQuery('?supplierId='+id+'&supplierId='+id).supplierId).toBe('');
 });
 it('returns to the exact application filter and refuses external or ambiguous targets',()=>{
  expect(supplierRequestListPath('','all')).toBe('/ui/suppliers/requests?status=all');
  const path=supplierRequestListPath('TEST','returned');expect(supplierRequestReturnPath('?'+new URLSearchParams({returnTo:path}))).toBe(path);
  for(const returnTo of ['https://external.example/ui/suppliers/requests','/ui/suppliers/requests?status=returned&status=approved','/ui/suppliers/requests#bad'])expect(supplierRequestReturnPath('?'+new URLSearchParams({returnTo}))).toBeNull();
 });
});
