import {useEffect,useRef,useState,type SetStateAction} from "react";
import type {SourcingCaseSummary} from "@dx-rework/contracts";
import {createSourcingPriceInput} from "./sourcing-price-input.js";
import {applySourcingPriceCascade} from "./sourcing-price-cascade.js";

export type LinePriceDraft=Readonly<{position:number;unitPrice:string}>;
export type QuoteDraft=Readonly<{linePrices:readonly LinePriceDraft[];quoteReason:string}>;
export type DecisionDraft=Readonly<{supplierId:string;linePrices:readonly LinePriceDraft[];decisionReason:string;cuttingProcess:""|"in_house"|"outsourced"|"other";cuttingProcessOther:string}>;
export type FactoryChangeDraft=Readonly<{supplierId:string;unitPrice:string;changeReason:string;deliveryDate?:string|undefined}>;
type Prices={quote:QuoteDraft;decision:DecisionDraft;processes:string[];transfer:FactoryChangeDraft};
type Kind=keyof Prices;
const defaults=(item?:SourcingCaseSummary|null):Prices=>({
  quote:{linePrices:item?.lineItems.map(line=>({position:line.position,unitPrice:""}))??[],quoteReason:""},
  decision:{supplierId:item?.decision?.supplierId??"",linePrices:item?.lineItems.map(line=>({position:line.position,
    unitPrice:item.decision?.linePrices.find(price=>price.position===line.position)?.unitPrice
      ||item.ieQuote?.linePrices.find(price=>price.position===line.position)?.unitPrice||""}))??[],
    decisionReason:"",cuttingProcess:item?.decision?.cuttingProcess??"",cuttingProcessOther:item?.decision?.cuttingProcessOther??""},
  processes:item?.processes.length?[...item.processes]:[""],
  transfer:{supplierId:"",unitPrice:item?.decision?.unitPrice||"",changeReason:""},
});
const apply=<T,>(value:SetStateAction<T>,previous:T):T=>typeof value==="function"?(value as (current:T)=>T)(previous):value;

/** Server defaults and manual proposals have separate owners. Hydration never
 * calls the user-edit functions or replaces an explicitly cleared price. */
export function useSourcingDetailPrices(caseId:string,item:SourcingCaseSummary|null,onEdit:()=>void){
  const [draft,setDraft]=useState<Prices>(()=>defaults()),baseline=useRef(defaults());
  const [hydrated,setHydrated]=useState<string|null>(null);
  const touched=useRef(new Set<Kind>()),controls=useRef(new Map<string,ReturnType<typeof createSourcingPriceInput>>());
  const quoteOverrides=useRef<ReadonlySet<number>>(new Set()),decisionOverrides=useRef<ReadonlySet<number>>(new Set());
  const editNotice=useRef(onEdit);editNotice.current=onEdit;
  const [,notify]=useState(0);

  useEffect(()=>{
    touched.current.clear();controls.current.clear();quoteOverrides.current=new Set();decisionOverrides.current=new Set();
    baseline.current=defaults();setDraft(defaults());setHydrated(null);
  },[caseId]);
  useEffect(()=>{
    if(!item||item.sourcingCaseId!==caseId)return;
    const next=defaults(item);baseline.current=next;setHydrated(caseId);
    setDraft(current=>({
      quote:touched.current.has("quote")?{...current.quote,linePrices:next.quote.linePrices.map(line=>current.quote.linePrices.find(price=>price.position===line.position)??line)}:next.quote,
      decision:touched.current.has("decision")?{...current.decision,linePrices:next.decision.linePrices.map(line=>current.decision.linePrices.find(price=>price.position===line.position)??line)}:next.decision,
      processes:touched.current.has("processes")?current.processes:next.processes,
      transfer:touched.current.has("transfer")?current.transfer:next.transfer,
    }));
  },[caseId,item]);

  const edit=<K extends Kind>(kind:K,value:SetStateAction<Prices[K]>)=>{
    touched.current.add(kind);editNotice.current();
    setDraft(current=>({...current,[kind]:apply(value,current[kind])}));
  };
  const editQuote=(value:SetStateAction<QuoteDraft>)=>edit("quote",value);
  const editDecision=(value:SetStateAction<DecisionDraft>)=>edit("decision",value);
  const editProcesses=(value:SetStateAction<string[]>)=>edit("processes",value);
  const editTransfer=(value:SetStateAction<FactoryChangeDraft>)=>edit("transfer",value);
  const priceInput=(kind:"quote"|"decision",position:number,value:string)=>{
    const key=`${kind}-${position}`;let control=controls.current.get(key);
    if(!control){
      control=createSourcingPriceInput(next=>{
        const overrides=kind==="quote"?quoteOverrides:decisionOverrides;
        const update=(lines:readonly LinePriceDraft[])=>{
          const result=applySourcingPriceCascade(lines,position,next,overrides.current);
          overrides.current=result.independentPositions;return result.linePrices;
        };
        if(kind==="quote")editQuote(current=>({...current,linePrices:update(current.linePrices)}));
        else editDecision(current=>({...current,linePrices:update(current.linePrices)}));
      },()=>notify(value=>value+1));controls.current.set(key,control);
    }
    control.sync(value);return control;
  };
  const confirmed=(...kinds:Kind[])=>{for(const kind of kinds)touched.current.delete(kind);notify(value=>value+1);};
  const dirty=[...touched.current].some(kind=>JSON.stringify(draft[kind])!==JSON.stringify(baseline.current[kind]));
  return {...draft,ready:hydrated===caseId,editQuote,editDecision,editProcesses,editTransfer,priceInput,confirmed,dirty,
    priceComposing:(kind:"quote"|"decision")=>[...controls.current].some(([key,control])=>key.startsWith(kind+"-")&&control.composing)};
}
