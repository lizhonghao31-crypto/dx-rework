import type {ReactNode} from 'react';
import type {JourneyRecord} from '@dx-rework/contracts/digital-production-journey';
import {createWebUrls} from '../url-contract.js';
import {journeyRecordHref,type CockpitContext} from './digital-journey-cockpit-model.js';
const urls=createWebUrls(import.meta.env.BASE_URL);

export function CockpitRecordLink({record,context,children,disabled=false,onNavigate}:{record:JourneyRecord;context:CockpitContext;children:ReactNode;disabled?:boolean;onNavigate?:(()=>CockpitContext)|undefined}){
  const href=record.url?journeyRecordHref(record.url,context,record.mode):"";
  return href&&!disabled?<a href={urls.pageUrl(href)} onClick={event=>{if(onNavigate&&record.url)event.currentTarget.href=urls.pageUrl(journeyRecordHref(record.url,onNavigate(),record.mode));}}>{children}</a>:<span className="journey-muted" aria-disabled="true">{disabled?children:"记录暂不可用"}</span>;
}
