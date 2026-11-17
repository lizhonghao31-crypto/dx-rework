import {afterEach,describe,expect,it,vi} from 'vitest';
import {digitalSlaDefaults,resolveDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {developmentTaskTiming} from '../../apps/api/src/production-platform/development-task-timing.js';
import {developmentSlaPlan} from '../../apps/api/src/production-platform/development-sla-enrollment.js';
import {developmentDocumentRow} from '../../apps/api/src/production-platform/development-round-repository.js';
vi.mock('../../apps/api/src/production-platform/development-sla-enrollment.js',()=>({developmentSlaPlan:vi.fn()}));
vi.mock('../../apps/api/src/production-platform/development-round-repository.js',()=>({developmentDocumentRow:vi.fn()}));
const snapshot=resolveDigitalSlaSnapshot({version:1,values:digitalSlaDefaults()});
const cut='2026-10-01T00:00:00.000Z';
afterEach(()=>vi.restoreAllMocks());
describe('pattern responsibility from an explicit material predecessor',()=>{
 it.each(['exact','wrong-source','wrong-route','wrong-round','ambiguous','incomplete'])(
  'keeps the declared recheck identity and leaves %s evidence unrated when it cannot prove that edge',async mode=>{
   vi.mocked(developmentSlaPlan).mockResolvedValue({route_nodes:['development_materials','development_pattern'],rule_version:snapshot.ruleVersion,parameters_json:snapshot.parameters,revision:2,configuration_id:'frozen',plan_json:{anchors:{development_published:{value:cut}}}});
   vi.mocked(developmentDocumentRow).mockResolvedValue({document:{craft:'无'},revision:null} as never);
   const at='2026-11-21T04:00:00.000Z',later='2026-11-21T07:00:00.000Z';
   const predecessor={task_id:'recheck',task_kind:'development_material_recheck',source_id:mode==='wrong-source'?'other-source':'source',route_version:mode==='wrong-round'?2:1,route_instance_id:mode==='wrong-route'?'other-route':'route',current_route:'route'};
   const rows=[{task_id:'initial',task_kind:'development_materials',route_version:1,completed_at:cut},{task_id:'later',task_kind:'development_material_recheck',route_version:1,completed_at:later},...(mode==='incomplete'?[]:[{task_id:'recheck',task_kind:'development_material_recheck',route_version:1,completed_at:at}])];
   const db={query:vi.fn(async(sql:string)=>{
    if(sql==='SELECT production_order_id FROM digital_production_orders WHERE source_id=$1')return {rows:[]};
    if(sql.startsWith('SELECT t.task_id,t.route_version,t.completed_at,a.task_kind'))return {rows};
    if(sql.startsWith('SELECT p.task_id,p.route_instance_id'))return {rows:[predecessor,...(mode==='ambiguous'?[{...predecessor,task_id:'later'}]:[])]};
    throw Error('Unexpected pattern timing query: '+sql);
   })};
   const timing=await developmentTaskTiming(db as never,{task_id:'pattern',source_id:'source',task_kind:'development_pattern',route_version:1});
   expect(timing?.enteredAt).toBe(mode==='exact'?at:null);
   expect(timing?.basis).toEqual(mode==='exact'?['task:recheck:completed']:[]);
   expect(timing?.configurationId).toBe('frozen');
  });
});
