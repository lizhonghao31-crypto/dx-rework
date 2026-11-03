import {ResponsibilitySupplierOptionsResponseSchema,type ResponsibilitySupplierOptionsResponse} from '@dx-rework/contracts';

export type ResponsibilitySupplierState =
 | {kind:'idle'|'loading'}
 | {kind:'ready';items:ResponsibilitySupplierOptionsResponse['items']}
 | {kind:'forbidden'|'error';message:string};

/** Only a successful, contract-valid response can mean that no candidates exist. */
export async function loadResponsibilitySuppliers(url:string,signal?:AbortSignal):Promise<ResponsibilitySupplierState>{
 try{
  const response=await fetch(url,{credentials:'include',headers:{accept:'application/json'},signal:signal??null});
  if(response.status===401||response.status===403)return {kind:'forbidden',message:'当前无权读取责任供应商，请核对登录状态及本单责任处理权限。'};
  if(!response.ok)return {kind:'error',message:'责任供应商加载失败，请重试。'};
  const parsed=ResponsibilitySupplierOptionsResponseSchema.safeParse(await response.json());
  if(!parsed.success)return {kind:'error',message:'责任供应商资料暂不可用，请重试；持续失败请联系管理员。'};
  return {kind:'ready',items:parsed.data.items};
 }catch{
  return {kind:'error',message:'责任供应商加载失败，请检查网络后重试。'};
 }
}

export function responsibilitySupplierField(state:ResponsibilitySupplierState,count:number){
 const placeholder=state.kind==='ready'?(count?'选择供应商':'没有可用的该类供应商')
  :state.kind==='forbidden'?'无权读取供应商':state.kind==='error'?'供应商加载失败':'正在加载供应商…';
 return {disabled:state.kind!=='ready',placeholder,emptyText:'没有匹配的供应商'};
}
