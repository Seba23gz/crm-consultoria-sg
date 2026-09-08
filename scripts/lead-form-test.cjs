const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/lead-form.js');
function response() { return { headers: {}, setHeader(k,v) { this.headers[k]=v; }, end(v) { this.body=v; } }; }
test('GET no procesa datos', async () => {
  const r=response(); await handler({method:'GET',headers:{}},r); assert.equal(r.statusCode,405);
});
test('formulario sin JS conserva canales y no devuelve datos personales', async () => {
  const prev=global.fetch; let sent;
  global.fetch=async (url,opt) => { sent=JSON.parse(opt.body); return Response.json({ok:true,email:'failed'}); };
  try {
    const r=response(); await handler({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:'nombre=Persona&email=person%40example.com&canales=Shopify&canales=Instagram'},r);
    assert.equal(r.statusCode,200); assert.deepEqual(sent.canales,['Shopify','Instagram']);
    assert.match(r.body,/Recibimos/); assert.ok(!r.body.includes('person@example.com'));
  } finally {global.fetch=prev;}
});
test('respuesta inválida del receptor no muestra éxito', async () => {
  const prev=global.fetch; global.fetch=async()=>Response.json({ok:false});
  try { const r=response(); await handler({method:'POST',headers:{'content-type':'application/json'},body:{}},r);
    assert.equal(r.statusCode,502); } finally {global.fetch=prev;}
});
test('cuerpo excesivo no llama al receptor', async () => {
  const prev=global.fetch; global.fetch=()=>{throw new Error('No debe llamar');};
  try { const r=response(); await handler({method:'POST',headers:{'content-type':'application/json'},body:{mensaje:'x'.repeat(17000)}},r);
    assert.equal(r.statusCode,413); } finally {global.fetch=prev;}
});
