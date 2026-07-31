# Veta Labs

Sitio de la consultora y su CRM interno, en un mismo proyecto de Vercel.

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

Hay dos vías, y cada lead queda marcado con su `origen` en la tabla `leads`:

| Vía | Función | Origen |
|---|---|---|
| Formulario del sitio | Edge Function `nuevo-lead` | `web` |
| Formularios de Meta (Facebook/Instagram) | Edge Function `meta-lead` | `meta_ads` |

`api/lead-form.js` hace lo mismo que `nuevo-lead` por otra vía y quedó sin
conectar: si se activa, hay que apagar uno de los dos o cada lead entra duplicado.

### Meta Lead Ads — configuración

Meta **no** manda los datos en el webhook: manda un `leadgen_id` y hay que ir a
buscarlos a la Graph API. Por eso hacen falta tres secretos en Supabase
(Edge Functions → Secrets):

| Secreto | De dónde sale |
|---|---|
| `META_VERIFY_TOKEN` | Lo inventas tú; se pega igual en Meta al crear el webhook |
| `META_APP_SECRET` | App de Meta → Configuración → Básica |
| `META_PAGE_ACCESS_TOKEN` | Token de larga duración de la página (Graph API Explorer) |

Pasos en Meta (developers.facebook.com):

1. Crear una app tipo **Negocio** y agregarle el producto **Webhooks**.
2. Suscribirse al objeto **Page**, campo **`leadgen`**.
3. URL de retrollamada:
   `https://rayvimywyqjnzzmbagpv.supabase.co/functions/v1/meta-lead`
   Token de verificación: el mismo `META_VERIFY_TOKEN`.
4. Conectar la página de Veta Labs a la app y suscribirla al webhook.
5. Permiso **`leads_retrieval`**: funciona de inmediato para administradores de la
   app, pero requiere **revisión de Meta** para operar con la cuenta en producción.

El endpoint valida la firma `X-Hub-Signature-256` (HMAC del cuerpo con el app
secret), responde 200 de inmediato y procesa en segundo plano, porque Meta
reintenta si tarda. Los reintentos no duplican: hay un índice único sobre
`(origen, origen_id)`.

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
