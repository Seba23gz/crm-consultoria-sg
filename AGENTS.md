# Contexto del proyecto — Veta Labs

Este archivo le da contexto a Codex sobre el proyecto y de dónde viene.

## Qué es

Repositorio de **Veta Labs**, la agencia digital de Sebastián Gómez. Contiene dos
cosas que comparten un mismo proyecto de Vercel:

1. **El sitio público** (`/`) — la web comercial de la agencia.
2. **El CRM interno** (`/crm`) — pipeline de clientes, detrás del login de Supabase.

No confundir con **CheckYourCars** ni **CheckYourWeb**: son marcas hermanas del
mismo dueño, productos aparte, y en el sitio aparecen como casos.

**Pecadoras Shoes** sí es cliente: marca de moda de La Serena, tienda en
**Shopify** (`pecadoras-shoes.myshopify.com`), con variantes de color y talla,
Mercado Pago y envío gratis en La Serena y Coquimbo. Es el caso que mejor
representa al cliente que buscamos, y el único con capturas de todo el recorrido.

## Posicionamiento (esto manda sobre todo el copy)

Veta Labs es una **agencia de e-commerce y crecimiento digital**, no un estudio
que "hace páginas web". El producto estrella son **tiendas online en Shopify**.

- **Cliente ideal**: negocios que **ya venden** por Instagram y WhatsApp, con
  producto, clientes y volumen creciente, que dependen demasiado de responder
  mensajes a mano. No es alguien que recién parte.
- **Promesa**: no prometemos "vas a vender más" (hay variables que no
  controlamos). Prometemos mejor conversión, menos trabajo manual, catálogo
  centralizado, compra sin fricción y medición.
- **CTA único en toda la web**: **Diagnóstico gratuito** → `/contacto`.
- **Modelo**: sin mantención obligatoria. Los accesos quedan a nombre del
  cliente y se le capacita para que administre su tienda solo.
- **Servicios**: tiendas online (Shopify), páginas web/landings, CRO,
  identidad de marca y Meta Ads. Los tres últimos **se cotizan aparte y nunca
  van incluidos en un plan de tienda**; viven en `/precios#servicios-aparte`,
  no en la navegación, para no diluir el foco en e-commerce.
  Identidad de marca cubre logo, colores, tipografías y su sistema de
  aplicación (portadas de destacadas, plantillas de publicación, bio). Se sumó
  porque el caso de Pecadoras ya lo mostraba: o se vendía o se sacaba del caso.
  **No ofrecemos Google Ads.** No ofrecemos fotografía ni nada presencial:
  Veta Labs opera 100% online.
- **Precios públicos**: Landing desde $150.000 · Shopify desde $390.000 ·
  Shopify Growth desde $690.000 CLP. Siempre "desde".

### Reglas de contenido que no se rompen

- **Nada inventado**: ni métricas, ni porcentajes, ni testimonios, ni clientes,
  ni logos, ni plazos exactos. Si no hay dato medido, se habla del cambio
  cualitativo y se dice por qué no hay cifras.
- **Nada de lenguaje vacío**: prohibido "impulsamos tu presencia digital",
  "transformamos ideas en experiencias", "al siguiente nivel", "soluciones
  innovadoras". Se explica lo que se hace, en concreto.
- **Tono**: chileno neutro, directo, comercial, sin tecnicismos. El cliente
  compra el resultado, no el stack. No hablar de APIs, IA ni infraestructura.
- **Lo que falta se marca**: clase `.placeholder` + comentario `PLACEHOLDER` en
  el HTML, nunca contenido inventado para rellenar.

## Estado actual

- **Sitio reconstruido** en HTML/CSS/JS puro, sin build, con sistema visual
  compartido en `assets/css/veta.css` y `assets/js/veta.js`. Doce páginas.
- **Desplegado** en Vercel sobre `https://vetalabs.cl`, con `cleanUrls: true`.
- **CRM funcionando** en `/crm` con Supabase Auth + RLS.
- **Meta Lead Ads integrado** por Edge Function (`supabase/functions/meta-lead`).
- **Sin placeholders de contenido**: los casos tienen capturas reales.

La estructura del sitio, el sistema visual, los eventos de medición y el mapeo
del formulario están documentados en **[README.md](README.md)**. Leerlo antes de
tocar el sitio.

## Pendientes conocidos

1. **Medición**: `META_PIXEL_ID` y `GA_MEASUREMENT_ID` vacíos. Al activarlos hay
   que actualizar el párrafo de cookies de `privacidad.html`.
2. **Blog**: sin contenido. La plantilla y los temas están en
   `blog/_plantilla-articulo.html` (no publicado).
3. Mover las credenciales de Supabase de `crm/index.html` a variables de entorno.
   La clave anon es pública por diseño y RLS protege los datos, así que no es
   urgente.

## Supabase

- Proyecto: **CRM-Consultoria-SG** (id: `rayvimywyqjnzzmbagpv`, región us-east-2).
  Conserva el nombre anterior al rebrand; renombrarlo es opcional.
- URL: `https://rayvimywyqjnzzmbagpv.supabase.co`
- La clave anon (pública) está en `crm/index.html`. La clave `service_role` NO
  está acá y no debe exponerse nunca.

### Tablas
`empresas` · `contactos` · `leads` · `campanas` · `tareas` · `actividades` ·
`meta_leads`

### Pipeline (campo `etapa`)
`nuevo` → `contactado` → `respondio` → `reunion_agendada` → `propuesta_enviada`
→ `ganado` / `perdido`

### Edge Functions
`meta-lead` y `nuevo-lead` (la que recibe el formulario del sitio) están
versionadas en el repo. `email-evento`, `recordatorio-diario` e
`importar-empresas` viven **solo** en Supabase: si hay que tocarlas, bajarlas
primero al repo.

**Aviso de leads por correo.** La cuenta de Resend está en modo prueba: sin
dominio verificado, el remitente `onboarding@resend.dev` solo entrega al correo
del dueño de la cuenta. Por eso `NOTIFY_TO` cae por defecto en el Gmail. Para
volver a contacto@vetalabs.cl: verificar vetalabs.cl en resend.com/domains y
poner los secretos `RESEND_FROM` y `NOTIFY_TO` en Supabase. No hay que
redesplegar la función.

`nuevo-lead` acepta: `nombre` (obligatorio), `email`, `telefono`, `empresa`,
`cargo`, `negocio`/`necesidad`, `sitio`, `canales` (arreglo), `presupuesto`,
`mensaje` y `website` (honeypot). Cada pregunta del formulario tiene su columna
en `leads` —`necesidad`, `sitio`, `canales`, `presupuesto`— y `notas` queda para
el texto libre. Los campos nuevos son opcionales a propósito: si el sitio
publicado va una versión atrás y pliega todo dentro de `mensaje`, entra igual.
El mapeo está comentado en `assets/js/veta.js` y en el README.

## Config de Auth (recordatorio)
En Supabase → Authentication → Providers → Email. Si el usuario quiere entrar sin
confirmar correo, desactivar "Confirm email". Es el único usuario del CRM.

## Stack
HTML/CSS/JS puro · Supabase (Postgres + Auth + RLS) · Vercel · Google Fonts.
