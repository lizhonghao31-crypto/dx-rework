import {describe,it,expect} from 'vitest';
import {patternReturnPath,validPatternReturnPath} from '../../apps/web/src/pattern-order-query.js';
import {preparePatternNavigation} from '../../apps/web/src/pattern-navigation.js';
const id='00000000-0000-4000-8000-000000000001';
describe('P05 native/unified source return boundary',()=>{
 it('keeps exact total arrangement and validated nested todo source, including application prefix',()=>{
  const todo='/ui/my-tasks?q=TEST&module=digital_production&page=2',arrangement=`/ui/digital-production?arrangement=${id}&round=2&returnTo=${encodeURIComponent(todo)}`;
  expect(validPatternReturnPath(arrangement,'/')).toBe(arrangement);
  const prefixed=`/acceptance/ui/digital-production?arrangement=${id}&round=2&returnTo=${encodeURIComponent('/acceptance'+todo)}`;
  expect(validPatternReturnPath(prefixed,'/acceptance/')).toBe(arrangement);
  const next=preparePatternNavigation(arrangement,`/ui/pattern-room/orders/${id}`,undefined,460);
  expect(new URL(next.target,'https://local.invalid').searchParams.get('returnTo')).toBe(arrangement);expect(next.origin).toEqual({path:arrangement,top:460});
 });
 it('refuses invalid identity, external and backslash targets, duplicate parameters and excessive nesting',()=>{
  for(const target of ['https://evil.invalid/ui/digital-production','//evil.invalid/ui/digital-production','/ui/digital-production?arrangement=invalid',`/ui/digital-production?arrangement=${id}&arrangement=${id}`,`/ui/digital-production?arrangement=${id}&round=0`,`/ui/digital-production?arrangement=${id}&returnTo=${encodeURIComponent('//evil.invalid/')}`,'/ui\\digital-production'])expect(validPatternReturnPath(target,'/')).toBeNull();
  expect(patternReturnPath(`?returnTo=${encodeURIComponent('/ui/my-tasks')}&returnTo=${encodeURIComponent('/ui/pattern-room')}`)).toBe('/ui/pattern-room/orders');
  let nested='/ui/my-tasks';for(let i=0;i<5;i++)nested=`/ui/digital-production?arrangement=${id}&round=${i+1}&returnTo=${encodeURIComponent(nested)}`;expect(validPatternReturnPath(nested,'/')).toBeNull();
 });
 it('retains original legacy board, standalone and wage/list navigation',()=>{
  expect(validPatternReturnPath('/ui/pattern-room/orders?q=TEST&page=2','/')).toBe('/ui/pattern-room/orders?q=TEST&page=2');
  expect(validPatternReturnPath('/ui/digital-pattern-room?section=legacy&page=2','/')).toBe('/ui/digital-pattern-room?section=legacy&page=2');
 });
});
