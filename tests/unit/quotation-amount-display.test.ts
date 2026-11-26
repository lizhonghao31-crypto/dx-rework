import {describe,expect,it} from 'vitest';
import {quotationAmountDisplay} from '../../apps/web/src/quotation-amount-display.js';

describe('quote and budget screen-only monetary display',()=>{
 it.each([['3.00','3'],['3.80','3.8'],['15.80','15.8'],['3.8500','3.9'],['-3.8500','-3.9'],['0.0000001','<0.1'],['-0.0000001','−<0.1'],['0.0000','0'],['','—'],[null,'—']])('formats %s as %s',(amount,display)=>{
  expect(quotationAmountDisplay(amount)).toBe(display);
 });
});
