import type {QuotationResource} from '@dx-rework/contracts/digital-quotation';
export function quotationHistoryFromSearch(search:string,resource:QuotationResource):{version?:number;error?:string}{
 const q=new URLSearchParams(search);if(!q.has('quoteVersion'))return {};
 const raw=q.get('quoteVersion')??'';
 if(q.getAll('quoteVersion').length!==1||q.get('id')!==resource.id||q.get('kind')!==resource.kind||!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>2147483647)return {error:'所选报价历史版本无效，请从原目录重新进入；不会回落到当前报价'};
 return {version:Number(raw)};
}
