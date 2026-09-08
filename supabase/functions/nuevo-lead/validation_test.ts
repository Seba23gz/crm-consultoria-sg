import { normalize, fallbackId, InputError } from './validation.ts';

function assert(value: unknown) { if (!value) throw new Error('Assertion failed'); }
const valid = { nombre: ' Persona ', email: 'PERSONA@example.com', canales: ['Shopify','Shopify',' Instagram '] };
Deno.test('normaliza nombre, email y canales sin duplicar', () => {
  const { payload } = normalize(valid);
  assert(payload.nombre === 'Persona' && payload.email === 'persona@example.com');
  assert(JSON.stringify(payload.canales) === '["Instagram","Shopify"]');
});
for (const bad of [null, [], 42, {}, { ...valid, email: 'mal' }, { ...valid, nombre: {} },
  { ...valid, mensaje: 'a'.repeat(3001) }, { ...valid, canales: [null] },
  { ...valid, request_id: 'x' }]) {
  Deno.test('rechaza entrada inválida ' + JSON.stringify(bad).slice(0,90), () => {
    let caught = false;
    try { normalize(bad); } catch (e) { caught = e instanceof InputError; }
    assert(caught);
  });
}
Deno.test('reintento de formulario antiguo conserva identificador diario', async () => {
  const p = normalize(valid).payload;
  const date = new Date('2026-09-08T12:00:00Z');
  assert(await fallbackId(p,date) === await fallbackId(p,date));
  assert(await fallbackId(p,date) !== await fallbackId({...p,mensaje:'otro'},date));
});
