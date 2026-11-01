// Read-only fixture prerequisites, before any expensive migration/test chain.
export const fixtureRoles=plan=>plan.some(s=>s.path==='tests/integration/acceptance-maintenance-postgres.test.ts')?['dx_rework_acceptance','dx_rework_acceptance_app']:[];
export function validateFixtureRoles(required,rows){
 for(const role of required){const r=rows.find(v=>v.name===role);if(!r||r.member!==true||r.superuser!==false||r.createRole!==false||r.createDatabase!==false||r.login!==false)throw Error('TEST_FIXTURE_ROLE_PREREQUISITE_MISSING: '+role);}
}
export async function assertFixturePrerequisites(url,plan){
 const required=fixtureRoles(plan);if(!required.length)return;
 const {default:pg}=await import('pg');const pool=new pg.Pool({connectionString:url,max:1});
 try{const result=await pool.query('SELECT rolname AS name, pg_has_role(current_user,oid,\'MEMBER\') AS member, rolsuper AS superuser, rolcreaterole AS "createRole", rolcreatedb AS "createDatabase", rolcanlogin AS login FROM pg_roles WHERE rolname=ANY($1::text[])',[required]);validateFixtureRoles(required,result.rows);}
 finally{await pool.end();}
 console.log('TEST_FIXTURE_PREREQUISITES_VERIFIED: low-privilege role catalog');
}
