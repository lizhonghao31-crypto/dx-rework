import type {JourneyStageKey} from '@dx-rework/contracts/digital-production-journey';

// Category keys describe existing sources, never new tables or completion gates.
export const COCKPIT_DOCUMENT_CATEGORIES=[
 {key:'instruction',label:'大货制单',stage:'preparation',node:'production_instruction'},
 {key:'qc_progress',label:'QC进度、产量与照片',stage:'production',node:'production_reporting'},
 {key:'technical',label:'大货纸样、唛架与尺寸',stage:'preparation',node:'bulk_pattern'},
 {key:'preparation',label:'产前物料、验布与预缩',stage:'preparation',node:'warehouse_preshrink'},
 {key:'cutting',label:'裁床与实裁',stage:'cutting',node:'bulk_cutting'},
 {key:'factory',label:'裁后工艺与仓库发厂',stage:'post_cutting',node:'process_logistics'},
 {key:'receiving',label:'真实回货与成衣QC',stage:'receiving',node:'receipts'},
 {key:'packing',label:'装箱与数量差异',stage:'receiving',node:'packing'},
 {key:'contract',label:'外发合同与回签',stage:'preparation',node:'sourcing_owner'},
 {key:'budget',label:'预算单',stage:'preparation',node:'budget'},
 {key:'quotation',label:'客户报价与确认',stage:'creation',node:'order_information'},
 {key:'development',label:'开发原单与轮次',stage:'creation',node:'development_publish'},
 {key:'development_technical',label:'开发技术成果与客户批复',stage:'development',node:'development_pattern'},
 {key:'pattern',label:'打板执行单',stage:'development',node:'development_sewing'},
 {key:'misc',label:'关联打板杂事单',stage:'development',node:'development_patch'},
 {key:'order',label:'订购信息、PO与日期历史',stage:'creation',node:'order_information'},
 {key:'ship_sample',label:'船样与快递记录',stage:'production',node:'bulk_ship_sample'},
 {key:'rework',label:'QC返工与本厂做尾',stage:'receiving',node:'rework'},
 {key:'closure',label:'本期结案依据',stage:'receiving',node:'special_closure'},
 {key:'factory_history',label:'旧工厂收料清点历史（已退役）',stage:'production',node:'production_reporting'},
] as const satisfies ReadonlyArray<{key:string;label:string;stage:JourneyStageKey;node:string}>;
export type CockpitDocumentCategory=typeof COCKPIT_DOCUMENT_CATEGORIES[number]['key'];
export const COCKPIT_PRIORITY_DOCUMENTS=COCKPIT_DOCUMENT_CATEGORIES.slice(0,10);
