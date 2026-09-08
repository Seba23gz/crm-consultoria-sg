# Conectar Google Analytics 4 al sitio

El sitio usa Google Tag Manager (`GTM-TS67GQTV`) y empuja diez eventos a
`dataLayer`. La propiedad de GA4 y las etiquetas ya están activas en producción;
este documento sirve para revisar o reconstruir esa configuración.

`gtm-vetalabs-ga4.json` es esa configuración, lista para importar: la etiqueta
base de GA4 y una etiqueta por cada evento del sitio, con sus parámetros.

## Pasos para reconstruir la configuración

1. **Crear la propiedad.** En [analytics.google.com](https://analytics.google.com),
   propiedad nueva para `vetalabs.cl`: zona horaria de Santiago y moneda CLP.
   Crear un flujo de datos web. Entrega el **ID de medición**, con formato
   `G-XXXXXXXXXX`.

2. **Importar el contenedor.** En GTM → **Administrador → Importar contenedor**:
   - archivo: `gtm-vetalabs-ga4.json`;
   - espacio de trabajo: **uno nuevo**, no el predeterminado;
   - opción: **Combinar** y *conservar* los conflictos.

   > **Nunca elegir «Sobrescribir»**: borra todo lo que el contenedor tenga hoy.
   > Combinar en un espacio de trabajo nuevo deja revertir sin consecuencias.

3. **Poner el ID real.** En **Variables**, abrir `GA4 — Measurement ID` y
   reemplazar `G-XXXXXXXXXX`. Es el único lugar donde hay que cambiarlo: las
   once etiquetas lo leen de ahí: la etiqueta base y diez eventos.

4. **Probar antes de publicar.** Botón **Vista previa**, abrir vetalabs.cl,
   **aceptar** en el banner de cookies y comprobar que las etiquetas se disparan.
   Sin aceptar no deben dispararse: eso también hay que verlo.

5. **Enviar → Publicar.**

6. **Marcar la conversión.** En GA4 → Administrar → Eventos, marcar
   `form_submit` como **evento clave**. Es la solicitud de diagnóstico, que es
   lo único que este sitio cuenta como conversión.

## Lo que queda configurado

| Etiqueta | Se dispara con | Parámetros |
|---|---|---|
| `Google tag - GA4` | todas las páginas | — |
| `GA4 - click_diagnostico` | clic en cualquier CTA | `origen`, `destino` |
| `GA4 - form_start` | la persona empieza a escribir | `formulario` |
| `GA4 - form_submit` | **conversión**: formulario enviado | `formulario`, `necesidad` |
| `GA4 - click_whatsapp` | clic en WhatsApp | `origen`, `destino` |
| `GA4 - view_pricing` | la sección de precios entra en pantalla | `id` |
| `GA4 - view_project` | un caso entra en pantalla | `id` |
| `GA4 - click_shopify` | clic a la tienda de un caso | `origen`, `destino` |
| `GA4 - click_meta_ads` | clic en el servicio de Meta Ads | `origen`, `destino` |
| `GA4 - click_identidad` | clic en identidad de marca | `origen`, `destino` |
| `GA4 - click_web` | clic en páginas web o landings | `origen`, `destino` |

`origen` dice desde qué parte de la página se hizo clic (`hero`, `nav`, `dock`,
`footer`, `cta_final`…), así que se puede saber qué ubicación del CTA convierte.

## Consentimiento

**No hay que configurar una etiqueta adicional.** El sitio usa consentimiento
básico: antes de aceptar no descarga GTM ni hace solicitudes a GA4. Al aceptar,
`analytics_storage` pasa a `granted`, GTM se descarga y las etiquetas pueden
medir; los permisos de publicidad permanecen denegados.

Consecuencia esperada: **GA4 va a mostrar menos visitas que las reales**, porque
quien rechaza no se mide. Es el costo de cumplir la ley, no un error.

## Dos cosas que rompen los datos

- **No llenar `GA_MEASUREMENT_ID` en `assets/js/veta.js`.** Con GA4 dentro del
  contenedor, llenarlo además ahí cuenta cada visita dos veces.
- **Al agregar un evento nuevo al sitio** (`data-ev="…"` en el HTML), agregar
  también su etiqueta acá. `node scripts/gtm-check.mjs` avisa si se desalinean.

## Advertencia sobre este archivo

Está generado y validado estructuralmente —formato de exportación, referencias
entre etiquetas y activadores, ids únicos, eventos alineados con el sitio— pero
**no se pudo probar la importación real**, porque eso requiere la cuenta de GTM.
Por eso el paso 2 insiste en «Combinar» y en un espacio de trabajo nuevo: si algo
sale mal, se descarta el espacio y no pasó nada.
