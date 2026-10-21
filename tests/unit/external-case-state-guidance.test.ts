import {expect,it,vi} from 'vitest';
import {ExternalResponsibilityService} from '../../apps/api/src/rework/external-responsibility-service.js';
const actor={actorId:'TEST-actor'},current={status:'pending_payables_confirmation',rework_order_id:'TEST-order',responsibility_type:'fabric'};
const guard=Reflect.get(ExternalResponsibilityService.prototype,'requireStatus') as (db:unknown,actor:unknown,current:unknown,expected:string[])=>Promise<void>;
it.each([true,false])('discloses a concrete rejected ledger state only through the original case-read policy (%s)',async permitted=>{
 const query=vi.fn().mockResolvedValue({rows:[{permitted}]});const error=await guard.call({}, {query},actor,current,['deduction_follow_up']).catch(error=>error);expect(error).toMatchObject({statusCode:409,code:'INVALID_STATE_TRANSITION'});expect(query).toHaveBeenCalledWith('SELECT external_responsibility_can_view_case($1,$2,$3) permitted',['TEST-actor','TEST-order','fabric']);expect(error.message).not.toContain('TEST-order');if(permitted)expect(error.message).toContain('待应付确认');else expect(error.message).not.toContain('待应付确认');
});
it('retains the original valid-state path without an extra permission query or any write',async()=>{const query=vi.fn();await guard.call({},{query},actor,current,['pending_payables_confirmation']);expect(query).not.toHaveBeenCalled();});
