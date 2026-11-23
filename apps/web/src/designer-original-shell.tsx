import {Button} from '@astryxdesign/core/Button';
import {Surface} from '@dx-rework/ui';
import type {ReactNode} from 'react';
import {designerAstryxCss} from './designer-astryx.js';

export function DesignerOriginalShell({title,onClose,children}:{title:string;onClose():void;children:ReactNode}){
 return <Surface className="factory-flow dx-designer-astryx">
  <style data-designer-style="astryx-v0.7.16">{designerAstryxCss}</style>
  <Button label="返回来源" size="sm" variant="secondary" onClick={onClose}/>
  <h2>{title}</h2>{children}
 </Surface>;
}
