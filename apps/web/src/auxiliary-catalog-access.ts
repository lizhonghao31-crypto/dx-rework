import {AUXILIARY_CATALOG_ROLES} from '@dx-rework/contracts/auxiliary-catalog';
import {hasPageAccess,type AuthorizedUser} from './auth.js';
export const auxiliaryCatalogRequirements=AUXILIARY_CATALOG_ROLES.map(requiredRole=>({requiredRole,requiredCapability:'auxiliary_catalog:write'}));
export function canManageAuxiliaryCatalog(user:AuthorizedUser):boolean{return auxiliaryCatalogRequirements.some(requirement=>hasPageAccess(user,requirement));}
