# Veta Labs

Sitio público de la agencia y su CRM interno, en un mismo proyecto de Vercel.

Veta Labs es una **agencia de e-commerce y crecimiento digital**: su producto
principal son tiendas online para negocios que ya venden por Instagram y
WhatsApp. **Shopify es la plataforma recomendada por defecto**; también se
construye en Tiendanube y WooCommerce, al mismo precio, cuando el caso lo pide. El sitio está construido alrededor de un solo objetivo de
conversión: **solicitar un diagnóstico gratuito**.

## Estructura del sitio

HTML plano, sin build. Vercel sirve la raíz tal cual, con `cleanUrls: true`
(`precios.html` se publica como `/precios`).

| Ruta | Archivo | Qué es |
|---|---|---|
| `/` | `index.html` | Home: problema → solución → Shopify → método → proyectos → proceso → precios → FAQ → formulario |
| `/tiendas-online` | `tiendas-online.html` | Servicio principal: Shopify (recomendado), Tiendanube y WooCommerce |
| `/paginas-web` | `paginas-web.html` | Landing pages, web corporativa y proyectos a medida |
| `/cro` | `cro.html` | Optimización de conversión, también para tiendas de terceros |
| `/precios#servicios-aparte` | dentro de `precios.html` | Servicios que se cotizan aparte: identidad de marca, Meta Ads, CRO y consultoría |
| `/proyectos` | `proyectos/index.html` | Índice de casos |
| `/proyectos/<slug>` | `proyectos/<slug>.html` | Caso: contexto / problema / solución / resultado |
| `/precios` | `precios.html` | Planes, tabla comparativa, servicios aparte y FAQ completo |
| `/blog` | `blog/index.html` | Índice de artículos |
| `/blog/<slug>` | `blog/<slug>.html` | Artículo |
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

## SEO

Cada página persigue una consulta concreta, y una sola: el `<title>` empieza por
lo que la persona escribe en Google, no por el nombre de la sección.

| Ruta | Consulta principal |
|---|---|
| `/` | agencia Shopify Chile |
| `/tiendas-online` | crear una tienda online en Shopify |
| `/paginas-web` | páginas web y landing pages Chile |
| `/cro` | mi tienda tiene visitas y no vende |
| `/precios` | cuánto cuesta una tienda online en Chile |
| `/proyectos` | proyectos de tiendas online en Shopify |

Lo que hay que respetar al tocar una página:

- **Un `<h1>` por página** y sin saltos de nivel (`h2` no puede seguir a un `h4`).
- **`<title>` ≤ 62 caracteres** y **`meta description` entre 70 y 175**: más largo
  y Google lo corta, más corto y lo reescribe.
- `canonical`, `og:url` y la entrada del `sitemap.xml` apuntan al mismo `https://vetalabs.cl/…`.
- `lang="es-CL"` y `og:locale` `es_CL`. El sitio es para Chile y lo declara.
- Cada `<img>` con `alt` que describa lo que se ve, `width`, `height` y `loading="lazy"`.
- JSON-LD por página: `Service` + `FAQPage` en servicios, `CreativeWork` en casos,
  `Article` en artículos, `BreadcrumbList` en todo lo que no sea la home.
- Al agregar una página: sumarla al `sitemap.xml` **con su `lastmod`**.

Nada de esto es opcional para páginas nuevas, y hay un script que lo comprueba
—títulos, descripciones, encabezados, JSON-LD válido, enlaces internos rotos y
desbordes horizontales— descrito más abajo en «Comprobar antes de publicar».

## Configuración rápida

Todo lo que hay que encender vive en el bloque `CONFIG` al principio de
`assets/js/veta.js`:

| Constante | Para qué | Estado |
|---|---|---|
| `META_PIXEL_ID` | Píxel de Meta, sin pasar por GTM | vacío, y así debe quedarse |
| `GA_MEASUREMENT_ID` | Google Analytics 4, sin pasar por GTM | vacío, y así debe quedarse |
| `WHATSAPP` | Número comercial, formato `569XXXXXXXX` | configurado |
| `LEAD_ENDPOINT` | Edge Function `nuevo-lead` | ya apunta al proyecto de Supabase |

### Medición

El sitio carga **Google Tag Manager** (contenedor `GTM-TS67GQTV`) en el `<head>`
de las dieciséis páginas públicas, con el `<noscript>` justo después de
`<body>`. **El CRM queda fuera a propósito**: es interno, lleva `noindex` y medir
las visitas del propio dueño ensucia los datos del sitio comercial.

Analytics y el píxel de Meta se configuran **dentro de GTM**, no en `veta.js`.
Las dos constantes de la tabla son la vía alternativa —cargar cada herramienta
directamente— y tienen que quedarse vacías mientras GTM esté puesto: si se llena
una y esa misma herramienta ya está en el contenedor, cada visita se cuenta dos
veces y nada avisa.

> **Antes de sumar o quitar una herramienta dentro del contenedor**, actualizar
> la sección «Medición y cookies» de `privacidad.html`, que describe lo que el
> sitio carga de verdad. Con el píxel de Meta hay además una frase que corregir:
> la página declara hoy que no hacemos publicidad dirigida, y el píxel la
> habilita. Y hay que **subir la versión del consentimiento** (ver abajo): lo que
> la gente aceptó no se extiende a una herramienta que entonces no existía.

### Consentimiento (Ley 21.719)

La ley chilena de datos personales entra en vigencia el **1 de diciembre de
2026** y exige consentimiento **previo, informado y revocable** para la
medición. El sitio lo resuelve con Google Consent Mode v2:

1. Un script inline en el `<head>`, **antes** del snippet de GTM, declara
   `consent default` con todo **denegado** (`analytics_storage`, `ad_storage`,
   `ad_user_data`, `ad_personalization`, `personalization_storage`).
   GTM carga igual —necesita las señales— pero sus etiquetas quedan bloqueadas.
2. El banner `[data-consent]` pregunta. **Rechazar es un botón del mismo tamaño
   que Aceptar**, en el mismo lugar: si rechazar cuesta más que aceptar, el
   consentimiento no es libre y la ley no lo reconoce.
3. La respuesta se guarda en `localStorage` bajo `veta_consent_v1`, con su fecha,
   y se manda un `consent update` en el momento: si aceptó, las etiquetas se
   activan sin recargar.
4. «Preferencias de cookies», en el pie de todas las páginas, reabre el banner.
   Retirar el permiso tiene que ser tan fácil como darlo.

**Al sumar una herramienta al contenedor, subir la clave a `veta_consent_v2`**
(en `assets/js/veta.js` y en el script del `<head>` de las dieciséis páginas).
Eso invalida los consentimientos anteriores y vuelve a preguntar, que es lo
correcto: la persona aceptó otra cosa.

El orden del `<head>` no es decorativo: si el `consent default` corriera después
del snippet de GTM, el contenedor ya habría disparado sus etiquetas sin permiso.
`scripts/seo-check.mjs` no cubre esto; lo cubre la prueba de consentimiento
descrita en «Comprobar antes de publicar».

### Eventos de medición

`assets/js/veta.js` expone `window.veta.track(nombre, params)` y empuja todo a
`window.dataLayer` (y a `gtag`/`fbq` si están). Los clicks se declaran en el
HTML con `data-ev="…"` y las secciones vistas con `data-view-ev="…"`, así que se
agregan sin tocar el JS.

Eventos en uso: `click_diagnostico`, `form_start`, `form_submit`,
`click_whatsapp`, `view_pricing`, `view_project`, `click_shopify`,
`click_meta_ads`, `click_identidad`.

## Entrada de leads

| Vía | Función | `leads.origen` |
|---|---|---|
| Formulario del sitio | Edge Function `nuevo-lead` | `web` |
| Formularios de Meta (Facebook/Instagram) | Edge Function `meta-lead` | `meta_lead_ads` |

Cada pregunta del formulario de diagnóstico tiene su propia columna en `leads`,
así que en el CRM se puede filtrar y ordenar por ellas:

| Pregunta del formulario | Campo que viaja | Columna en `leads` |
|---|---|---|
| ¿Qué necesitas? | `negocio` y `necesidad` | `necesidad` (y titula la oportunidad) |
| Instagram o sitio web | `sitio` | `sitio` (y `empresas.sitio_web` si la empresa es nueva) |
| ¿Dónde vendes hoy? | `canales` (arreglo) | `canales` (`text[]`) |
| Presupuesto aproximado | `presupuesto` | `presupuesto` |
| ¿Algo más que debamos saber? | `mensaje` | `notas` |

Antes iban todas plegadas dentro de `mensaje` como texto libre: se leían bien en
el correo, pero en el CRM no se podía consultar nada. La migración que las separa
es `supabase/migrations/20260824210000_leads_campos_formulario.sql`.

`nuevo-lead` sigue aceptando el formato anterior (todo dentro de `mensaje`, sin
los campos nuevos): son opcionales a propósito, para que el sitio publicado pueda
ir una versión atrás sin que se caiga la entrada de leads.

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

`supabase/functions/meta-lead/` y `supabase/functions/nuevo-lead/` están
versionadas acá. Las demás (`email-evento`, `recordatorio-diario`,
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

Existe para captar búsquedas que las páginas de servicio no atienden: dudas que
se resuelven antes de contratar. Cada artículo enlaza a la página de servicio
que le corresponde, y esa página enlaza de vuelta.

| Ruta | Consulta que persigue |
|---|---|
| `/blog/dejar-de-vender-solo-por-instagram` | «cómo dejar de vender por Instagram», «pasar de Instagram a tienda online» |
| `/blog/que-necesitas-para-abrir-una-tienda-online` | «qué necesito para abrir una tienda online», «abrir tienda online Chile» |

`blog/_plantilla-articulo.html` es la plantilla —`<head>`, JSON-LD de `Article`
y estructura resueltos— y **no se publica** (está en `.vercelignore` y
`robots.txt` bloquea `/blog/_`). Las instrucciones para estrenar un artículo
están dentro del propio archivo, junto con los temas que quedan pendientes.

**Regla al escribir**: un artículo por consulta, sin refritos. Si un tema ya lo
cubre una página de servicio, se enlaza y no se reescribe: dos páginas
persiguiendo la misma búsqueda compiten entre ellas. Por eso «cuánto cuesta una
tienda online» vive en `/precios` y no en un artículo.

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

## Comprobar antes de publicar

```bash
npx playwright install chromium   # una sola vez
node scripts/seo-check.mjs        # SEO y estructura
node scripts/consent-check.mjs    # consentimiento de cookies
```

Levanta un servidor que imita el `cleanUrls` de Vercel, abre las quince páginas
en Chromium a 390&nbsp;px y falla —código 1— si encuentra algo de esto:

- un `<title>` que Google va a cortar o una `meta description` fuera de rango;
- más de un `<h1>`, o un salto de nivel de encabezado;
- `canonical` fuera del dominio, `og:url` que no coincide, o una página que no
  está en el `sitemap.xml`;
- JSON-LD que no parsea, o una página sin ningún JSON-LD;
- imágenes sin `alt` o sin `width`/`height`;
- desborde horizontal en móvil;
- un enlace interno que ya no resuelve.

Al agregar una página hay que sumarla al arreglo `RUTAS` del script.

`consent-check.mjs` recorre el flujo completo del banner en un navegador real:
que la medición arranque denegada y que el `consent default` sea lo primero que
entra al `dataLayer`; que rechazar deje todo denegado y aceptar lo conceda; que
la decisión persista al navegar; que el pie reabra el banner; y que se pueda
decidir con el teclado, sin desbordes en móvil.

Los dos scripts salen con código 1 si algo falla. Si el entorno ya tiene un
Chromium, se le pasa con `CHROMIUM_PATH=/ruta/al/chromium`.

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
