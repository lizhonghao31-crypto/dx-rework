import {it,expect} from 'vitest';
import {productionReportingHref} from '../../apps/web/src/production-display-context.js';
it('keeps original order and factory reporting targets with the exact permitted display return, without allowing external returns',()=>{
 const id='00000000-0000-4000-8000-000000000001',factory='00000000-0000-4000-8000-000000000002',returnTo='/ui/production-dashboard?workspace=display&page=2&selected='+id+'&factoryDecisionId='+factory;
 const href=productionReportingHref(id,factory,returnTo)!,url=new URL(href,'https://test.invalid');expect(url.pathname).toBe('/ui/production-reporting/'+id);expect(url.searchParams.get('factoryDecisionId')).toBe(factory);expect(url.searchParams.get('returnTo')).toBe(returnTo);
 expect(productionReportingHref(id,factory,'https://external.invalid/')).not.toContain('returnTo');expect(productionReportingHref('../other',null,returnTo)).toBeNull();expect(productionReportingHref(id,'../other',returnTo)).toBeNull();expect(new URL(productionReportingHref(null,null,returnTo)!,'https://test.invalid').pathname).toBe('/ui/production-reporting');
});
