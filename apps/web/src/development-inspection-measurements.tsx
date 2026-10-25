import type { DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import type { DevelopmentActualMeasurements } from "@dx-rework/contracts/digital-development-execution";

export function inspectionMeasurementsFromForm(document: DevelopmentDocument, form: FormData): DevelopmentActualMeasurements {
  return document.measurements.filter(row=>row.name.trim()).map((row,index)=>({name:row.name,
    values:document.sizes.map((_,column)=>String(form.get(`actual-size-${index}-${column}`)??""))}));
}
export function DevelopmentInspectionMeasurements({document,phase}:{document:DevelopmentDocument;phase:"洗前"|"洗后"}) {
  return <><p className="development-inspection-label">{phase}实际尺寸（{document.unit}）</p><div className="development-table-scroll development-inspection" role="region" aria-label={`${phase}实际尺寸，可横向查看全部尺码`} tabIndex={0}><table className="development-task-size-table">
    <thead><tr><th>测量部位</th>{document.sizes.map((size,index)=><th key={index}>{size}</th>)}</tr></thead>
    <tbody>{document.measurements.filter(row=>row.name.trim()).map((row,index)=><tr key={index}><th>{row.name}</th>
      {document.sizes.map((size,column)=><td key={column}><input aria-label={`${phase}${row.name} ${size}`} name={`actual-size-${index}-${column}`} inputMode="decimal" required maxLength={32} autoComplete="off"/></td>)}
    </tr>)}</tbody>
  </table></div></>;
}
