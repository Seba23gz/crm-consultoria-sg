# Contexto del proyecto — CRM Veta Labs

Este archivo le da contexto a Codex sobre el proyecto y de dónde viene.

## Qué es

CRM propio para Veta Labs, la consultora de Sebastián Gómez: un negocio remoto de
**automatización de procesos, IA y dashboards para PYMEs** (foco inicial en
inmobiliarias y empresas de gestión de espacios de la Región de Coquimbo, Chile).

Este CRM sirve para gestionar el pipeline de clientes de esa consultora
(no confundir con CheckYourCars, que es un producto aparte del mismo dueño).

## Estado actual (lo que YA está hecho)

- **App construida**: `crm/index.html`, una sola página, HTML/CSS/JS puro sin build.
  En la raíz vive `index.html`, la landing pública de Veta Labs; el CRM queda en `/crm`
  y no se enlaza desde ella.
  Login con Supabase Auth + tablero de pipeline por columnas + registro de actividades.
- **Base de datos creada y funcionando** en Supabase.
- **Credenciales ya insertadas** en `crm/index.html` (URL + clave anon pública).
- **Git inicializado** con un commit inicial.
- **RLS activo** en las tres tablas (solo usuarios autenticados acceden).

## Lo que FALTA (tareas para Codex)

1. Crear un repositorio en GitHub y subir este proyecto (`git push`).
2. Desplegar en Vercel conectado a ese repo. Framework = **"Other"**, sin build,
   output = raíz del proyecto.
   - Nota: intentar crear el proyecto vía API falló antes por permisos;
     hacerlo desde la cuenta personal del usuario con `vercel` CLI o el dashboard
     debería funcionar.
3. (Opcional, buena práctica) Mover `SUPABASE_URL` y `SUPABASE_ANON_KEY` desde el
   código a variables de entorno de Vercel. La clave anon es pública por diseño y
   RLS protege los datos, así que no es urgente, pero deja el proyecto más prolijo.

## Supabase

- Proyecto: **CRM-Consultoria-SG** (id: `rayvimywyqjnzzmbagpv`, región us-east-2).
  Conserva el nombre anterior al rebrand a Veta Labs; renombrarlo en Supabase es opcional.
- URL: `https://rayvimywyqjnzzmbagpv.supabase.co`
- La clave anon (pública) está en `crm/index.html`. La clave `service_role` NO está
  aquí y no debe exponerse nunca.

### Tablas
- `empresas` — cuentas (nombre, rubro, ciudad, num_empleados, sitio_web, telefono, notas)
- `contactos` — personas. Campos clave: `empresa_id`, nombre, cargo, email, telefono,
  linkedin_url, `etapa`, prioridad, ultimo_contacto, `proximo_seguimiento`, notas.
- `actividades` — historial (contacto_id, tipo, descripcion, fecha).

### Pipeline (campo `etapa` en contactos)
`nuevo` → `contactado` → `respondio` → `reunion_agendada` → `propuesta_enviada` → `ganado` / `perdido`

### Datos ya cargados
4 contactos reales de inmobiliarias de Coquimbo, en etapa "contactado", con su
primer correo registrado como actividad y próximo seguimiento agendado:
Gabriel Leyton (JG Puerto Velero, prioridad alta), Matías De La Piedra
(Facility Manager, alta), Mariano Torrealba (Terranostra, media), Mauricio Pereira
(Empresas Serena, media).

## Config de Auth (recordatorio)
En Supabase → Authentication → Providers → Email. Si el usuario quiere entrar sin
confirmar correo, desactivar "Confirm email". Es el único usuario del CRM.

## Ideas de mejora pendientes (backlog)
- Arrastrar tarjetas entre columnas (drag & drop) para cambiar de etapa.
- Vista de "seguimientos de hoy / vencidos".
- Conectar el formulario de la web del usuario (https://sebastian-gomez-sigma.vercel.app)
  para que los leads entren solos al CRM.
- Mover credenciales a variables de entorno.

## Stack
HTML/CSS/JS puro · Supabase (Postgres + Auth + RLS) · Vercel · Supabase JS v2 por CDN.
