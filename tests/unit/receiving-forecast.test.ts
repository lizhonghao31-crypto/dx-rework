import {it,expect} from 'vitest';
import {forecastNetReceipts} from '../../apps/api/src/production-platform/receiving-forecast.js';
const future={key:'factory',expected:500,received:200,arrival:{fromInclusive:'2026-10-24T16:00:00Z',toExclusive:'2026-10-25T16:00:00Z'}};
it('Q1000 R600 adds only 300 unreceived from a 500 shipment already received 200',()=>{
 expect(forecastNetReceipts(1000,600,[future,future],'2026-10-23T00:00:00Z')).toMatchObject({state:'unknown',netExpected:300,reason:'当前依据仍少100件可靠未收预计，不能用已收数量重复补足'});
 expect(forecastNetReceipts(900,600,[future],'2026-10-23T00:00:00Z')).toMatchObject({state:'estimated',netExpected:300});
});
it('does not use an expired estimate or unlinked receipts as reliable future coverage',()=>{
 expect(forecastNetReceipts(900,600,[future],'2026-10-26T00:00:00Z').state).toBe('unknown');
 expect(forecastNetReceipts(900,600,[future],'2026-10-23T00:00:00Z',10).state).toBe('unknown');
});
