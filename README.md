# CRM · Veta Labs

Mini-CRM para gestionar el pipeline de clientes de automatización e IA.
App de una sola página (HTML + JS) conectada a Supabase (base de datos + login).

## Stack
- Frontend: HTML/CSS/JS puro (sin build)
- Backend: Supabase (Postgres + Auth + RLS)
- Deploy: Vercel (o cualquier hosting estático)

## Estructura del pipeline
nuevo → contactado → respondió → reunión agendada → propuesta enviada → ganado / perdido

## Tablas en Supabase
- `empresas` — cuentas (inmobiliarias, etc.)
- `contactos` — personas, con etapa, prioridad y próximo seguimiento
- `actividades` — historial de emails, llamadas, WhatsApp, reuniones y notas

## Configuración
Las credenciales de Supabase están en `index.html` (constantes `SUPABASE_URL` y `SUPABASE_ANON_KEY`).
La clave anon es pública por diseño; la seguridad la da Row Level Security (RLS) activo en las tablas.

## Uso local
Abrir `index.html` en el navegador. Supabase se conecta por internet.

## Deploy en Vercel
Importar este repositorio en vercel.com/new. Sin build: framework "Other", output = raíz.

## Integración con tu web
Tu formulario puede enviar los datos al endpoint:

https://TU-APP.vercel.app/api/lead-form

Ejemplo de payload:

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

Cuando llega, el CRM crea o registra el contacto y lo deja en etapa `contactado`. Si configuras `RESEND_API_KEY` y `CRM_OWNER_EMAIL` en Vercel, además te enviará un correo.
