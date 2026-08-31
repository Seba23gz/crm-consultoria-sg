// Comprobación del consentimiento de cookies (Ley 21.719), antes de publicar.
//
// Lo que verifica, que es lo que la ley mira:
//   - que la medición arranque DENEGADA y el `consent default` sea lo primero
//     que entra al dataLayer, antes de que GTM pueda disparar nada;
//   - que rechazar deje todo denegado y que aceptar lo conceda;
//   - que la decisión persista al navegar y no se vuelva a preguntar;
//   - que el pie reabra el banner, porque retirar el permiso tiene que ser tan
//     fácil como darlo;
//   - que se pueda decidir con el teclado y sin desbordes en móvil.
//
//   node scripts/consent-check.mjs
//
// Necesita Playwright con Chromium (`npx playwright install chromium`). Si el
// entorno ya trae uno, se le pasa con `CHROMIUM_PATH=/ruta/al/chromium`. Sale
// con código 1 si algo falla.
//
// `gtm.js` se responde con un doble: lo que se comprueba es el comportamiento
// del sitio, no que Google conteste.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv=http.createServer((q,s)=>{let u=decodeURIComponent(q.url.split('?')[0]);let f=path.join(R,u);
 for(const c of [f,f+'.html',path.join(f,'index.html')]){try{if(fs.statSync(c).isFile()){
  const t=c.endsWith('.css')?'text/css':c.endsWith('.js')?'text/javascript':'text/html; charset=utf-8';
  s.writeHead(200,{'Content-Type':t});return s.end(fs.readFileSync(c));}}catch{}}
 s.writeHead(404);s.end('404');});
await new Promise(r=>srv.listen(4325,r));
const B='http://localhost:4325';

// `CHROMIUM_PATH` para entornos que ya traen su propio Chromium.
const b=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
let fallos=0;
const ok=(cond,txt,extra='')=>{ if(!cond) fallos++; console.log((cond?'✓ ':'✗ ')+txt+(extra?'  '+extra:'')); };

async function nuevaPagina(ctx){
  const p=await ctx.newPage();
  await p.route('**/*', r => {
    const u=r.request().url();
    if(u.includes('googletagmanager.com/gtm.js')) return r.fulfill({status:200,contentType:'text/javascript',body:'window.__gtm=true;'});
    if(u.includes('localhost')) return r.continue();
    return r.abort();
  });
  return p;
}
// Lee los estados de consentimiento tal como Google los ve en el dataLayer.
const consentimientos = p => p.evaluate(() => (window.dataLayer||[])
  .filter(a => a && a[0]==='consent')
  .map(a => ({modo:a[1], analytics:a[2].analytics_storage, ads:a[2].ad_storage})));

// ---------- 1. Primera visita: todo denegado y el banner a la vista ----------
let ctx=await b.newContext({viewport:{width:1280,height:900}});
let p=await nuevaPagina(ctx);
await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(500);

let c=await consentimientos(p);
ok(c.length===1 && c[0].modo==='default', 'arranca con un consent default', JSON.stringify(c));
ok(c[0].analytics==='denied' && c[0].ads==='denied', 'analytics y ads DENEGADOS antes de decidir');
ok(await p.locator('[data-consent]').isVisible(), 'el banner se ve en la primera visita');
ok(await p.evaluate(()=>!!window.__gtm), 'GTM igual carga (necesita las señales de consentimiento)');

// El orden importa: el default tiene que ir antes del snippet de GTM. Se mira
// el archivo y no el DOM, porque el cargador de GTM inserta su <script> antes
// del primer script del documento y en el DOM aparece delante aunque no lo esté.
const fuente = fs.readFileSync(path.join(R,'index.html'),'utf8');
ok(fuente.indexOf("'consent','default'") < fuente.indexOf("googletagmanager.com/gtm.js"),
   'el consent default va ANTES del snippet de GTM en el archivo');
ok(await p.evaluate(()=>{const d=window.dataLayer||[];return d[0]&&d[0][0]==='consent'&&d[0][1]==='default';}),
   'el default es lo PRIMERO que entra al dataLayer');

// ---------- 2. Sin desbordes ni salto de maqueta ----------
for (const w of [390,1280]) {
  const pw=await nuevaPagina(await b.newContext({viewport:{width:w,height:900}}));
  await pw.goto(B+'/',{waitUntil:'domcontentloaded'}); await pw.waitForTimeout(400);
  const desborde=await pw.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  const tapa=await pw.evaluate(()=>{
    const c=document.querySelector('[data-consent]'), d=document.querySelector('[data-dock]');
    return d ? (getComputedStyle(d).transform!=='none' && d.dataset.show==='true') : false;
  });
  ok(desborde===0, `sin desborde horizontal a ${w}px`, 'desborde='+desborde);
  ok(!tapa, `la barra del CTA no compite con el banner a ${w}px`);
  await pw.context().close();
}

// ---------- 3. Rechazar ----------
await p.click('[data-consent-no]'); await p.waitForTimeout(300);
c=await consentimientos(p);
ok(c.length===2 && c[1].modo==='update', 'rechazar manda un consent update');
ok(c[1].analytics==='denied' && c[1].ads==='denied', 'tras rechazar sigue DENEGADO');
ok(!(await p.locator('[data-consent]').isVisible()), 'el banner se cierra al rechazar');

// Persiste entre páginas: no vuelve a preguntar.
await p.goto(B+'/precios',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(400);
ok(!(await p.locator('[data-consent]').isVisible()), 'no vuelve a preguntar al navegar');
c=await consentimientos(p);
ok(c.every(x=>x.analytics==='denied'), 'en la página siguiente sigue denegado', JSON.stringify(c));
ok(await p.locator('[data-consent-abrir]').count()>0, 'el pie ofrece "Preferencias de cookies"');

// ---------- 4. Cambiar de opinión: reabrir y aceptar ----------
await p.click('[data-consent-abrir]'); await p.waitForTimeout(200);
ok(await p.locator('[data-consent]').isVisible(), 'el pie reabre el banner');
await p.click('[data-consent-si]'); await p.waitForTimeout(300);
c=await consentimientos(p);
ok(c[c.length-1].analytics==='granted' && c[c.length-1].ads==='granted', 'aceptar CONCEDE analytics y ads');

// Y persiste ya concedido en la carga siguiente, desde el <head>.
await p.goto(B+'/contacto',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(400);
c=await consentimientos(p);
ok(c.length===2 && c[1].modo==='update' && c[1].analytics==='granted',
   'al recargar arranca denegado y concede de inmediato', JSON.stringify(c));
ok(!(await p.locator('[data-consent]').isVisible()), 'ya no pregunta tras aceptar');

// ---------- 5. Los eventos del sitio no se duplican ----------
const cta=p.locator('[data-ev="click_diagnostico"]:visible').first();
await cta.evaluate(el=>el.removeAttribute('href'));
await cta.click(); await p.waitForTimeout(200);
const veces=await p.evaluate(()=>(window.dataLayer||[]).filter(x=>x&&x.event==='click_diagnostico').length);
ok(veces===1, 'el evento del CTA se registra una sola vez', 'veces='+veces);

// ---------- 6. Teclado ----------
const ctx2=await b.newContext({viewport:{width:1280,height:900}});
const p2=await nuevaPagina(ctx2);
await p2.goto(B+'/',{waitUntil:'domcontentloaded'}); await p2.waitForTimeout(400);
let foco=null;
for (let i=0;i<6;i++){
  await p2.keyboard.press('Tab');
  foco=await p2.evaluate(()=>{const a=document.activeElement;
    return {dentro:!!a.closest('[data-consent]'), boton:a.hasAttribute('data-consent-no')||a.hasAttribute('data-consent-si'),
            txt:(a.textContent||'').trim()};});
  if (foco.dentro) break;
}
ok(foco.dentro, 'el banner se alcanza con el teclado sin recorrer la página', JSON.stringify(foco));
// Seguir tabulando hasta el primer botón (antes está el enlace a /privacidad).
for (let i=0;i<4 && !foco.boton;i++){
  await p2.keyboard.press('Tab');
  foco=await p2.evaluate(()=>{const a=document.activeElement;
    return {dentro:!!a.closest('[data-consent]'), boton:a.hasAttribute('data-consent-no')||a.hasAttribute('data-consent-si'),
            txt:(a.textContent||'').trim()};});
}
ok(foco.boton, 'se llega a un botón de decisión con el teclado', JSON.stringify(foco));
await p2.keyboard.press('Enter'); await p2.waitForTimeout(300);
ok(!(await p2.locator('[data-consent]').isVisible()), 'se puede decidir con el teclado');

const errores=[]; p2.on('pageerror',e=>errores.push(String(e)));
await p2.goto(B+'/privacidad',{waitUntil:'domcontentloaded'}); await p2.waitForTimeout(300);
ok(errores.length===0,'sin errores de JS', errores.join(' | '));

await b.close(); srv.close();
console.log(fallos?`\n${fallos} fallo(s).`:'\nTodo correcto.');
process.exit(fallos?1:0);
