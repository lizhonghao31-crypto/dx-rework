import {useEffect,useRef,useState} from 'react';
import {Selector} from '@astryxdesign/core/Selector';
import {SalesSeriesSchema} from '@dx-rework/contracts/digital-production';
import {OrderNumberProductGroupSchema,OrderNumberPreviewSchema,OrderNumberSettingsSaveSchema} from '@dx-rework/contracts/digital-order-number';
import type {OrderNumberPreview,OrderNumberPreviewInput,OrderNumberSettings as Settings,OrderNumberSettingsRead} from '@dx-rework/contracts/digital-order-number';
import {DevelopmentEntryAction,DevelopmentEntryText} from './development-entry-controls.js';
import {designerAstryxCss} from './designer-astryx.js';
import {DigitalRequestError,digitalRequest} from './digital-production-api.js';
import {useForegroundWait} from './foreground-loading.js';
import {businessErrorInApp} from './system-dialog.js';
import './order-number-settings.css';

const path='order-number-settings';
const initialPreview:OrderNumberPreviewInput={
  kind:'development',designerId:'',customerCode:null,productGroup:'女装',salesYear:null,salesSeries:null,
};

export function OrderNumberSettings() {
  const [open,setOpen]=useState(false);
  return <div className="cockpit-settings-node-section dx-designer-astryx" lang="zh-CN">
    <style data-designer-style="astryx-v0.7.16">{designerAstryxCss}</style>
    <DevelopmentEntryAction type="button" aria-expanded={open} aria-controls="cockpit-order-number-settings"
      onClick={()=>setOpen(value=>!value)}>订单ID生成设置</DevelopmentEntryAction>
    {open&&<OrderNumberSettingsEditor/>}
  </div>;
}

function OrderNumberSettingsEditor() {
  const [record,setRecord]=useState<OrderNumberSettingsRead|null>(null);
  const [draft,setDraft]=useState<Settings>({boys:null,girls:null,designers:[]});
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [reload,setReload]=useState(0);
  const [pending,setPending]=useState<''|'save'|'preview'>('');
  const [preview,setPreview]=useState(initialPreview);
  const [year,setYear]=useState('');
  const [example,setExample]=useState<OrderNumberPreview|null>(null);
  const operation=useRef(false);
  const write=useRef<{body:string;key:string}|null>(null);

  useForegroundWait(!record&&!error?'order-number-settings:read':pending?'order-number-settings:'+pending:undefined);
  useEffect(()=>{
    const controller=new AbortController();
    void digitalRequest<OrderNumberSettingsRead>(path,'GET',undefined,undefined,{signal:controller.signal}).then(result=>{
      if(controller.signal.aborted)return;
      setRecord(result);
      setDraft(result.values);
    }).catch(reason=>{
      if(!controller.signal.aborted)setError(String(reason.message));
    });
    return ()=>controller.abort();
  },[reload]);

  const changeCode=(userId:string,code:string)=>setDraft(current=>({
    ...current,designers:[
      ...current.designers.filter(item=>item.userId!==userId),...(code.trim()?[{userId,code}]:[]),
    ],
  }));
  const updatePreview=(value:Partial<OrderNumberPreviewInput>)=>{
    setPreview(current=>({...current,...value}));
    setExample(null);
  };
  const showError=(action:string,reason:unknown)=>businessErrorInApp(action,[{
    type:reason instanceof DigitalRequestError&&reason.resultUnknown?'unknown'
      :reason instanceof DigitalRequestError&&reason.status===403?'permission':'failure',
    message:reason instanceof Error?reason.message:String(reason),
  }]);
  async function save() {
    if(!record||operation.current)return;
    const input=OrderNumberSettingsSaveSchema.safeParse({expectedVersion:record.version,...draft});
    if(!input.success){
      await businessErrorInApp('保存订单ID设置',[{type:'format',message:input.error.issues[0]?.message??'请核对代码'}]);
      return;
    }
    operation.current=true;
    setPending('save');
    setNotice('');
    const body=JSON.stringify(input.data);
    if(write.current?.body!==body)write.current={body,key:crypto.randomUUID()};
    try {
      const result=await digitalRequest<Pick<OrderNumberSettingsRead,'version'|'values'>>(path,'PUT',input.data,write.current.key);
      setRecord({...record,...result});
      setDraft(result.values);
      setNotice('订单ID设置已保存');
      setExample(null);
      write.current=null;
    }catch(reason){
      void showError('保存订单ID设置',reason);
    }finally{
      operation.current=false;
      setPending('');
    }
  }
  async function readPreview() {
    if(operation.current)return;
    const typedYear=year.trim();
    const input=OrderNumberPreviewSchema.safeParse({...preview,salesYear:typedYear
      ?(/^\d{4}$/.test(typedYear)?Number(typedYear):undefined):null});
    if(!input.success){
      await businessErrorInApp('预览订单ID',[{type:'format',message:'请选择设计师，并核对销售年份（四位整数）'}]);
      return;
    }
    operation.current=true;
    setPending('preview');
    setExample(null);
    try {
      setExample(await digitalRequest<OrderNumberPreview>(path+'/preview','POST',input.data));
    }catch(reason){
      void showError('预览订单ID',reason);
    }finally{
      operation.current=false;
      setPending('');
    }
  }

  if(!record)return <section id="cockpit-order-number-settings">
    {error?<><p role="alert">{error}</p><DevelopmentEntryAction type="button"
      onClick={()=>{setError('');setReload(value=>value+1);}}>重新读取订单ID设置</DevelopmentEntryAction></>:<p role="status">正在读取订单ID设置…</p>}
  </section>;
  const busy=pending!=='';
  const hasChanges=JSON.stringify(draft)!==JSON.stringify(record.values);
  return <section id="cockpit-order-number-settings" className="cockpit-order-number-editor" aria-label="订单ID生成设置">
    <p>男装 M · 女装 W</p>
    <div className="cockpit-order-number-fields">
      <DevelopmentEntryText label="男童代码" visibleLabel maxLength={12} value={draft.boys??''} isDisabled={busy}
        onChange={value=>setDraft(current=>({...current,boys:value||null}))}/>
      <DevelopmentEntryText label="女童代码" visibleLabel maxLength={12} value={draft.girls??''} isDisabled={busy}
        onChange={value=>setDraft(current=>({...current,girls:value||null}))}/>
    </div>
    <h3>设计师代码</h3>
    <ul className="cockpit-order-number-designers">
      {record.designers.map(designer=>{
        const code=draft.designers.find(item=>item.userId===designer.userId)?.code??'';
        return <li key={designer.userId}>
          <DevelopmentEntryText label={designer.name+'代码'} visibleLabel maxLength={12} value={code} isDisabled={busy}
            onChange={value=>changeCode(designer.userId,value)}/>
          {designer.suggestion&&<DevelopmentEntryAction type="button" disabled={busy||code===designer.suggestion}
            onClick={()=>changeCode(designer.userId,designer.suggestion??'')}>{'填入建议 '+designer.suggestion}</DevelopmentEntryAction>}
          {designer.needsReview&&<span>需核定读音或代码</span>}
        </li>;
      })}
    </ul>
    <DevelopmentEntryAction type="button" variant="primary" disabled={busy||!hasChanges}
      onClick={()=>void save()}>保存订单ID设置</DevelopmentEntryAction>
    {notice&&<p role="status">{notice}</p>}
    <h3>用已保存设置预览</h3>
    <div className="cockpit-order-number-fields">
      <Selector label="预览订单类型" size="sm" isDisabled={busy} value={preview.kind}
        options={[{value:'development',label:'纯开发'},{value:'preorder',label:'预下单'},{value:'formal',label:'正式订单'}]}
        onChange={value=>updatePreview({kind:value as OrderNumberPreviewInput['kind']})}/>
      <Selector label="预览设计师" size="sm" isDisabled={busy} value={preview.designerId}
        options={record.designers.map(item=>({value:item.userId,label:item.name}))}
        placeholder="选择设计师" onChange={designerId=>updatePreview({designerId})}/>
      <Selector label="预览客户" size="sm" isDisabled={busy} value={preview.customerCode??'unknown'}
        options={[{value:'unknown',label:'未知客户'},...record.customers.map(item=>({value:item.code,label:item.name+' · '+item.code}))]}
        onChange={value=>updatePreview({customerCode:value==='unknown'?null:value})}/>
      <Selector label="预览产品分类" size="sm" isDisabled={busy} value={preview.productGroup??''}
        options={OrderNumberProductGroupSchema.options.map(value=>({value,label:value}))}
        onChange={value=>updatePreview({productGroup:value as OrderNumberPreviewInput['productGroup']})}/>
      <DevelopmentEntryText label="预览销售年份" visibleLabel maxLength={4} value={year} isDisabled={busy}
        onChange={value=>{setYear(value);setExample(null);}}/>
      <Selector label="预览销售系列" size="sm" isDisabled={busy} value={preview.salesSeries??'unknown'}
        options={[{value:'unknown',label:'未知系列'},...SalesSeriesSchema.options.map(value=>({value,label:value}))]}
        onChange={value=>updatePreview({salesSeries:value==='unknown'?null:value as OrderNumberPreviewInput['salesSeries']})}/>
    </div>
    <DevelopmentEntryAction type="button" disabled={busy} onClick={()=>void readPreview()}>预览订单ID</DevelopmentEntryAction>
    {example&&<p role="status">{'missing' in example?'待补发号资料 '+example.missing.join('、'):example.example}</p>}
  </section>;
}
