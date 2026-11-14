// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it} from 'vitest';
import {JourneyReturnContextSchema} from '@dx-rework/contracts/digital-production-journey';
import {matchesCockpitReading,rememberCockpitReading} from '../../apps/web/src/cockpit-reading-context.js';
import {invalidateSession} from '../../apps/web/src/auth-session.js';
let host:HTMLDivElement;
const context=()=>JourneyReturnContextSchema.parse({selected:'00000000-0000-4000-8000-000000000001',expanded:'preparation',focus:'TEST-node-1',row:'TEST-node-1',round:1,nodeView:'active'});
beforeEach(()=>{invalidateSession();host=document.createElement('div');host.innerHTML='<div class="journey-node-viewport"></div>';document.body.append(host);});
afterEach(()=>{host.remove();invalidateSession();});
it('gives a saved reading position priority only for the same order, round and node anchor',()=>{
 const current=context();rememberCockpitReading('TEST-authorized-identity',current,host,true);expect(matchesCockpitReading('TEST-authorized-identity',current)).toBe(true);
 expect(matchesCockpitReading('TEST-authorized-identity',{...current,selected:'00000000-0000-4000-8000-000000000002'})).toBe(false);expect(matchesCockpitReading('TEST-authorized-identity',{...current,round:2})).toBe(false);expect(matchesCockpitReading('TEST-other-identity',current)).toBe(false);
});
it('keeps explicit different-node and different-stage navigation eligible to reveal its requested target',()=>{
 const current=context();rememberCockpitReading('TEST-authorized-identity',current,host,true);expect(matchesCockpitReading('TEST-authorized-identity',{...current,focus:'TEST-node-2',row:'TEST-node-2'})).toBe(false);expect(matchesCockpitReading('TEST-authorized-identity',{...current,expanded:'production'})).toBe(false);expect(matchesCockpitReading('TEST-authorized-identity',{...current,nodeView:'all'})).toBe(false);
});
it('does not suppress initial anchor positioning with an unread placeholder and clears UI memory on session invalidation',()=>{
 const current=context();rememberCockpitReading('TEST-authorized-identity',current,host,false);expect(matchesCockpitReading('TEST-authorized-identity',current)).toBe(false);rememberCockpitReading('TEST-authorized-identity',current,host,true);expect(matchesCockpitReading('TEST-authorized-identity',current)).toBe(true);invalidateSession();expect(matchesCockpitReading('TEST-authorized-identity',current)).toBe(false);
});
it('retains milestone selection independently from all-nodes and never restores another milestone scroll',()=>{
 const current={...context(),milestone:'po:TEST|processing_dispatch'};rememberCockpitReading('TEST-authorized-identity',current,host,true);
 expect(matchesCockpitReading('TEST-authorized-identity',current)).toBe(true);
 expect(matchesCockpitReading('TEST-authorized-identity',{...current,milestone:''})).toBe(false);
});
