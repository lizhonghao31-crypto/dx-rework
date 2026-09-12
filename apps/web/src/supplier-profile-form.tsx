import {Button} from '@dx-rework/ui';
import {SUPPLIER_TYPE_LABELS} from './supplier-center-model.js';
import type {SupplierDraft} from './supplier-profile-draft.js';
export function SupplierProfileForm({draft,onDraft,busy,ready,creating,onSave,onCancel,application=false,submitLabel}:{draft:SupplierDraft;onDraft:(draft:SupplierDraft)=>void;busy:boolean;ready:boolean;creating:boolean;onSave:()=>void;onCancel:()=>void;application?:boolean;submitLabel?:string}){
 const field=(key:keyof SupplierDraft,label:string,maxLength:number,required=false,wide=false)=><label className={wide?'is-wide':undefined}>{label}{required?' *':''}<input required={required} maxLength={maxLength} value={String(draft[key])} onChange={e=>onDraft({...draft,[key]:e.target.value})}/></label>;
 return <form className="supplier-profile-form" onSubmit={e=>{e.preventDefault();onSave();}}>
  <p className="supplier-form-note">* 为资料采集表必填项。</p>
  <fieldset disabled={busy||!ready}><legend>基础与联系</legend>
   {field('supplierName','供应商名称',200,true)}
   <label>供应商类型 *<select disabled={!creating} value={draft.supplierType} onChange={e=>onDraft({...draft,supplierType:e.target.value as SupplierDraft['supplierType']})}>{Object.entries(SUPPLIER_TYPE_LABELS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   {!application ? <><label>供应商编码{creating?'（选填）':''}<input disabled={!creating} maxLength={32} pattern="[A-Z0-9][A-Z0-9_-]{1,31}" placeholder={creating?'留空自动生成':undefined} value={draft.supplierCode} onChange={e=>onDraft({...draft,supplierCode:e.target.value})}/></label>
   <label>启用状态 *<select value={draft.active?'active':'inactive'} onChange={e=>onDraft({...draft,active:e.target.value==='active'})}><option value="active">启用</option><option value="inactive">停用</option></select></label></> : null}
   {field('contactPerson','联系人',100,true)}{field('contactPhone','联系电话',50,true)}{field('address','地址',500,true,true)}
  </fieldset>
  <fieldset disabled={busy||!ready}><legend>收款与合同</legend>
   {field('payeeName','收款人',100,true)}{field('bankAccount','收款账号',100,true)}{field('bankName','开户行',200,true,true)}
   {field('contractEntityName','合同主体名称',200)}{field('partyBRepresentative','乙方代表',100)}
  </fieldset>
  <fieldset disabled={busy||!ready}><legend>工艺与产能</legend>
   <label className="is-wide">可承接工艺 *<input required maxLength={1000} placeholder="使用顿号或逗号分隔" value={draft.supportedCrafts} onChange={e=>onDraft({...draft,supportedCrafts:e.target.value})}/></label>
   <label>常规日产能<input inputMode="numeric" value={draft.dailyCapacity} onChange={e=>onDraft({...draft,dailyCapacity:e.target.value})}/></label>
   <label className="is-wide">备注<textarea maxLength={1000} value={draft.notes} onChange={e=>onDraft({...draft,notes:e.target.value})}/></label>
   {!creating?field('changeReason','修改原因',500,true,true):null}
  </fieldset>
  <div className="supplier-profile-form__actions"><Button type="button" disabled={busy} onClick={onCancel}>取消</Button><Button type="submit" variant="primary" disabled={busy||!ready}>{busy?(application?'提交中…':'保存中…'):submitLabel??(creating?'保存供应商':'保存新版本')}</Button></div>
 </form>;
}
