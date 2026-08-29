// Comprobación de SEO del sitio, antes de publicar.
//
// Levanta un servidor que imita el `cleanUrls` de Vercel, abre cada ruta en
// Chromium y revisa lo que se rompe callado: un título que Google va a cortar,
// una descripción que va a reescribir, un `h1` duplicado, un JSON-LD con una
// coma de más, un enlace interno a una página que ya no existe.
//
//   node scripts/seo-check.mjs
//
// Necesita Playwright con Chromium (`npx playwright install chromium`). Si el
// entorno ya trae uno, se le pasa con `CHROMIUM_PATH=/ruta/al/chromium`. Sale
// con código 1 si algo falla, para poder colgarlo de un hook o de CI.
//
// Bloquea todo lo externo: Google Fonts no cambia nada de lo que se revisa acá
// y, si la red no lo alcanza, cada carga se queda esperando.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUERTO = 4399;

// Las rutas públicas, en el mismo orden del sitemap. Al sumar una página, va acá.
const RUTAS = [
  '/', '/tiendas-online', '/paginas-web', '/cro', '/precios',
  '/proyectos', '/proyectos/pecadoras-shoes', '/proyectos/checkyourcars', '/proyectos/checkyourweb',
  '/blog', '/blog/dejar-de-vender-solo-por-instagram', '/blog/que-necesitas-para-abrir-una-tienda-online',
  '/nosotros', '/contacto', '/privacidad',
];

const TIPOS = { '.css':'text/css', '.js':'text/javascript', '.webp':'image/webp',
                '.png':'image/png', '.svg':'image/svg+xml', '.xml':'application/xml' };

function servir() {
  return http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    const base = path.join(RAIZ, url);
    for (const cand of [base, base + '.html', path.join(base, 'index.html')]) {
      if (!cand.startsWith(RAIZ)) continue;
      try {
        if (!fs.statSync(cand).isFile()) continue;
        res.writeHead(200, { 'Content-Type': TIPOS[path.extname(cand)] || 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(cand));
      } catch { /* siguiente candidato */ }
    }
    res.writeHead(404); res.end('404 ' + url);
  });
}

// Lo que se mira en cada página, dentro del navegador.
function inspeccionar() {
  const q = (s) => document.querySelector(s);
  const tipos = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
    try { return JSON.parse(s.textContent)['@type']; } catch { return 'JSON_INVALIDO'; }
  });
  return {
    titulo: document.title,
    descripcion: (q('meta[name=description]') || {}).content || '',
    canonical: (q('link[rel=canonical]') || {}).href || '',
    ogUrl: (q('meta[property="og:url"]') || {}).content || '',
    lang: document.documentElement.lang,
    h1: document.querySelectorAll('h1').length,
    niveles: [...document.querySelectorAll('h1,h2,h3,h4')].map((h) => +h.tagName[1]),
    tipos,
    desborde: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    imgSinAlt: [...document.images].filter((i) => !i.alt).length,
    imgSinMedidas: [...document.images].filter((i) => !i.getAttribute('width') || !i.getAttribute('height')).length,
    internos: [...document.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute('href')),
  };
}

function problemas(d, estado) {
  const p = [];
  if (estado !== 200) p.push(`HTTP ${estado}`);
  if (d.h1 !== 1) p.push(`${d.h1} <h1>`);
  // Un salto de nivel (h2 → h4) rompe el esquema del documento.
  for (let i = 1; i < d.niveles.length; i++) {
    if (d.niveles[i] - d.niveles[i - 1] > 1) { p.push('salto de encabezado'); break; }
  }
  if (d.titulo.length > 62) p.push(`título de ${d.titulo.length} car.`);
  if (d.descripcion.length > 175 || d.descripcion.length < 70) p.push(`descripción de ${d.descripcion.length} car.`);
  if (d.lang !== 'es-CL') p.push(`lang="${d.lang}"`);
  if (!d.canonical.startsWith('https://vetalabs.cl')) p.push('canonical fuera del dominio');
  if (d.ogUrl && d.ogUrl !== d.canonical) p.push('og:url ≠ canonical');
  if (d.desborde > 0) p.push(`desborde horizontal de ${d.desborde}px`);
  if (d.imgSinAlt) p.push(`${d.imgSinAlt} img sin alt`);
  if (d.imgSinMedidas) p.push(`${d.imgSinMedidas} img sin width/height`);
  if (d.tipos.includes('JSON_INVALIDO')) p.push('JSON-LD inválido');
  if (!d.tipos.length) p.push('sin JSON-LD');
  return p;
}

const servidor = servir();
await new Promise((r) => servidor.listen(PUERTO, r));
// `CHROMIUM_PATH` es la salida para entornos donde el Chromium que Playwright
// espera no está descargado (contenedores con uno propio ya instalado).
const navegador = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
// 390px: el ancho desde el que llega la mayoría, y donde aparecen los desbordes.
const pagina = await navegador.newPage({ viewport: { width: 390, height: 900 } });
await pagina.route('**/*', (r) => (r.request().url().includes(`localhost:${PUERTO}`) ? r.continue() : r.abort()));

let fallas = 0;
const internos = new Set();
const enSitemap = new Set([...fs.readFileSync(path.join(RAIZ, 'sitemap.xml'), 'utf8')
  .matchAll(/<loc>https:\/\/vetalabs\.cl(\/[^<]*)?<\/loc>/g)].map((m) => m[1] || '/'));

for (const ruta of RUTAS) {
  const res = await pagina.goto(`http://localhost:${PUERTO}${ruta}`, { waitUntil: 'domcontentloaded' });
  const datos = await pagina.evaluate(inspeccionar);
  datos.internos.forEach((h) => internos.add(h.split('#')[0] || '/'));

  const mal = problemas(datos, res.status());
  if (!enSitemap.has(ruta)) mal.push('no está en sitemap.xml');
  if (mal.length) fallas++;
  console.log(`${mal.length ? '✗' : '✓'} ${ruta.padEnd(50)}${datos.tipos.join(', ')}`);
  for (const m of mal) console.log(`    · ${m}`);
}

// Assets con ruta absoluta. Con rutas relativas, /blog/ pedía
// /blog/assets/css/veta.css y la página se servía sin estilos: pasó en
// producción. `trailingSlash: false` en vercel.json redirige esa URL, pero la
// ruta absoluta es lo que hace que no dependa de la configuración.
const relativos = RUTAS.flatMap((ruta) => {
  const html = fs.readFileSync(
    path.join(RAIZ, ruta === '/' ? 'index.html' : (fs.existsSync(path.join(RAIZ, ruta + '.html')) ? ruta + '.html' : path.join(ruta, 'index.html'))), 'utf8');
  return [...html.matchAll(/(?:href|src)="((?:\.\.\/)?assets\/[^"]*)"/g)].map((m) => `${ruta} → ${m[1]}`);
});
if (relativos.length) {
  fallas++;
  console.log('\n✗ Assets con ruta relativa (se rompen si la URL trae barra final):');
  relativos.forEach((r) => console.log('    · ' + r));
}

console.log(`\nEnlaces internos (${internos.size}):`);
for (const enlace of [...internos].sort()) {
  const res = await pagina.goto(`http://localhost:${PUERTO}${enlace}`, { waitUntil: 'commit' });
  if (res.status() !== 200) { console.log(`✗ roto: ${enlace}`); fallas++; }
}
if (!fallas) console.log('  todos resuelven.');

await navegador.close();
servidor.close();

console.log(fallas ? `\n${fallas} problema(s).` : '\nSin problemas.');
process.exit(fallas ? 1 : 0);
