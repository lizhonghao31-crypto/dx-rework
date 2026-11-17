import {afterEach,expect,it,vi} from 'vitest';
import * as generation from '../../apps/api/src/production-platform/journey-fact-generation.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {JourneyFactUpdates} from '../../apps/api/src/production-platform/journey-fact-updates.js';
afterEach(()=>vi.restoreAllMocks());
it('compatible fallback stops all derived entry points before connections/writes without acknowledging dirty facts',async()=>{
 vi.spyOn(generation,'journeyFactGenerationEnabled').mockReturnValue(false);
 const db={query:vi.fn(()=>{throw Error('Must not touch pending/dirty evidence');}),connect:vi.fn(()=>{throw Error('Must not begin a new build');})};
 const repository=new JourneyFactRepository(db as never),updates=new JourneyFactUpdates(db as never,repository);
 await expect(repository.buildOne({kind:'order',id:'TEST-order'})).rejects.toThrow('JOURNEY_DERIVATION_READ_ONLY_COMPATIBLE');
 await expect(updates.registerBackfill('order:TEST-prior')).resolves.toEqual({registered:0,cursor:'order:TEST-prior',done:true});
 await expect(updates.runOnce()).resolves.toEqual({built:0,retired:0,failed:0,busy:0});
 expect(db.connect).not.toHaveBeenCalled();expect(db.query).not.toHaveBeenCalled();
});
