import {Button} from '@astryxdesign/core/Button';
import {DateInput} from '@astryxdesign/core/DateInput';
import {TextInput} from '@astryxdesign/core/TextInput';
import type {ComponentProps} from 'react';

export function DevelopmentEntryAction({children,disabled,variant='secondary',...props}:{
 children:string;disabled?:boolean|undefined;variant?:'primary'|'secondary'|'ghost'|undefined;
}&Omit<ComponentProps<typeof Button>,'children'|'label'|'isDisabled'|'variant'>){
 return <Button {...props} label={children} variant={variant} size="sm" isDisabled={disabled??false}/>;
}

export function DevelopmentEntryText({maxLength,label,visibleLabel=false,...props}:ComponentProps<typeof TextInput>&{
 maxLength?:number;visibleLabel?:boolean;
}){
 return <TextInput {...props} label={label} isLabelHidden={!visibleLabel} size="sm"
  {...(maxLength===undefined?{}:{ref:(input:HTMLInputElement|null)=>{if(input)input.maxLength=maxLength;}})}/>;
}

export function DevelopmentEntryDate({label,value,max,visibleLabel=false,...props}:Omit<ComponentProps<typeof DateInput>,'value'|'max'>&{
 value:string;max?:string|undefined;visibleLabel?:boolean;
}){
 type ISO=NonNullable<ComponentProps<typeof DateInput>['value']>;
 return <DateInput {...props} label={label} isLabelHidden={!visibleLabel} size="sm" format="system_date" presentation="native"
  value={value?value as ISO:undefined} {...(max?{max:max as ISO}:{})}/>;
}
