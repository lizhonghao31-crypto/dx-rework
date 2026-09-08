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


export type AnalysisContext={query:SampleAnalysisQuery;draft:AnalysisDraft};
export type AnalysisNavigation=AnalysisContext&{history:AnalysisContext[]};
export type AnalysisNavigationAction=
 |{type:'draft';key:string;value:string}
 |{type:'apply';query:SampleAnalysisQuery}
 |{type:'reset'}
 |{type:'change'|'drill';patch:Partial<SampleAnalysisQuery>}
 |{type:'back'};
export function analysisQueryDraft(query:SampleAnalysisQuery):AnalysisDraft{
 const result:AnalysisDraft={};for(const [key,value] of Object.entries(query))if(!['page','groupPage','group'].includes(key)&&value!==undefined)result[key]=String(value);
 result.brandChoice=query.brandId??(query.brand?'raw:'+query.brand:'');result.departmentChoice=query.departmentId??(query.department?'raw:'+query.department:'');
 delete result.brand;delete result.brandId;delete result.department;delete result.departmentId;return result;
}
export function initialAnalysisNavigation():AnalysisNavigation{return {query:SampleAnalysisQuerySchema.parse({}),draft:{},history:[]};}
export function analysisNavigation(state:AnalysisNavigation,action:AnalysisNavigationAction):AnalysisNavigation{
 if(action.type==='draft')return {...state,draft:{...state.draft,[action.key]:action.value}};
 if(action.type==='reset')return initialAnalysisNavigation();
 if(action.type==='apply')return {query:action.query,draft:state.draft,history:[]};
 if(action.type==='back'){const previous=state.history.at(-1);return previous?{...previous,history:state.history.slice(0,-1)}:state;}
 const patch=action.patch,next={...state.query,page:1,groupPage:1,...patch};
 if('brandId'in patch)delete next.brand;if('brand'in patch)delete next.brandId;
 if('departmentId'in patch)delete next.department;if('department'in patch)delete next.departmentId;
 if('fact'in patch&&!('disposalType'in patch))delete next.disposalType;
 const query=SampleAnalysisQuerySchema.parse(next);
 const history=action.type==='drill'?[...state.history,{query:state.query,draft:state.draft}]:Object.keys(patch).every(key=>key==='page'||key==='groupPage')?state.history:[];
 return {query,draft:analysisQueryDraft(query),history};
}
