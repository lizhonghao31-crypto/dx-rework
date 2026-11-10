import {it,expect} from 'vitest';
import {normalizePackingTime,resolvePackingTime} from '../../apps/api/src/receiving/packing-actual-time.js';
const now='2026-11-09T08:00:00.456Z';
it('records trusted business now only after an explicit choice, preserving old missing timestamps as unknown',()=>{
 expect(resolvePackingTime(undefined,now)).toEqual({precision:'unknown'});
 expect(resolvePackingTime(normalizePackingTime({mode:'unknown'}),now)).toEqual({precision:'unknown'});
 expect(resolvePackingTime(normalizePackingTime({mode:'now'}),now)).toEqual({precision:'instant',at:now});
});
it('preserves date precision without inventing a midnight and normalizes a genuine offset instant',()=>{
 expect(resolvePackingTime(normalizePackingTime({mode:'date',value:'2026-11-08'}),now)).toEqual({precision:'date',date:'2026-11-08'});
 expect(resolvePackingTime(normalizePackingTime({mode:'instant',value:'2026-11-09T15:00:00+08:00'}),now)).toEqual({precision:'instant',at:'2026-11-09T07:00:00.000Z'});
});
it('rejects malformed or future actual dates and times using this business clock',()=>{
 expect(()=>normalizePackingTime({mode:'date',value:'2026-02-30'})).toThrow();
 expect(()=>normalizePackingTime({mode:'now',value:'2026-11-08'})).toThrow();
 expect(()=>resolvePackingTime(normalizePackingTime({mode:'instant',value:'2026-11-09T08:00:00.457Z'}),now)).toThrow();
 expect(()=>resolvePackingTime(normalizePackingTime({mode:'date',value:'2026-11-10'}),now)).toThrow();
});
