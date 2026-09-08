// Base PostgreSQL efímera, sin conexión a Supabase ni datos reales.
// deno run --no-config --allow-read scripts/web-intake-test.ts
import { PGlite } from 'npm:@electric-sql/pglite@0.3.16';
import assert from 'node:assert/strict';
const db = new PGlite();
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table empresas(id bigint generated always as identity primary key, nombre text not null, sitio_web text);
    create table contactos(id bigint generated always as identity primary key, nombre text not null, email text,
      telefono text, cargo text, empresa_id bigint references empresas);
    create table leads(id bigint generated always as identity primary key, empresa_id bigint references empresas,
      contacto_id bigint references contactos, titulo text, etapa text, prioridad text, notas text,
      ultimo_contacto date, origen text, necesidad text, canales text[], presupuesto text, sitio text);
  `);
  await db.exec(await Deno.readTextFile(new URL('../supabase/migrations/20260906230000_web_intake.sql', import.meta.url)));
  const p = { nombre:'Prueba', email:'test@example.com', empresa:'Marca', telefono:'', cargo:'', sitio:'',
    necesidad:'Tienda', canales:['Instagram'], presupuesto:'', mensaje:'Solo prueba local' };
  const submit = async (id:string, payload=p) => (await db.query<{result:{duplicate:boolean}}>(
    'select recibir_lead_web($1, $2::jsonb) as result',[id,JSON.stringify(payload)])).rows[0].result;
  assert.equal((await submit('request-0000000001')).duplicate,false);
  assert.equal((await submit('request-0000000001')).duplicate,true);
  await assert.rejects(submit('request-0000000001',{...p,mensaje:'Cambio'}),/request_conflict/);
  for(let i=2;i<=5;i++) await submit('request-000000000'+i);
  await assert.rejects(submit('request-0000000006'),/rate_limited/);
  const counts=(await db.query('select (select count(*) from empresas)::int as companies, (select count(*) from contactos)::int as contacts, (select count(*) from leads)::int as leads')).rows[0];
  assert.deepEqual(counts,{companies:1,contacts:1,leads:5});
  assert.equal((await db.query<{v:boolean}>("select reclamar_aviso_web('request-0000000001') as v")).rows[0].v,true);
  assert.equal((await db.query<{v:boolean}>("select reclamar_aviso_web('request-0000000001') as v")).rows[0].v,false);
  await db.exec("update web_intake set email_status='failed' where request_id='request-0000000001'");
  assert.equal((await db.query<{v:boolean}>("select reclamar_aviso_web('request-0000000001') as v")).rows[0].v,true);
  await db.exec("update web_intake set email_status='sent' where request_id='request-0000000001'");
  assert.equal((await db.query<{v:boolean}>("select reclamar_aviso_web('request-0000000001') as v")).rows[0].v,false);
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from web_intake'),/permission denied/);
  await assert.rejects(submit('forbidden-request'),/permission denied/);
  await db.exec('reset role');
  await db.exec("alter table leads add constraint test_failure check (notas <> 'force-failure')");
  await assert.rejects(submit('rollback-request1',{...p,empresa:'Otra',email:'other@example.com',mensaje:'force-failure'}),/test_failure/);
  assert.equal((await db.query<{n:number}>('select count(*)::int as n from empresas')).rows[0].n,1);
  assert.equal((await db.query<{n:number}>('select count(*)::int as n from contactos')).rows[0].n,1);
  await db.exec('delete from leads');
  assert.equal((await db.query<{n:number}>('select count(*)::int as n from web_intake')).rows[0].n,0);
  console.log('OK: SQL, deduplicación, cuotas, reclamo de correo, permisos, rollback y eliminación asociada.');
} finally { await db.close(); }
