import {formatBusinessDecimal} from '@dx-rework/contracts/business-display';

/** Screen display only. Never use this result as input to a calculation or command. */
export function quotationAmountDisplay(value:string|null|undefined,missing='—'){
  if(value==null||value==='')return missing;
  if(!/^-?\d+(?:\.\d+)?$/.test(value))return value;
  const display=formatBusinessDecimal(value,1);
  if(/^[-]?0$/.test(display)&&/[1-9]/.test(value))return value.startsWith('-')?'−<0.1':'<0.1';
  return display;
}
