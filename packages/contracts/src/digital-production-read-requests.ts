/** Error/recovery and in-flight read classification only. This is not an
 * authorization grant, a retry policy or proof that a command did not commit.
 * POST entries are the existing explicit side-effect-free query endpoints. */
const readPosts=new Set([
 '/digital-production/whole-orders/delete-preview',
 '/digital-production/sla-settings/calculation-preview',
 '/digital-production/sla-settings/sets/calculate',
 '/digital-production/order-time-settings/calculate',
 '/digital-production/order-number-settings/preview',
 '/digital-production/customers/default-merchandisers/selected',
 '/digital-production/order-time/check',
 '/digital-production/order-time/preview',
 '/digital-production/order-time/requests/:requestId/preview',
]);
export function isDigitalProductionReadRequest(method:string,path:string):boolean{
 const verb=method.toUpperCase();if(verb==='GET'||verb==='HEAD')return true;
 const route=path.split('?',1)[0]!;
 return verb==='POST'&&(readPosts.has(route)||/^\/digital-production\/order-time\/requests\/[0-9a-f-]{36}\/preview$/i.test(route));
}
