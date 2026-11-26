import type {AssembledQuotation} from './quotation-assembly.js';

export type ConfirmedIeQuote=Pick<AssembledQuotation,'quote_id'|'version'|'assembly'|'document'|'assignments'|'price_sources'>&{
 workbench_pricing?:unknown;
};

export function confirmedIeBudgetBasis(quote:ConfirmedIeQuote) {
 const assembly=quote.assembly;
 if(!assembly||!Number.isSafeInteger(assembly.sourceVersion)||assembly.sourceVersion<1||
  !Number.isSafeInteger(assembly.roundNumber)||assembly.roundNumber<1)return null;
 const entries=Object.entries(assembly.rows).filter(([,entry])=>entry.kind==='ie');
 if(entries.length!==1||entries[0]![1].sourceRef!=='ie:processing')return null;
 const [rowId]=entries[0]!,rows=quote.document.rows.filter(row=>row.rowId===rowId);
 const row=rows[0],source=quote.price_sources[rowId];
 const assignments=quote.assignments.filter(assignment=>assignment.rowId===rowId);
 const assignment=assignments[0];
 if(rows.length!==1||row?.section!=='外发工序'||row.unit!=='件'||row.consumption!=='1'||assignments.length!==1||
  assignment?.priceRole!=='ie_reviewer'||!assignment.priceAssigneeId||assignment.technicalAssigneeId!==null||
  !source||!Number.isSafeInteger(source.version)||source.version<1||source.version>quote.version||
  !source.actorId||!Number.isFinite(Date.parse(source.recordedAt))||
  source.role!=='root_superuser'&&(source.role!=='ie_reviewer'||source.actorId!==assignment.priceAssigneeId)||
  quote.document.currency!=='人民币')return null;
 // Budget and sourcing publish with two exact decimal places. Strip only
 // insignificant zeros so an unsupported sub-cent quote cannot be rounded.
 const raw=row.unitPrice??'';
 if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(raw))return null;
 const [whole,fraction='']=raw.split('.');
 const decimals=fraction.replace(/0+$/,'');
 if(decimals.length>2||whole==='0'&&!decimals)return null;
 const unitPrice=whole+(decimals?'.'+decimals:'');
 return {quoteId:quote.quote_id,quoteVersion:quote.version,rowId,sourceVersion:assembly.sourceVersion,roundNumber:assembly.roundNumber,
  priceVersion:source.version,actorId:source.actorId,recordedAt:source.recordedAt,unitPrice,unit:'件' as const,currency:'人民币' as const};
}
