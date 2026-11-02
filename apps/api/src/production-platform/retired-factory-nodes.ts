import {ApplicationError} from '../platform/errors.js';
export const FACTORY_RECEIPT_RETIREMENT='20261101.factory-receipt-retired';
export const isRetiredFactoryTask=(kind:string)=>kind==='factory_material_count';
export function assertCurrentFactoryTask(kind:string){
 if(isRetiredFactoryTask(kind))throw new ApplicationError('FACTORY_RECEIPT_RETIRED','工厂到料确认和到料清点已停用；原记录仅供查看，后续业务无需完成此节点',410);
}
