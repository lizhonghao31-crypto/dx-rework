import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {DevelopmentPrint} from '../../apps/web/src/digital-development-print.js';

const sheet=(garment:'上衣'|'裤子'):DevelopmentSheet=>{
 const document={...initialDevelopmentDocument(garment),templateConfirmed:true as const,
  sizes:['实际尺码'],sizeQuantities:[2],quantity:2,measurements:[{name:'原自定义尺寸',values:['3 1/2']}],orderDate:'2026-11-02',returnDate:'2026-11-28'};
 return {sourceId:'source-exact',designStyleNo:'DX-原款号',numberedIdentity:{orderNumber:'DX-母单身份'},temporaryStyleNo:'不当款号',
  customerCode:'原客户',designerName:'原设计师',developmentType:'头版',version:4,roundNumber:1,status:'published',
  document,publishedAt:'2026-11-20T07:00:00Z',taskId:null,canEdit:false,materialEvents:[]};
};
const html=(value:DevelopmentSheet)=>renderToStaticMarkup(createElement(DevelopmentPrint,{sheet:value,document:value.document!,imageUrl:id=>`/original/${id}`}));

describe('C2 A4 original and adopted feedback are separate documents',()=>{
 it('retains the original style and saved measurements, with distinct trustworthy dates',()=>{
  for(const garment of ['上衣','裤子'] as const){
   const value=sheet(garment);
   value.printTiming={executionRoundId:'own-native-round',dispatchedOn:'2026-11-21',returnedOn:'2026-11-24',dispatchedDocumentVersion:3};
   value.printRevision={sourceRound:2,revisionNumber:6};
   const markup=html(value);
   expect(markup).toContain(garment==='上衣'?'data-garment-layout="top"':'data-garment-layout="trousers"');
   for(const item of ['DX-母单身份','DX-原款号','原自定义尺寸','实际尺码','3 1/2','复版6 · 本单第1轮','2026-11-21','发板依据 v3','2026-11-24','2026-11-28'])expect(markup).toContain(item);
   expect(markup).not.toMatch(/2026-11-02|2026-11-20|data-print-document="客户评语单"/);
  }
 });
 it('prints only the exact adopted image IDs on the independent feedback sheet, in source order',()=>{
  const value=sheet('裤子');
  value.printRevision={sourceRound:3,revisionNumber:1};
  value.printFeedback={text:'第一行\n第二行',sourceRound:3,version:2,images:[
   {attachmentId:'exact-first',url:'/original/exact-first.png',label:'领口标注'},
   {attachmentId:'exact-second',url:'/original/exact-second.png',label:'袖线标注'},
  ]};
  const markup=html(value);
  const cut=markup.indexOf('data-print-document="客户评语单"');
  expect(cut).toBeGreaterThan(markup.indexOf('data-print-document="版单"'));
  const board=markup.slice(markup.indexOf('data-print-document="版单"'),cut),feedback=markup.slice(cut);
  expect(board).not.toMatch(/第一行|第二行|exact-first|exact-second/);
  expect(feedback).toContain('第一行\n第二行');
  expect(feedback).toContain('原开发单第3轮');
  expect(feedback).toContain('复版1 · 本单第1轮');
  expect(feedback.indexOf('exact-first')).toBeLessThan(feedback.indexOf('exact-second'));
 });
 it('prints identified legacy text as a separate sheet, but no text or dates on unpublished versions',()=>{
  const value=sheet('上衣');
  value.document!.rush=true;
  value.printFeedback={text:'原记录独有意见',sourceRound:1};
  expect(html(value)).toContain('原记录未关联评语版本');
  expect(html(value)).toContain('原记录独有意见');
  expect(html(value)).toContain('development-paper-rush');
  value.status='draft';value.printTiming={executionRoundId:'not-this-draft',dispatchedOn:'2026-11-26'};
  expect(html(value)).not.toMatch(/原记录独有意见|2026-11-26|development-paper-rush|data-print-document="客户评语单"/);
 });
 it('does not pass a generated identity through as a separately recorded style',()=>{
  const value=sheet('上衣');
  value.designStyleNo=value.numberedIdentity!.orderNumber!;
  expect(html(value)).toContain('<dt>款号</dt><dd>—</dd>');
  expect(html(value)).toContain('<dt>订单ID</dt><dd>DX-母单身份</dd>');
 });
});
