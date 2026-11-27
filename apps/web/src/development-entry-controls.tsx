import {Button} from '@astryxdesign/core/Button';
import {DateInput} from '@astryxdesign/core/DateInput';
import {TextInput} from '@astryxdesign/core/TextInput';
import {InternationalizationProvider} from '@astryxdesign/core/i18n';
import zhCN from '@astryxdesign/core/locales/zh-CN.generated.js';
import {useCallback,type ComponentProps,type ReactNode} from 'react';

const owner='dx-development-astryx-control';
const messages={'zh-CN':zhCN};
const markers={'zh-CN':{'@astryx.field.required':'*','@astryx.field.optional':'（选填）'}};
export function DevelopmentEntryLanguage({children}:{children:ReactNode}){
 return <InternationalizationProvider locale="zh-CN" messages={messages} overrides={markers}>{children}</InternationalizationProvider>;
}

export function DevelopmentEntryAction({children,disabled,variant='secondary',...props}:{
 children:string;disabled?:boolean|undefined;variant?:'primary'|'secondary'|'ghost'|undefined;
}&Omit<ComponentProps<typeof Button>,'children'|'label'|'isDisabled'|'variant'>){
 return <Button {...props} label={children} variant={variant} size="sm" isDisabled={disabled??false}/>;
}

export function DevelopmentEntryText({maxLength,label,visibleLabel=false,controlClassName,...props}:ComponentProps<typeof TextInput>&{
 maxLength?:number;visibleLabel?:boolean;
}){
 return <TextInput {...props} label={label} isLabelHidden={!visibleLabel} size="sm" controlClassName={[owner,controlClassName].filter(Boolean).join(' ')}
  {...(maxLength===undefined?{}:{ref:(input:HTMLInputElement|null)=>{if(input)input.maxLength=maxLength;}})}/>;
}

export function DevelopmentEntryDate({label,value,min,max,visibleLabel=false,controlClassName,...props}:Omit<ComponentProps<typeof DateInput>,'value'|'min'|'max'|'ref'>&{
 value:string;min?:string|undefined;max?:string|undefined;visibleLabel?:boolean;
}){
 type ISO=NonNullable<ComponentProps<typeof DateInput>['value']>;
 // These are native picker bounds. The original noValidate form lets typed
 // dates reach business validation, including the short-delivery approval.
 // DateInput's min/max props also discard out-of-range typed dates.
 const pickerBounds=useCallback((input:HTMLInputElement|null)=>{
  if(!input)return;
  if(min)input.min=min;else input.removeAttribute('min');
  if(max)input.max=max;else input.removeAttribute('max');
 },[min,max]);
 return <DateInput {...props} ref={pickerBounds} label={label} isLabelHidden={!visibleLabel} size="sm" controlClassName={[owner,controlClassName].filter(Boolean).join(' ')} format="system_date" presentation="native"
  value={value?value as ISO:undefined}/>;
}
