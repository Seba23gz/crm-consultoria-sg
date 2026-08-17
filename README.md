# Veta Labs

Sitio de la consultora y su CRM interno, en un mismo proyecto de Vercel.

> **Dominio en tránsito.** `vetalabs.cl` está comprado en NIC Chile pero todavía
> no delegado. Cuando resuelva, hay que cambiar a `https://vetalabs.cl/` las
> cuatro URLs del `<head>` de `index.html`: `canonical`, `og:url`, `og:image` y
> `twitter:image`. Hoy apuntan a `vetalabs.vercel.app` para que el preview de
> los enlaces siga funcionando.

| Ruta | Qué es | Acceso |
|---|---|---|
| `/` | Sitio público de Veta Labs: servicios, proceso, resultados, proyectos y contacto | público |
| `/crm` | CRM interno: pipeline, campañas, empresas y seguimientos | login Supabase |
| `/api/lead-form` | Endpoint alternativo para recibir leads (hoy sin uso) | público (POST) |

El CRM no se enlaza desde el sitio a propósito: se entra por la URL directa y
queda detrás del login de Supabase.

El sitio venía del proyecto `sebastian-gomez` (repo `Seba23gz/Sebastian-Gomez`),
que se fusionó acá para tener todo en un solo proyecto de Vercel.

## Entrada de leads

Hay dos vías:

| Vía | Función | `leads.origen` |
|---|---|---|
| Formulario del sitio | Edge Function `nuevo-lead` | queda en blanco |
| Formularios de Meta (Facebook/Instagram) | Edge Function `meta-lead` | `meta_lead_ads` |

`api/lead-form.js` hace lo mismo que `nuevo-lead` por otra vía y quedó sin
conectar: si se activa, hay que apagar uno de los dos o cada lead entra duplicado.

### Meta Lead Ads

Los formularios instantáneos de Facebook e Instagram entran solos al CRM. Meta
**no** manda los datos en el webhook: manda un `leadgen_id` y la función va a
buscarlos a Graph API con el token de la página.

Guía completa —variables, pasos en Meta, pruebas, diagnóstico y cómo revocar—:
**[docs/meta-lead-ads-integration.md](docs/meta-lead-ads-integration.md)**.

En corto:

- Endpoint: `https://rayvimywyqjnzzmbagpv.supabase.co/functions/v1/meta-lead`
  (`GET` para la verificación de Meta, `POST` para los eventos `leadgen`).
- Secretos en Supabase → Edge Functions → Secrets:
  `META_WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, `META_PAGE_ACCESS_TOKEN` y,
  opcional, `META_GRAPH_API_VERSION`. Los nombres están en `.env.example`.
- Valida la firma `X-Hub-Signature-256`, responde 200 de inmediato y procesa en
  segundo plano, porque Meta reintenta si tarda.
- No duplica: el índice único sobre `meta_leads.meta_lead_id` se reclama antes de
  hacer nada, y `leads` tiene además su único sobre `(origen, origen_id)`.
- Cada lead deja una fila en `meta_leads` con las respuestas completas del
  formulario, los ids de la pauta y el estado del procesamiento.

Permiso **`leads_retrieval`**: funciona de inmediato para administradores de la
app, pero requiere **revisión de Meta** para operar en producción.

### Código de las Edge Functions

`supabase/functions/meta-lead/` es la única función cuyo código está versionado
acá. Las demás (`nuevo-lead`, `email-evento`, `recordatorio-diario`,
`importar-empresas`) viven **solo** en Supabase: si las vas a tocar, conviene
bajarlas al repo primero.

Pruebas, lint y typecheck de las funciones (necesita [Deno](https://deno.com)):

```bash
deno task verify
```

### Píxel de Meta
El ID va en la constante `window.META_PIXEL_ID` de `index.html`. Mientras esté
vacía no se carga el script ni se envía nada a Meta. Con el ID puesto, dispara
`PageView` al cargar y `Lead` cuando el formulario se envía con éxito.

## Stack
- Frontend: HTML/CSS/JS puro (sin build)
- Backend: Supabase (Postgres + Auth + RLS) + una función serverless en `api/`
- Deploy: Vercel, automático en cada push a `main`

## Estructura del pipeline
nuevo → contactado → respondió → reunión agendada → propuesta enviada → ganado / perdido

## Tablas en Supabase
- `empresas` — cuentas (inmobiliarias, constructoras, etc.)
- `contactos` — personas de cada empresa
- `leads` — oportunidades en el pipeline
- `campanas` y `tareas` — prospección por campaña
- `actividades` — historial de emails, llamadas, WhatsApp, reuniones y notas
- `meta_leads` — detalle crudo de los leads que entran por Meta Lead Ads

## Configuración
Las credenciales de Supabase están en `crm/index.html` (constantes `SUPABASE_URL` y
`SUPABASE_ANON_KEY`). La clave anon es pública por diseño; la seguridad la da Row
Level Security activo en las tablas.

El endpoint `/api/lead-form` necesita variables de entorno en Vercel, que **no** van
en el repo (es público):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY` y `CRM_OWNER_EMAIL` — opcionales, para el aviso por correo
- `FROM_EMAIL` — opcional

Sin esas variables el formulario de la landing responde error.

## Uso local
Abrir `index.html` o `crm/index.html` en el navegador. Supabase se conecta por
internet. El formulario de contacto no funciona en local: necesita el endpoint
serverless, que solo corre en Vercel.

## Payload del endpoint

```json
{
  "nombre": "Juan Pérez",
  "email": "juan@ejemplo.com",
  "telefono": "+56912345678",
  "empresa": "Mi Empresa",
  "cargo": "Dueño",
  "mensaje": "Quiero cotizar"
}
```

Cuando llega, se crea o registra el contacto y queda en etapa `contactado`.
