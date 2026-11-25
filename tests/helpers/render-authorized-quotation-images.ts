import type {BrowserContext} from 'playwright-core';
import {expect} from 'vitest';
import type {businessAnchorFixture} from './business-anchor-fixture.js';

/** Loopback browser uses real auth and exact attachment lookup. Only the test
 * storage origin is substituted after the actual signed grant is verified. */
export function renderAuthorizedQuotationImages(context:BrowserContext,storage:Awaited<ReturnType<typeof businessAnchorFixture>>['storage']){
 return context.route(/\/quotation\/secondary-craft\/[^/]+\/(?:style-image|attachments)\/|\/quotations\/ie-processing\/[^/]+\/[^/]+\/style-image\//,async route=>{
  const response=await route.fetch({maxRedirects:0});
  if(response.status()!==302){await route.fulfill({response});return;}
  const target=new URL(response.headers().location!);
  expect(target.origin).toBe('https://private.example.test');
  const key=decodeURIComponent(target.pathname.slice(1)),bytes=storage.objectBytes.get(key);
  expect(storage.signed.some(grant=>grant.method==='GET'&&grant.objectKey===key)).toBe(true);
  expect(bytes).toBeDefined();
  await route.fulfill({status:200,contentType:storage.objects.get(key)!.mimeType,body:Buffer.from(bytes!)});
 });
}
