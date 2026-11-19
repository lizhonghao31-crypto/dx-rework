import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import {Stack} from '@astryxdesign/core/Stack';
import componentCss from '@astryxdesign/core/astryx.css?raw';
import {Button as DxButton,StatusBadge} from '@dx-rework/ui';
import {createContext,useContext,useSyncExternalStore,type ComponentProps,type ReactNode} from 'react';

// This is the published StyleX CSS. Its default tokens belong on the local
// scope root, rather than document.documentElement.
const scopedCss='@scope (.dx-cockpit-astryx) {\n'+componentCss.replaceAll(':root',':scope')+'\n}';
const Pilot=createContext(false);
const narrowControls='(max-width: 379px)';
const readNarrowControls=()=>window.matchMedia(narrowControls).matches;
const subscribeNarrowControls=(notify:()=>void)=>{
 const query=window.matchMedia(narrowControls);
 query.addEventListener('change',notify);
 return ()=>query.removeEventListener('change',notify);
};
const serverNarrowControls=()=>false;

export function hasCockpitAstryx(){
 return typeof window!=='undefined'&&'CSSScopeRule' in window
  &&import.meta.env.VITE_COCKPIT_ASTRYX!=='off'
  &&new URLSearchParams(window.location.search).get('cockpitAstryx')!=='off';
}

export function CockpitAstryxScope({enabled,children}:{enabled:boolean;children:ReactNode}){
 return <Pilot.Provider value={enabled}>{enabled&&<style data-cockpit-style="astryx-v0.7.16">{scopedCss}</style>}{children}</Pilot.Provider>;
}

type CockpitButtonProps=Pick<ComponentProps<typeof Button>,'type'|'onClick'|'aria-expanded'|'aria-label'|'className'> & {
 children:string;disabled?:boolean;size?:'sm'|'md';variant?:'primary'|'secondary';
};

export function CockpitButton({children,disabled,size='md',variant='secondary',className='',...props}:CockpitButtonProps){
 const enabled=useContext(Pilot);
 return enabled?<Button {...props} className={`dx-button dx-cockpit-astryx-button ${className}`} label={children} variant={variant} size={size} isDisabled={Boolean(disabled)}/>
  :<DxButton {...props} className={className} variant={variant} disabled={disabled}>{children}</DxButton>;
}

export function CockpitBadge({children,tone='neutral',className=''}:{children:ReactNode;tone?:'neutral'|'info'|'success'|'warning'|'danger';className?:string}){
 return useContext(Pilot)
  ?<Badge className={`dx-cockpit-astryx-badge ${className}`} variant={tone==='danger'?'error':tone} label={children}/>
  :<span className={className}><StatusBadge tone={tone}>{children}</StatusBadge></span>;
}

export function CockpitStack({children,className,direction='horizontal',gap=1}:{children:ReactNode;className:string;direction?:'vertical'|'horizontal';gap?:1|2}){
 return useContext(Pilot)?<Stack className={className} direction={direction} gap={gap}>{children}</Stack>:<div className={className}>{children}</div>;
}


// Below 380px the native Stack can wrap one extra control and reduce the
// original search button's hit area. Preserve the established DX filter row.
export function CockpitFilterControls({children}:{children:ReactNode}){
 const enabled=useContext(Pilot);
 const narrow=useSyncExternalStore(subscribeNarrowControls,readNarrowControls,serverNarrowControls);
 return <Pilot.Provider value={enabled&&!narrow}><CockpitStack className="journey-filter-actions" gap={2}>{children}</CockpitStack></Pilot.Provider>;
}
