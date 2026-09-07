import {SampleAnalysisQuerySchema,type SampleAnalysisQuery,type SampleAnalysisResponse} from '@dx-rework/contracts';
import type {AuthorizedUser} from './auth.js';
type AnalysisDraft=Record<string,string>;
export function canReadSampleAnalysis(user:Pick<AuthorizedUser,'isRoot'|'businessRoles'|'capabilities'>){return user.isRoot===true||(user.capabilities.includes('sample:view_finance')&&user.businessRoles?.some(r=>['sample_finance','sample_approver','owner_group'].includes(r))===true);}
export function analysisDraftQuery(draft:AnalysisDraft,group:SampleAnalysisQuery['group']='purchaser'){
 const values:Record<string,string|number>={group,page:1,groupPage:1};
 for(const [key,value] of Object.entries(draft))if(value.trim()&&key!=='brandChoice'&&key!=='departmentChoice')values[key]=value.trim();
 for(const kind of ['brand','department']){const choice=draft[kind+'Choice'];if(choice){if(choice.startsWith('raw:'))values[kind]=choice.slice(4);else values[kind+'Id']=choice;}}
 return SampleAnalysisQuerySchema.safeParse(values);
}
export function analysisGroupFilter(group:SampleAnalysisQuery['group'],row:SampleAnalysisResponse['groups'][number]):Partial<SampleAnalysisQuery>{
 const result:Partial<SampleAnalysisQuery>={};
 if(row.person)result[group==='holder'?'holderUserId':'purchaserUserId']=row.person.id;
 if(row.dimension){const d=row.dimension;if(group==='category')result.category=d.id;
  else if(group==='department'){if(d.id.startsWith('raw:'))result.department=d.id.slice(4);else result.departmentId=d.id;}
  else if(group==='brand'||group==='purchaser_brand'){if(d.id.startsWith('raw:'))result.brand=d.id.slice(4);else result.brandId=d.id;}}
 return result;
}
