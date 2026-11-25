import {Button} from '@dx-rework/ui';
import {Selector} from '@astryxdesign/core/Selector';
import {
  DEVELOPMENT_SAMPLE_BOARD_TYPES, DEVELOPMENT_SAMPLE_GENDERS, type WorkbenchDevelopmentSheet,
} from '@dx-rework/contracts/digital-development';
import {createClientRequestId} from './client-request-id.js';
import {DocumentField, DocumentSection, DocumentTableScroll} from './document-editor.js';
import {confirmInApp} from './system-dialog.js';

export const emptyWorkbenchDevelopmentSheet=():WorkbenchDevelopmentSheet=>({
  version:1,styleName:'',brand:'',gender:null,boardType:null,processingSelected:false,referenceNote:'',sewingRows:[],
});

export function WorkbenchDevelopmentSheetFields({sheet,readonly,issue,onChange,creation=false,originalFields=true}:{
  sheet:WorkbenchDevelopmentSheet;readonly:boolean;issue:(id:string)=>string|undefined;
  onChange:(sheet:WorkbenchDevelopmentSheet)=>void;creation?:boolean;originalFields?:boolean;
}){
  const text=(key:'styleName'|'brand'|'referenceNote',label:string)=>{
    const id=`development-workbench-${key}`;
    return <label>{label}<DocumentField id={id} label={label} value={sheet[key]} readonly={readonly} issue={issue(id)}
      onValue={value=>onChange({...sheet,[key]:value})}/></label>;
  };
  const choice=<K extends 'gender'|'boardType'>(key:K,label:string,options:readonly NonNullable<WorkbenchDevelopmentSheet[K]>[])=>{
    const id=`development-workbench-${key}`,message=issue(id);
    const change=(next:string)=>onChange({...sheet,[key]:options.find(value=>value===next)??null});
    if(creation&&!readonly)return <div id={id} tabIndex={-1}>
      <Selector label={label} size="sm" options={[...options]} {...(sheet[key]?{value:sheet[key]}:{})}
        placeholder="请选择" onChange={change} {...(message?{status:{type:'error' as const,message}}:{})}/>
    </div>;
    return <label>{label}
      {readonly?<span className="dx-doc-readonly">{sheet[key]??'未登记'}</span>:<select id={id} aria-label={label} value={sheet[key]??''}
        aria-invalid={Boolean(message)} aria-describedby={message?`${id}-error`:undefined}
        onChange={event=>change(event.target.value)}>
        <option value="">请选择</option>{options.map(value=><option key={value}>{value}</option>)}
      </select>}
      {message&&<small id={`${id}-error`}>{message}</small>}
    </label>;
  };
  const editRow=(rowId:string,patch:Partial<WorkbenchDevelopmentSheet['sewingRows'][number]>)=>
    onChange({...sheet,sewingRows:sheet.sewingRows.map(row=>row.rowId===rowId?{...row,...patch}:row)});
  return <DocumentSection id="development-workbench" title="版单基本资料">
    <div className="development-basic-grid">
      {originalFields&&text('styleName','款名（必填）')}
      {choice('gender','性别（必填）',DEVELOPMENT_SAMPLE_GENDERS)}
      {choice('boardType','板类（必填）',DEVELOPMENT_SAMPLE_BOARD_TYPES)}
    </div>
    <DocumentTableScroll><table aria-label="颜色尺码与制作件数"><thead>
      <tr><th>颜色</th><th>尺码</th><th>件数</th>{!readonly&&<th>操作</th>}</tr>
    </thead><tbody>
      {sheet.sewingRows.map((row,index)=>{
        const prefix=`development-workbench-${row.rowId}`,quantityId=`${prefix}-quantity`,message=issue(quantityId);
        return <tr key={row.rowId}>
          {(['color','size'] as const).map((key,column)=><td key={key}>
            <DocumentField id={`${prefix}-${key}`} label={`第 ${index+1} 行 ${column===0?'颜色':'尺码'}`} value={row[key]} readonly={readonly}
              issue={issue(`${prefix}-${key}`)} onValue={value=>editRow(row.rowId,{[key]:value})}/>
          </td>)}
          <td>{readonly?row.quantity??'未登记':<><input className={creation?"development-sewing-quantity":undefined}
            aria-label={`第 ${index+1} 行 件数`} id={quantityId} type="number" min={1} max={100000} step={1}
            value={row.quantity??''} onChange={event=>editRow(row.rowId,{quantity:event.target.value===''?null:Number(event.target.value)})}
            aria-invalid={Boolean(message)} aria-describedby={message?`${quantityId}-error`:undefined}/>{message&&<small id={`${quantityId}-error`}>{message}</small>}</>}</td>
          {!readonly&&<td><Button type="button" onClick={async()=>{
            if((row.color||row.size||row.quantity!==null)&&!await confirmInApp('确定移除这行颜色、尺码与件数？'))return;
            onChange({...sheet,sewingRows:sheet.sewingRows.filter(item=>item.rowId!==row.rowId)});
          }}>移除</Button></td>}
        </tr>;
      })}
    </tbody></table></DocumentTableScroll>
    {!readonly&&<Button type="button" disabled={sheet.sewingRows.length>=100} onClick={()=>onChange({...sheet,sewingRows:[
      ...sheet.sewingRows,{rowId:createClientRequestId(),color:'',size:'',quantity:null},
    ]})}>添加颜色尺码行</Button>}
    <details><summary>{originalFields?"其他信息（品牌与参考":"其他信息（参考款"}，已填 {(originalFields?[sheet.brand,sheet.referenceNote]:[sheet.referenceNote]).filter(Boolean).length} 项）</summary>
      {originalFields&&text('brand','品牌')}{text('referenceNote','参考款 / 版型说明')}
    </details>
  </DocumentSection>;
}
