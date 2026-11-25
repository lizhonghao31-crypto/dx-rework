import {describe, expect, it} from 'vitest';
import {auxiliaryPriceText} from '../../apps/web/src/auxiliary-catalog-price.js';

describe('standalone auxiliary catalog reference price', () => {
 it('distinguishes an unrecorded price from an explicit zero', () => {
  expect(auxiliaryPriceText(undefined)).toBe('未记录');
  expect(auxiliaryPriceText({amount:'0.00', unit:'枚'})).toBe('0 元 / 枚');
 });

 it('uses at most one decimal without changing the saved reference', () => {
  const saved={amount:'12.35',unit:'米'};
  expect(auxiliaryPriceText(saved)).toBe('12.4 元 / 米');
  expect(auxiliaryPriceText({amount:'12.00',unit:'米'})).toBe('12 元 / 米');
  expect(auxiliaryPriceText({amount:'12.50',unit:'米'})).toBe('12.5 元 / 米');
  expect(saved.amount).toBe('12.35');
 });

 it('does not display a positive sub-threshold amount as a zero price', () => {
  expect(auxiliaryPriceText({amount:'0.000001',unit:'枚'})).toBe('<0.1 元 / 枚');
  expect(auxiliaryPriceText({amount:'0.1',unit:'枚'})).toBe('0.1 元 / 枚');
 });
});
