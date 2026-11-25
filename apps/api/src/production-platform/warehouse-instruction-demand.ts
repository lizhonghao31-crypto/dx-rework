import {createHash} from 'node:crypto';
import type {DevelopmentMaterial} from '@dx-rework/contracts/digital-development';
import type {TechnicalArtifact} from '@dx-rework/contracts/digital-development-technical';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
import type {InstructionDocument} from '@dx-rework/contracts/production-instruction';
import {z} from 'zod';
import {preparationHash,preparationInvestmentScope,type PreparationDB} from './preparation-material-repository.js';
import {warehouseAdoptedDemand} from './warehouse-adopted-demand.js';
import type {WarehouseReceiptBasis} from './warehouse-material-balance.js';

/** Stable original reference for a new sourced instruction row. Existing
 * random row IDs are not retroactively recognized or rewritten. */
export function sourcedInstructionMaterialId(orderId:string,sourceId:string,materialId:string){
 const digits=createHash('sha256').update(JSON.stringify(['warehouse/instruction-material/v1',orderId,sourceId,materialId])).digest('hex');
 return `${digits.slice(0,8)}-${digits.slice(8,12)}-8${digits.slice(13,16)}-8${digits.slice(17,20)}-${digits.slice(20,32)}`;
}

const scopeLines=(lines:DigitalOrder['lines'])=>lines.map(line=>({lineId:line.lineId,pieces:line.sizes.reduce((sum,size)=>sum+size.quantity,0)}));
const uniqueByMaterial=(rows:readonly DevelopmentMaterial[],id:string)=>rows.filter(row=>row.materialId===id);
const demandSchema=z.object({sourceId:z.uuid(),lines:z.array(z.object({lineId:z.uuid(),pieces:z.number().int().positive()})),tracked:z.array(z.uuid()),
 rows:z.array(z.object({instructionMaterialId:z.uuid(),sourceMaterialId:z.uuid(),supplierId:z.uuid().nullable(),fingerprint:z.string(),unit:z.string(),perPiece:z.string()}))});

function originalMaterialCopyMatches(document:InstructionDocument,inherited:InstructionDocument,id:string,accessory:boolean){
 const rows=accessory?document.accessories:document.fabrics,seed=accessory?inherited.accessories:inherited.fabrics;
 const exact=rows.filter(row=>row.id===id),original=seed.filter(row=>row.id===id);
 // PostgreSQL JSON key ordering need not match a fresh TypeScript object.
 const canonical=(value:typeof exact[number])=>('colors' in value?
  [value.name,value.part,Object.entries(value.colors).sort(([a],[b])=>a.localeCompare(b)),value.remarks]:
  [value.name,value.part,value.group,value.garmentColors,value.materialColor,value.category,value.specification,value.consumption,value.remarks]);
 return exact.length===1&&original.length===1&&JSON.stringify(canonical(exact[0]!))===JSON.stringify(canonical(original[0]!));
}

/** Called inside the existing instruction publish transaction. Capture only
 * demand with a stable identity and exact whole-order technical evidence.
 * PO-specific materials without an explicit allocation remain unknown. */
export function captureWarehouseInstructionDemand({order,round,document,inherited,materials,artifact,previousTracked=[]}:{
 order:DigitalOrder;round:number;document:InstructionDocument;inherited:InstructionDocument;
 materials:readonly DevelopmentMaterial[];artifact:TechnicalArtifact;previousTracked?:readonly string[];
}){
 if(!order.sourceId)return null;
 const lines=scopeLines(order.lines);
 if(!lines.length||lines.some(line=>!Number.isSafeInteger(line.pieces)||line.pieces<=0)||new Set(lines.map(line=>line.lineId)).size!==lines.length)return null;
 const present=new Set([...document.fabrics,...document.accessories].map(row=>row.id));
 // A source-linked row that has changed no longer has an exact demand,
 // but also must not fall back to the old unbounded detached-material form.
 const tracked=[...new Set([...previousTracked,...materials.map(material=>sourcedInstructionMaterialId(order.productionOrderId,order.sourceId!,material.materialId))])]
  .filter(id=>present.has(id));
 if(!tracked.length)return null;
 if(artifact.sourceId!==order.sourceId||artifact.roundNumber!==round||artifact.scopeRef!=='整款'||artifact.status!=='published')return {sourceId:order.sourceId,lines,tracked,rows:[]};
 const rows=preparationInvestmentScope(materials).rows.flatMap(row=>{
  const matches=uniqueByMaterial(materials,row[0]);
  if(matches.length!==1||matches[0]!.garmentColor?.trim())return [];
  const use=artifact.body.consumptionRows.filter(item=>item.materialId===row[0]);
  if(use.length!==1||!use[0]!.unit||Number(use[0]!.consumption)<=0)return [];
  const instructionMaterialId=sourcedInstructionMaterialId(order.productionOrderId,order.sourceId!,row[0]);
  if(!originalMaterialCopyMatches(document,inherited,instructionMaterialId,row[1]==='辅料'))return [];
  return [{instructionMaterialId,sourceMaterialId:row[0],supplierId:matches[0]!.supplierReference?.supplierId??null,
   fingerprint:preparationHash(row),unit:use[0]!.unit,perPiece:use[0]!.consumption}];
 });
 return {sourceId:order.sourceId,lines,tracked,rows};
}

export type ActiveWarehouseInstructionDemand={version:number;demand:z.infer<typeof demandSchema>};

/** The caller supplies the already authorized order IDs. Reads only original
 * published rows, never falls forward to newer technical or draft versions. */
export async function readWarehouseInstructionDemands(db:PreparationDB,orderIds:readonly string[]){
 const result=new Map<string,ActiveWarehouseInstructionDemand>();
 if(!orderIds.length)return result;
 const {rows}=await db.query<{order_id:string;version:number;demand:unknown}>(`SELECT d.production_order_id AS order_id,d.published_version AS version,b.basis_json->'warehouseDemand' AS demand
  FROM digital_instruction_documents d
  JOIN digital_instruction_preparation_bases b ON b.production_order_id=d.production_order_id AND b.instruction_version=d.published_version
  JOIN digital_production_orders o ON o.production_order_id=d.production_order_id
  WHERE d.production_order_id=ANY($1::uuid[]) AND o.source_id::text=b.basis_json->'warehouseDemand'->>'sourceId'`,[orderIds]);
 for(const row of rows){const parsed=demandSchema.safeParse(row.demand);if(parsed.success)result.set(row.order_id,{version:row.version,demand:parsed.data});}
 return result;
}

export function demandForWarehouseReceipt(active:ActiveWarehouseInstructionDemand|undefined,basis:WarehouseReceiptBasis,currentLines:readonly {lineId:string;orderQuantity:number}[]){
 if(!active||basis.resource.kind!=='source'||basis.resource.id!==active.demand.sourceId)return null;
 const {version,demand}=active;
 if(currentLines.length!==demand.lines.length||currentLines.some(line=>!demand.lines.some(old=>old.lineId===line.lineId&&old.pieces===line.orderQuantity)))return null;
 const rows=demand.rows.filter(row=>row.sourceMaterialId===basis.materialId&&row.supplierId===basis.supplierId&&row.fingerprint===basis.adoptedRef);
 if(rows.length!==1)return null;
 const row=rows[0]!;
 return warehouseAdoptedDemand({capturedInstructionVersion:version,activeInstructionVersion:version,instructionMaterialId:row.instructionMaterialId,
  boundInstructionMaterialId:row.instructionMaterialId,sourceMaterialId:row.sourceMaterialId,artifactMaterialId:row.sourceMaterialId,
  adoptedLines:demand.lines,lineId:basis.lineId,unit:basis.unit,perPiece:{unit:row.unit,quantity:row.perPiece}});
}
