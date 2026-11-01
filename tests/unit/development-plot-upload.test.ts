import {describe,it,expect} from 'vitest';
import {createPrivateObjectKey} from '../../apps/api/src/tools/storage.js';
import {validateOpaquePlotContent} from '../../apps/api/src/tools/plot-file-content.js';
import {CreateUploadIntentSchema} from '../../packages/contracts/src/index.js';
describe('scoped opaque CAD originals',()=>{
 it('keeps generic uploads and object names closed toPLT',()=>{
  expect(()=>createPrivateObjectKey('TEST','paper.plt')).toThrow();
  expect(CreateUploadIntentSchema.safeParse({filename:'paper.plt',mimeType:'application/octet-stream',sizeBytes:10,sha256:'a'.repeat(64)}).success).toBe(false);
  expect(createPrivateObjectKey('TEST','paper.PLT',new Date('2026-11-01T00:00:00Z'),{technicalPlot:true})).toMatch(/^TEST\/2026\/11\/01\/[0-9a-f]{48}\.plt$/);
  for(const name of ['../paper.plt','x.exe.plt','x.js.plt','x.html.plt','paper.exe'])expect(()=>createPrivateObjectKey('TEST',name,undefined,{technicalPlot:true})).toThrow();
 });
 it('stores an opaque original without executing it or accepting disguised active files',()=>{
  expect(()=>validateOpaquePlotContent(Buffer.from('IN;SP1;PU0,0;PD100,100;SP0;'))).not.toThrow();
  for(const body of ['', '<html>TEST</html>','MZTEST','%PDF-1.4','PK\x03\x04TEST','#!/bin/sh'])expect(()=>validateOpaquePlotContent(Buffer.from(body))).toThrow();
 });
});
