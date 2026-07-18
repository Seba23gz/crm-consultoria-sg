# CRM · Consultoría SG

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
