import {describe,it,expect} from 'vitest';
import {digitalTaskHistoryKindLabel,digitalTaskHistoryText} from '../../apps/web/src/digital-workspace-copy.js';
describe('history display names preserve original facts',()=>{
 it('names existing lifecycle,hand-off and correction events without exposing an unknown enum',()=>{for(const kind of ['created','ready','completed','condition','time_corrected','policy_changed','pause','resume','cancel','cancelled','blocked','unblocked','reassigned','priority_changed','system_route','material_returned'])expect(digitalTaskHistoryKindLabel(kind)).not.toBe(kind);for(const kind of ['unrecognized_future_event','constructor','toString','__proto__'])expect(digitalTaskHistoryKindLabel(kind)).toBe('任务记录');});
 it('keeps the existing material return event explicit',()=>{expect(digitalTaskHistoryKindLabel('material_returned')).toBe('缺项退回');});
 it('names only canonical system-cancel reasons, preserving all user note/reason collisions',()=>{
  const names={'bulk_requirements_changed':'批准或技术要求已变更，保留原办理记录','new_development_round':'已由新修改轮次接续，保留原办理记录'};
  for(const [raw,label] of Object.entries(names)){
   expect(digitalTaskHistoryText('cancelled',{reason:raw},'reason')).toBe(label);
   for(const kind of ['completed','time_corrected','pause','resume','cancel','blocked','unblocked','material_returned','future_event'])for(const field of ['reason','note'] as const)expect(digitalTaskHistoryText(kind,{[field]:raw},field)).toBe(raw);
   expect(digitalTaskHistoryText('cancelled',{note:raw},'note')).toBe(raw);
   for(const context of [{reason:raw,specialClosure:true},{reason:raw,note:'TEST original note'},{reason:raw,futureProvenance:true}])expect(digitalTaskHistoryText('cancelled',context,'reason')).toBe(raw);
  }
  for(const raw of ['TEST 尾查原退回说明','TEST original note','constructor','toString','__proto__',''])expect(digitalTaskHistoryText('cancelled',{reason:raw},'reason')).toBe(raw);
 });
});
