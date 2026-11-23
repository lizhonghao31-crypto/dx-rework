export const DEVELOPMENT_CREATION_TYPES = [
  {kind:'development',label:'纯开发',description:'填写版单和开发需求。'},
  {kind:'certain_order',label:'已确认订单',description:'填写版单、开发需求及客户交货资料。'},
  {kind:'preorder',label:'预下单',description:'保存备料资料后，交给指定跟单。'},
] as const;

export type DevelopmentWizardKind = typeof DEVELOPMENT_CREATION_TYPES[number]['kind'];
export type DevelopmentWizardStep = 1 | 2 | 3;

export const DEVELOPMENT_WIZARD_STEPS = ['版单资料','开发需求','客户与交货'] as const;
