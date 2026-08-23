# Veta Labs

Sitio público de la agencia y su CRM interno, en un mismo proyecto de Vercel.

Veta Labs es una **agencia de e-commerce y crecimiento digital**: su producto
principal son tiendas online en Shopify para negocios que ya venden por
Instagram y WhatsApp. El sitio está construido alrededor de un solo objetivo de
conversión: **solicitar un diagnóstico gratuito**.

## Estructura del sitio

HTML plano, sin build. Vercel sirve la raíz tal cual, con `cleanUrls: true`
(`precios.html` se publica como `/precios`).

| Ruta | Archivo | Qué es |
|---|---|---|
| `/` | `index.html` | Home: problema → solución → Shopify → método → proyectos → proceso → precios → FAQ → formulario |
| `/tiendas-online` | `tiendas-online.html` | Servicio principal (Shopify) |
| `/paginas-web` | `paginas-web.html` | Landing pages, web corporativa y proyectos a medida |
| `/cro` | `cro.html` | Optimización de conversión, también para tiendas de terceros |
| `/proyectos` | `proyectos/index.html` | Índice de casos |
| `/proyectos/<slug>` | `proyectos/<slug>.html` | Caso: contexto / problema / solución / resultado |
| `/precios` | `precios.html` | Planes, tabla comparativa, servicios aparte y FAQ completo |
| `/nosotros` | `nosotros.html` | Quién está detrás y cómo trabajamos |
| `/contacto` | `contacto.html` | Formulario de diagnóstico (destino del CTA) |
| `/privacidad` | `privacidad.html` | Política de privacidad (la exige Meta para los formularios) |
| `/crm` | `crm/index.html` | CRM interno: pipeline, campañas, empresas y seguimientos (login Supabase) |
| `/api/lead-form` | `api/lead-form.js` | Endpoint alternativo para recibir leads (hoy sin uso) |

El CRM no se enlaza desde el sitio a propósito: se entra por la URL directa y
queda detrás del login de Supabase.

### Por qué la navegación tiene estos ítems

Nav: **Tiendas online · Páginas web · CRO · Proyectos · Precios · Nosotros** +
el CTA *Diagnóstico gratuito*. «Inicio» vive en el logo y «Contacto» es el CTA,
así que no ocupan un ítem cada uno: son seis decisiones en vez de ocho, que es
lo que aguanta un menú sin volverse un directorio.

## Sistema visual

Todo el CSS y el JS están compartidos entre páginas. **No hay estilos inline de
layout**: si algo se repite, es una clase.

- `assets/css/veta.css` — tokens de color y tipografía, layout, componentes
  (`.btn`, `.card`, `.plan`, `.faq`, `.case`, `.form`, `.dock`…) y utilidades.
  Está numerado por secciones; el índice va arriba del archivo.
- `assets/js/veta.js` — navegación mobile, animación de entrada, barra fija,
  formulario y medición. Se carga con `defer`, así que nunca bloquea el pintado.

Paleta (manual de marca): `#111111` · `#F4F4F5` · `#A1A1AA` · `#52525B`, con
`#ebebed`/`#ffffff` para separar secciones. Esquinas rectas, marcos de registro
en L y rótulos en `Space Mono`.

### Al agregar una página

1. Copiar la cabecera y el pie de otra página **tal cual** (son idénticos en
   todo el sitio; si cambia uno, hay que cambiarlos todos).
2. Marcar el ítem de nav activo con `aria-current="page"`.
3. Rellenar `<title>`, `meta description` (≤ 175 caracteres), `canonical` y
   Open Graph.
4. Sumar la URL a `sitemap.xml`.

## Configuración rápida

Todo lo que hay que encender vive en el bloque `CONFIG` al principio de
`assets/js/veta.js`:

| Constante | Para qué | Estado |
|---|---|---|
| `META_PIXEL_ID` | Píxel de Meta | vacío = no se carga nada |
| `GA_MEASUREMENT_ID` | Google Analytics 4 | vacío = no se carga nada |
| `WHATSAPP` | Número comercial, formato `569XXXXXXXX` | configurado |
| `LEAD_ENDPOINT` | Edge Function `nuevo-lead` | ya apunta al proyecto de Supabase |

> Si se activa el píxel o Analytics hay que actualizar el párrafo de cookies de
> `privacidad.html` **antes** de publicar: hoy declara que no se carga ninguno.

### Eventos de medición

`assets/js/veta.js` expone `window.veta.track(nombre, params)` y empuja todo a
`window.dataLayer` (y a `gtag`/`fbq` si están). Los clicks se declaran en el
HTML con `data-ev="…"` y las secciones vistas con `data-view-ev="…"`, así que se
agregan sin tocar el JS.

Eventos en uso: `click_diagnostico`, `form_start`, `form_submit`,
`click_whatsapp`, `view_pricing`, `view_project`, `click_shopify`,
`click_meta_ads`.

## Entrada de leads

| Vía | Función | `leads.origen` |
|---|---|---|
| Formulario del sitio | Edge Function `nuevo-lead` | queda en blanco |
| Formularios de Meta (Facebook/Instagram) | Edge Function `meta-lead` | `meta_lead_ads` |

El formulario de diagnóstico pregunta más cosas que las siete que acepta
`nuevo-lead`. El mapeo está documentado en `assets/js/veta.js`: la necesidad
declarada viaja en `negocio` (es lo que titula la oportunidad en el CRM) y el
resto de las respuestas —Instagram, canales de venta, presupuesto— se pliegan
dentro de `mensaje`, que es texto libre y llega completo al correo y al CRM.
**No hubo que tocar la Edge Function.**

`api/lead-form.js` hace lo mismo por otra vía y quedó sin conectar: si se
activa, hay que apagar uno de los dos o cada lead entra duplicado.

### Meta Lead Ads

Guía completa —variables, pasos en Meta, pruebas, diagnóstico y cómo revocar—:
**[docs/meta-lead-ads-integration.md](docs/meta-lead-ads-integration.md)**.

En corto:

- Endpoint: `https://rayvimywyqjnzzmbagpv.supabase.co/functions/v1/meta-lead`
  (`GET` para la verificación de Meta, `POST` para los eventos `leadgen`).
- Secretos en Supabase → Edge Functions → Secrets:
  `META_WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, `META_PAGE_ACCESS_TOKEN` y,
  opcional, `META_GRAPH_API_VERSION`. Los nombres están en `.env.example`.
- Valida la firma `X-Hub-Signature-256` y procesa de forma **síncrona**: el `200`
  sale recién cuando el lead está guardado.
- No duplica: reclamo atómico (`reclamar_meta_lead`) más el único de
  `leads (origen, origen_id)`.

Permiso **`leads_retrieval`**: funciona de inmediato para administradores de la
app, pero requiere **revisión de Meta** para operar en producción.

### Código de las Edge Functions

`supabase/functions/meta-lead/` es la única función cuyo código está versionado
acá. Las demás (`nuevo-lead`, `email-evento`, `recordatorio-diario`,
`importar-empresas`) viven **solo** en Supabase.

Pruebas, lint y typecheck de las funciones (necesita [Deno](https://deno.com)):

```bash
deno task verify
```

## Imágenes

**No queda ningún placeholder de contenido en el sitio.** Los dos comentarios
`PLACEHOLDER` que siguen en el HTML son instrucciones para trabajo futuro (sumar
gente al equipo en `nosotros.html`, sumar un proyecto en `proyectos/index.html`),
no contenido faltante. Para revisarlos:

```bash
grep -rn "PLACEHOLDER" *.html proyectos/*.html
```

Cuando falte una imagen de verdad, marcarla con la clase `.placeholder` y un
comentario `PLACEHOLDER`: se ve en pantalla a propósito, para que no se escape a
producción. Nunca rellenar con una imagen que no corresponda.

Todas las imágenes viven en `assets/img/` en `.webp`, y van siempre con `width`,
`height`, `alt` y `loading="lazy"`.

| Archivo | Qué es |
|---|---|
| `pecadoras-tienda-{portada,catalogo,ficha}.webp` | La tienda en Shopify, sacadas de una grabación de pantalla |
| `pecadoras-instagram-{antes,ahora}.webp` | El perfil de Instagram antes y después |
| `checkyourcars-{inicio,panel,comparacion}.webp` | checkyourcars.cl en producción |

Dos cosas que hay que mantener si alguna se reemplaza:

> **El panel de CheckYourCars** es el mockup de demostración del propio sitio,
> rotulado «Automotora Ejemplo». Sus cifras son de ejemplo y el pie de foto lo
> dice: no son resultados de una automotora real ni de Veta Labs.

> **La captura del «antes» de Instagram** tiene una costura: se quitó la franja
> «Followed by <usuario>», que mostraba el nombre y la foto de una tercera
> persona. No publicamos la identidad de gente que no dio su permiso.

El antiguo `checkyourcars.png` de la raíz se borró: no era una captura del
producto, sino un mockup con la URL `panel.sebastiangomez.cl` y cifras
inventadas. Sigue en el historial de git.

Para sacar fotogramas de un video hace falta ffmpeg (`npx ffmpeg-static`): el
Chromium de Playwright no decodifica H.264 ni HEVC.

## Blog

Todavía no hay artículos y no se inventaron. Lo que queda listo es la
arquitectura: `blog/_plantilla-articulo.html` es una plantilla con el `<head>`,
el JSON-LD de `Article` y la estructura de contenido resueltos, más la lista de
temas planificados. No se publica (está en `.vercelignore`); las instrucciones
para estrenar el blog están dentro del propio archivo.

## Dominio

El dominio de producción es **`https://vetalabs.cl`**. Es el único host
canónico: cada página declara su `canonical` y su `og:url`, y `vercel.json`
manda un 301 desde `www.vetalabs.cl` y desde las URLs antiguas. Las URLs de
preview (`vetalabs-git-<rama>-….vercel.app`) no se redirigen.

`robots.txt` y `sitemap.xml` declaran ese mismo dominio: indexan las páginas
públicas y dejan fuera `/crm`, `/api/` y la plantilla del blog. El CRM además
lleva `noindex` en su `<head>`.

## Stack

- Frontend: HTML/CSS/JS puro, sin build ni dependencias
- Backend: Supabase (Postgres + Auth + RLS) + una función serverless en `api/`
- Deploy: Vercel, automático en cada push a `main`

## Uso local

Abrir los `.html` directamente funciona, pero los enlaces internos son absolutos
(`/precios`), así que conviene levantar un servidor que imite el `cleanUrls` de
Vercel:

```bash
npx serve .        # o cualquier estático que resuelva /precios -> precios.html
```

El formulario sí funciona en local: postea a la Edge Function de Supabase, que
tiene CORS abierto.

## Tablas en Supabase

- `empresas` — cuentas
- `contactos` — personas de cada empresa
- `leads` — oportunidades en el pipeline
- `campanas` y `tareas` — prospección por campaña
- `actividades` — historial de emails, llamadas, WhatsApp, reuniones y notas
- `meta_leads` — detalle crudo de los leads que entran por Meta Lead Ads

Pipeline: nuevo → contactado → respondió → reunión agendada → propuesta enviada
→ ganado / perdido
