import {expect,it} from 'vitest';
import {digitalSlaDefaults} from '@dx-rework/contracts/digital-sla';
import {SlaDraftEnvelopeSchema,SlaDraftSavedReplySchema,type SlaSavedDraft} from '@dx-rework/contracts/sla-settings-drafts';
import {mergeSavedSettings,settingsDraftEqual} from '../../apps/web/src/use-sla-saved-draft.js';

const makeDraft=():Extract<SlaSavedDraft,{group:'unified'}>=>({group:'unified',revision:2,expectedVersion:1,reason:'TEST own changes',savedAt:'2026-11-07T00:00:00Z',values:digitalSlaDefaults(),baselineValues:digitalSlaDefaults()});
it('rebases only the author changes against the server baseline and keeps unrelated new published fields',()=>{
 const draft=makeDraft(),current=digitalSlaDefaults();draft.values.development_pattern={kind:'duration',minutes:2520};current.development_pattern={kind:'duration',minutes:3240};current.bulk_cutting={kind:'duration',minutes:1500};const before=structuredClone({draft,current});
 const result=mergeSavedSettings(current,draft);expect(result.development_pattern).toEqual(draft.values.development_pattern);expect(result.bulk_cutting).toEqual(current.bulk_cutting);expect({draft,current}).toEqual(before);
});
it('retains an explicit zero buffer rather than treating it as a missing saved input',()=>{
 const draft=makeDraft();draft.baselineValues.stage_buffer={kind:'buffer',minutes:120};draft.values.stage_buffer={kind:'buffer',minutes:0};const current=digitalSlaDefaults();current.stage_buffer={kind:'buffer',minutes:240};expect(mergeSavedSettings(current,draft).stage_buffer).toEqual({kind:'buffer',minutes:0});
});
it('merges independent development cycle fields without copying an old untouched period over a new one',()=>{
 const baseline={normalDays:7,urgentDays:5,sizeReviewHours:24,externalWashDays:3},draft:SlaSavedDraft={group:'development',revision:1,expectedVersion:1,reason:'TEST development',savedAt:'2026-11-07T00:00:00Z',baselineValues:baseline,values:{...baseline,normalDays:8}};
 expect(mergeSavedSettings({...baseline,sizeReviewHours:36},draft)).toEqual({...baseline,normalDays:8,sizeReviewHours:36});
});
it('compares nested draft contents independently of JSON object key insertion order',()=>{expect(settingsDraftEqual({a:{kind:'duration',minutes:60},b:0},{b:0,a:{minutes:60,kind:'duration'}})).toBe(true);expect(settingsDraftEqual({b:0},{b:null})).toBe(false);});
it('rejects a draft presented as belonging to the other settings category',()=>{expect(SlaDraftEnvelopeSchema.safeParse({group:'development',currentStandardVersion:1,revision:2,draft:makeDraft()}).success).toBe(false);});
it('rejects a saved acknowledgement falsely described as the newest draft',()=>{expect(SlaDraftSavedReplySchema.safeParse({saved:makeDraft(),currentRevision:3,currentStandardVersion:1,superseded:false}).success).toBe(false);});
