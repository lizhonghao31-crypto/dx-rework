import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';

export type TechnicalOriginalTarget={kind:'artifact'|'comment';id:string;round:number;version:number;scopeRef:string;inherited:boolean};
export const technicalOriginalKeys=['originalTechnical','originalTechnicalId','originalTechnicalVersion','originalTechnicalScope','originalTechnicalInherited'] as const;
const positive=(value:string|null)=>value&&/^[1-9]\d*$/.test(value)&&Number(value)<=2_147_483_647?Number(value):0;

export function readTechnicalOriginalSearch(search:string):TechnicalOriginalTarget|null|undefined{
 const query=new URLSearchParams(search);
 if(!technicalOriginalKeys.some(key=>query.has(key)))return undefined;
 const [kind,id,version,scopeRef,inherited]=technicalOriginalKeys.map(key=>query.get(key));
 if(technicalOriginalKeys.some(key=>query.getAll(key).length>1)||query.getAll('round').length!==1)return null;
 const exactId=DigitalIdSchema.safeParse(id),exactVersion=positive(version??null),round=positive(query.get('round'));
 if(!exactId.success||!exactVersion||!round||(kind!=='artifact'&&kind!=='comment')||!scopeRef||scopeRef.trim()!==scopeRef||scopeRef.length>100||
  inherited!==null&&(kind!=='artifact'||inherited!=='true'))return null;
 return {kind,id:exactId.data,version:exactVersion,round,scopeRef,inherited:inherited==='true'};
}

export function technicalOriginalHref(sourceId:string,target:TechnicalOriginalTarget){
 const params=new URLSearchParams({development:sourceId,round:String(target.round),originalTechnical:target.kind,
  originalTechnicalId:target.id,originalTechnicalVersion:String(target.version),originalTechnicalScope:target.scopeRef,
  ...(target.inherited?{originalTechnicalInherited:'true'}:{})});
 return readTechnicalOriginalSearch(params.toString())?'/ui/digital-production?'+params:undefined;
}
