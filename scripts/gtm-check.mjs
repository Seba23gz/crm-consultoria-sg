// Comprueba el contenedor de GTM versionado en docs/gtm-vetalabs-ga4.json.
//
// Lo que importa que no se rompa: que el archivo siga siendo importable y que
// sus eventos sigan siendo los que el sitio empuja de verdad. Si alguien agrega
// un `data-ev` nuevo en el HTML y no lo declara acá, el evento llega al
// dataLayer y GA4 nunca lo ve; al revés, una etiqueta espera algo que ya nadie
// dispara. Las dos cosas pasan calladas, así que se revisan solas.
//
//   node scripts/gtm-check.mjs
//
// No necesita navegador ni red. Sale con código 1 si algo falla.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVO = path.join(RAIZ, 'docs/gtm-vetalabs-ga4.json');

let fallas = 0;
const chk = (cond, msg, extra = '') => {
  if (!cond) fallas++;
  console.log(`${cond ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);
};

const d = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
const cv = d.containerVersion;
const { tag: tags, trigger: triggers, variable: variables } = cv;

chk(d.exportFormatVersion === 2, 'formato de exportación 2 (el que GTM importa)');
chk(cv.container.publicId === 'GTM-TS67GQTV', 'apunta al contenedor GTM-TS67GQTV');

// 2147479553 es el id del activador integrado "All Pages".
const idsTrigger = new Set([...triggers.map((t) => t.triggerId), '2147479553']);
const huerfanas = tags.flatMap((t) => (t.firingTriggerId || [])
  .filter((f) => !idsTrigger.has(f)).map(() => t.name));
chk(huerfanas.length === 0, 'ninguna etiqueta apunta a un activador inexistente', huerfanas.join(', '));

const usados = new Set(tags.flatMap((t) => t.firingTriggerId || []));
const sueltos = triggers.filter((t) => !usados.has(t.triggerId)).map((t) => t.name);
chk(sueltos.length === 0, 'ningún activador queda sin etiqueta', sueltos.join(', '));

for (const [campo, col] of [['tagId', tags], ['triggerId', triggers], ['variableId', variables]]) {
  const v = col.map((x) => x[campo]);
  chk(new Set(v).size === v.length, `ids únicos en ${campo}`);
}

// Toda referencia {{variable}} tiene que existir, o GTM la importa rota.
const INTEGRADAS = new Set(['_event', 'Event', 'Page Url', 'Page Path', 'Page Hostname',
                            'Referrer', 'Click Url', 'Click Text']);
const nombres = new Set(variables.map((v) => v.name));
const refs = new Set([...JSON.stringify(d).matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]));
const rotas = [...refs].filter((r) => !nombres.has(r) && !INTEGRADAS.has(r));
chk(rotas.length === 0, 'toda referencia {{variable}} existe', rotas.join(', '));

const base = tags.filter((t) => t.type === 'googtag');
chk(base.length === 1, 'una sola etiqueta base de Google');
const desenlazadas = tags.filter((t) => t.type === 'gaawe' && !t.parameter
  .some((p) => p.key === 'measurementId' && p.value === base[0]?.name)).map((t) => t.name);
chk(desenlazadas.length === 0, 'cada evento GA4 enlaza con la etiqueta base', desenlazadas.join(', '));

// El ID real no se inventa: se reemplaza al importar.
const mid = variables.find((v) => v.name.startsWith('GA4'))
  ?.parameter.find((p) => p.key === 'value')?.value;
chk(mid === 'G-XXXXXXXXXX', 'el ID de medición sigue siendo un marcador', String(mid));

// Los eventos del contenedor tienen que ser los que el sitio empuja.
const html = [...fs.readdirSync(RAIZ).filter((f) => f.endsWith('.html')),
  ...fs.readdirSync(path.join(RAIZ, 'proyectos')).map((f) => 'proyectos/' + f),
  ...fs.readdirSync(path.join(RAIZ, 'blog')).map((f) => 'blog/' + f)]
  .filter((f) => f.endsWith('.html') && !f.includes('_plantilla'))
  .map((f) => fs.readFileSync(path.join(RAIZ, f), 'utf8')).join('');

// Los dos del formulario se disparan desde el JS, no desde un atributo.
const enSitio = new Set([...html.matchAll(/data-(?:view-)?ev="([^"]+)"/g)].map((m) => m[1]));
enSitio.add('form_start'); enSitio.add('form_submit');
const enGtm = new Set(tags.filter((t) => t.type === 'gaawe')
  .map((t) => t.parameter.find((p) => p.key === 'eventName').value));

const faltan = [...enSitio].filter((e) => !enGtm.has(e));
const sobran = [...enGtm].filter((e) => !enSitio.has(e));
chk(faltan.length === 0, 'todo evento del sitio tiene su etiqueta en GTM', faltan.join(', '));
chk(sobran.length === 0, 'ninguna etiqueta espera un evento que el sitio ya no manda', sobran.join(', '));

console.log(fallas ? `\n${fallas} problema(s).` : '\nContenedor consistente.');
process.exit(fallas ? 1 : 0);
