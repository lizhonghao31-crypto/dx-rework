import {describe,it,expect} from 'vitest';
import {digitalTaskHistoryKindLabel,digitalTaskHistoryText} from '../../apps/web/src/digital-workspace-copy.js';
describe('history display names preserve original facts',()=>{
 it('names existing lifecycle,hand-off and correction events without exposing an unknown enum',()=>{for(const kind of ['created','ready','completed','condition','time_corrected','policy_changed','pause','resume','cancel','cancelled','blocked','unblocked','reassigned','priority_changed','system_route'])expect(digitalTaskHistoryKindLabel(kind)).not.toBe(kind);for(const kind of ['unrecognized_future_event','constructor','toString','__proto__'])expect(digitalTaskHistoryKindLabel(kind)).toBe('任务记录');});
 it('names only the two known system reason codes and leaves original custom reasons/notes unchanged',()=>{expect(digitalTaskHistoryText('bulk_requirements_changed')).toBe('批准或技术要求已变更，保留原办理记录');expect(digitalTaskHistoryText('new_development_round')).toBe('已由新修改轮次接续，保留原办理记录');for(const text of ['TEST 尾查原退回说明','TEST original note','constructor','toString','__proto__',''])expect(digitalTaskHistoryText(text)).toBe(text);});
});
