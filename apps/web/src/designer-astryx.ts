import astryxCss from '@astryxdesign/core/astryx.css?raw';

// One published stylesheet scope for the designer workspace and its directory.
export const designerAstryxCss='@scope (.dx-designer-astryx) {\n'+astryxCss.replaceAll(':root',':scope')+'\n}';
