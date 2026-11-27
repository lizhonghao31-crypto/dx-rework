import {randomUUID} from 'node:crypto';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';

/** Current signed creation input for tests that actually start a new numbered document. */
export function numberedDevelopmentSheetFixture(styleName:string,makeSample=false):NonNullable<DevelopmentDocument['workbenchSheet']>{
 return {version:1,styleName,brand:'TEST 版单品牌',gender:'男装',boardType:'头版',processingSelected:true,referenceNote:'',
  sewingRows:makeSample?[{rowId:randomUUID(),color:'黑',size:'M',quantity:1}]:[]};
}
