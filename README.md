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
El formulario del sitio postea a la Edge Function **`nuevo-lead`** de Supabase,
que es el camino en uso. `api/lead-form.js` hace lo mismo por otra vía y quedó
sin conectar: si se activa, hay que apagar uno de los dos o cada lead entra
duplicado.

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
